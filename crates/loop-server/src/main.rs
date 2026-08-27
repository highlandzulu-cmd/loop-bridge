//! HTTP/SSE bridge between a web frontend (e.g. pi-web-ui) and Loop's
//! `AgentHarness`. This process does no thinking of its own: it boots a real
//! harness the same way `loop-cli` does, then translates the harness's
//! internal `AgentEvent` stream into JSON events pushed to the browser over
//! Server-Sent Events.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::stream::Stream;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;

use loop_agent::harness::AgentHarness;
use loop_agent::AgentEvent;
use loop_ai::providers::{faux_provider, FauxResponse, FauxScript};
use loop_cli::runtime::{bootstrap, BootstrapOpts};
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
struct AppState {
    harness: Arc<AgentHarness>,
}

#[derive(serde::Deserialize)]
struct PromptRequest {
    text: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    // Which provider/model to run against. Defaults to whatever is already
    // configured in ~/.loop/agent/settings.json (Soket by default). Override
    // with LOOP_SERVER_PROVIDER / LOOP_SERVER_MODEL to point at a keyless
    // local provider (e.g. a custom "ollama" entry in ~/.loop/agent/models.json)
    // or the built-in faux provider for wiring tests.
    let provider = std::env::var("LOOP_SERVER_PROVIDER").ok();
    let model = std::env::var("LOOP_SERVER_MODEL").ok();
    let cwd = std::env::current_dir()?;

    tracing::info!("booting AgentHarness (provider={provider:?}, model={model:?}, cwd={cwd:?})");

    // Reuses loop-cli's own bootstrap: auth, models, session store, tools,
    // sandbox. `interactive: false` means it fails fast instead of prompting
    // at a terminal — see LOOP_API_KEY note in the README.
    let runtime = bootstrap(BootstrapOpts {
        cwd,
        provider,
        model,
        theme: None,
        system_prompt: None,
        append_system_prompt: None,
        no_context_files: true,
        interactive: false,
        session_id: None,
    })
    .await?;

    // Opt-in offline mode: swap in a scripted, zero-network "faux" model so
    // the whole bridge (harness -> events -> SSE -> browser) can be verified
    // without depending on a real model being reachable. Not for real use.
    if std::env::var("LOOP_SERVER_FAUX").as_deref() == Ok("1") {
        let script = FauxScript::new();
        script.push(FauxResponse::Text(
            "Hello from the faux model. If you can see this, the bridge \
             (Loop harness -> loop-server -> browser) is wired correctly \
             end to end — this reply is scripted, not real inference."
                .into(),
        ));
        runtime.models.set_provider(faux_provider(script));
        let faux_model = runtime
            .models
            .get_model("faux", "faux-model")
            .expect("faux provider registers faux-model");
        runtime.harness.set_model(faux_model).await;
        tracing::warn!("LOOP_SERVER_FAUX=1 — responses are scripted, not real inference");
    }

    tracing::info!(
        "harness ready — session {} — provider {}, model {}",
        runtime.session_id,
        runtime.settings.default_provider,
        runtime.settings.default_model
    );

    let state = AppState {
        harness: runtime.harness,
    };

    // Permissive CORS for local development only: this lets a browser dev
    // server on a different port (e.g. Vite on :5173) call this bridge on
    // :8787. Tighten this (specific origin, no Any) before deploying anywhere
    // this bridge isn't just talking to your own machine.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/prompt", post(prompt_handler))
        .with_state(state)
        .layer(cors);

    let port: u16 = std::env::var("LOOP_SERVER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("loop-server listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "session_id": state.harness.session_id().await,
    }))
}

/// POST /prompt { "text": "..." } -> SSE stream of JSON events.
///
/// NOTE: `AgentHarness::subscribe` has no unsubscribe. Each call to this
/// endpoint registers one more permanent listener for the lifetime of the
/// process, so events from later prompts also get pushed to earlier,
/// long-closed streams (harmless — nothing is reading them — but it's a
/// slow leak). Fine for a demo; revisit before real traffic.
async fn prompt_handler(
    State(state): State<AppState>,
    Json(body): Json<PromptRequest>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = mpsc::unbounded_channel::<serde_json::Value>();

    let tx_events = tx.clone();
    state.harness.subscribe(move |ev: AgentEvent| {
        let tx = tx_events.clone();
        async move {
            let _ = tx.send(agent_event_to_json(&ev));
        }
    });

    let harness = Arc::clone(&state.harness);
    tokio::spawn(async move {
        match harness.prompt(body.text).await {
            Ok(_message) => {
                // Loop's own AgentEvent::AgentEnd should already have gone
                // out via subscribe(); this is a belt-and-suspenders signal
                // for the frontend to close its EventSource.
                let _ = tx.send(serde_json::json!({ "type": "stream_end" }));
            }
            Err(e) => {
                let _ = tx.send(serde_json::json!({ "type": "error", "message": e.to_string() }));
                let _ = tx.send(serde_json::json!({ "type": "stream_end" }));
            }
        }
    });

    let stream = UnboundedReceiverStream::new(rx).map(|value| Ok(Event::default().data(value.to_string())));

    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Translate Loop's internal `AgentEvent` into the JSON shape the frontend
/// adapter expects. `AgentEvent` itself doesn't derive `Serialize`, so this
/// is the one place that knowledge of its shape lives.
fn agent_event_to_json(ev: &AgentEvent) -> serde_json::Value {
    use AgentEvent::*;
    match ev {
        AgentStart => serde_json::json!({ "type": "agent_start" }),
        AgentEnd { messages } => serde_json::json!({
            "type": "agent_end",
            "messages": messages,
        }),
        TurnStart => serde_json::json!({ "type": "turn_start" }),
        TurnEnd {
            message,
            tool_results,
        } => serde_json::json!({
            "type": "turn_end",
            "message": message,
            "tool_results": tool_results,
        }),
        MessageStart { message } => serde_json::json!({
            "type": "message_start",
            "message": message,
        }),
        MessageUpdate {
            assistant_message_event,
            ..
        } => serde_json::to_value(assistant_message_event).unwrap_or_else(|e| {
            serde_json::json!({ "type": "error", "message": format!("serialize failure: {e}") })
        }),
        MessageEnd { message } => serde_json::json!({
            "type": "message_end",
            "message": message,
        }),
        ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
        } => serde_json::json!({
            "type": "tool_execution_start",
            "id": tool_call_id,
            "name": tool_name,
            "args": args,
        }),
        ToolExecutionUpdate {
            tool_call_id,
            tool_name,
            args,
            partial_result,
        } => serde_json::json!({
            "type": "tool_execution_update",
            "id": tool_call_id,
            "name": tool_name,
            "args": args,
            "partial_result": partial_result,
        }),
        ToolExecutionEnd {
            tool_call_id,
            tool_name,
            result,
            is_error,
        } => serde_json::json!({
            "type": "tool_execution_end",
            "id": tool_call_id,
            "name": tool_name,
            "result": result,
            "is_error": is_error,
        }),
    }
}
