//! HTTP/SSE bridge between a web frontend (e.g. pi-web-ui) and Loop's
//! `AgentHarness`. This process does no thinking of its own: it boots a real
//! harness the same way `loop-cli` does, then translates the harness's
//! internal `AgentEvent` stream into JSON events pushed to the browser over
//! Server-Sent Events.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::stream::Stream;
use tokio::sync::broadcast;

use loop_agent::harness::{AgentHarness, AgentHarnessPhase};
use loop_agent::AgentEvent;
use loop_ai::providers::{faux_provider, FauxResponse, FauxScript};
use loop_cli::runtime::{bootstrap, BootstrapOpts};
use tower_http::cors::{Any, CorsLayer};

/// Broadcast capacity: comfortably more than one turn's worth of events
/// (start/text_delta-per-chunk/.../done plus Loop's own lifecycle wrapper
/// events). A slow consumer that falls behind by more than this drops the
/// oldest events (see `RecvError::Lagged` handling below) rather than
/// blocking the harness — never blocking the one shared harness is the
/// property that matters here.
const EVENTS_CHANNEL_CAPACITY: usize = 1024;

#[derive(Clone)]
struct AppState {
    harness: Arc<AgentHarness>,
    /// Every harness event, broadcast to whichever request is currently
    /// listening. There's exactly one `subscribe()` registered on the
    /// harness for the whole process (see `main`) — previously every
    /// `/prompt` call added its own permanent listener directly on the
    /// harness, which never got removed (`AgentHarness::subscribe` has no
    /// unsubscribe) and leaked one closure per request for the life of the
    /// process. Routing through a broadcast channel instead means each
    /// request's listener is a cheap `Receiver` that's cleaned up
    /// automatically when its SSE stream ends or the client disconnects.
    events_tx: broadcast::Sender<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct PromptRequest {
    text: String,
}

/// Minimal `.env` loader — no dependency pulled in for this on purpose, to
/// keep the crate's dependency footprint small for anyone vendoring/forking
/// this bridge. Reads `KEY=VALUE` lines from `.env` in the current directory
/// (blank lines and `#` comments ignored) and sets each as a process env var
/// *unless it's already set* — an explicit `FOO=bar cargo run` on the
/// command line always wins over the file, matching standard dotenv
/// semantics. Missing file is fine (most deployments won't have one — e.g.
/// CI, or a real provider configured via ~/.loop/agent/ instead).
fn load_dotenv() {
    let Ok(contents) = std::fs::read_to_string(".env") else {
        return;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        // Strip one layer of matching quotes, e.g. FOO="bar baz" — plain
        // KEY=VALUE with no quoting works fine without this.
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    load_dotenv();
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

    // Resume the same Loop session across restarts instead of silently
    // starting a fresh (empty-history) one every time the process launches.
    // First run: no file yet, bootstrap creates a new session, we persist
    // its id. Later runs: read the id back and ask bootstrap to resume it.
    // If the referenced session no longer exists in Loop's store (deleted,
    // moved LOOP_CODING_AGENT_DIR, ...), bootstrap fails with a clear error
    // rather than silently discarding history — delete the session file to
    // start over deliberately.
    let session_file = std::env::var("LOOP_SERVER_SESSION_FILE")
        .unwrap_or_else(|_| ".loop-server-session-id".to_string());
    let resume_session_id = std::fs::read_to_string(&session_file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(id) = &resume_session_id {
        tracing::info!("resuming session {id} (from {session_file})");
    } else {
        tracing::info!("no session file at {session_file} yet — starting a new session");
    }

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
        session_id: resume_session_id,
    })
    .await?;

    std::fs::write(&session_file, &runtime.session_id)?;

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

    // One subscription for the life of the process (see AppState::events_tx
    // doc comment for why this replaced a per-request subscribe() call).
    let (events_tx, _) = broadcast::channel::<serde_json::Value>(EVENTS_CHANNEL_CAPACITY);
    let events_tx_sub = events_tx.clone();
    runtime.harness.subscribe(move |ev: AgentEvent| {
        let events_tx = events_tx_sub.clone();
        async move {
            // Err here just means no request is currently listening — not a
            // problem; the harness itself is never blocked by this send.
            let _ = events_tx.send(agent_event_to_json(&ev));
        }
    });

    let state = AppState {
        harness: runtime.harness,
        events_tx,
    };

    // CORS origin defaults to the Vite dev server this bridge was built
    // against. Override with LOOP_SERVER_CORS_ORIGIN for a different
    // frontend origin, or set it to "*" to allow any origin (fine for a
    // throwaway local demo; never do this once this bridge is reachable
    // from anywhere but your own machine — it holds no auth of its own).
    let cors_origin =
        std::env::var("LOOP_SERVER_CORS_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".to_string());
    let cors = if cors_origin == "*" {
        tracing::warn!("LOOP_SERVER_CORS_ORIGIN=* — allowing any origin; fine for a local demo only");
        CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)
    } else {
        let origin: HeaderValue = cors_origin
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid LOOP_SERVER_CORS_ORIGIN {cors_origin:?}: {e}"))?;
        tracing::info!("CORS restricted to origin {cors_origin}");
        CorsLayer::new().allow_origin(origin).allow_methods(Any).allow_headers(Any)
    };

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
/// Rejects with 409 if the harness is already mid-turn, rather than the
/// previous behavior of silently kicking off a call that would fail deep
/// inside the harness (`AgentHarnessError::Busy`) with no clear signal to
/// the caller. `AgentHarness::prompt` calls aren't meant to run concurrently
/// against one harness — this is a fast, explicit check for that instead of
/// finding out via a confusing error mid-stream.
async fn prompt_handler(
    State(state): State<AppState>,
    Json(body): Json<PromptRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (StatusCode, Json<serde_json::Value>)> {
    if state.harness.phase() != AgentHarnessPhase::Idle {
        return Err((
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "harness_busy",
                "message": "Loop is still working on a previous message. Wait for it to finish before sending another.",
            })),
        ));
    }

    // Subscribed *before* spawning the prompt call below: a broadcast
    // Receiver starts buffering from the moment it's created, so this
    // ordering guarantees we can't miss the turn's earliest events to a
    // scheduling race, regardless of when the SSE stream is first polled.
    let mut rx = state.events_tx.subscribe();

    let harness = Arc::clone(&state.harness);
    let events_tx = state.events_tx.clone();
    tokio::spawn(async move {
        match harness.prompt(body.text).await {
            Ok(_message) => {
                // Loop's own AgentEvent::AgentEnd should already have gone
                // out via subscribe(); this is a belt-and-suspenders signal
                // for the frontend to close its EventSource.
                let _ = events_tx.send(serde_json::json!({ "type": "stream_end" }));
            }
            Err(e) => {
                let _ = events_tx.send(serde_json::json!({ "type": "error", "message": e.to_string() }));
                let _ = events_tx.send(serde_json::json!({ "type": "stream_end" }));
            }
        }
    });

    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(value) => {
                    // events_tx is one broadcast channel shared by every
                    // request, so without this check the stream would sit
                    // open forever after its own turn ends, waiting on
                    // events from whatever turn some *other* request starts
                    // next. Close it as soon as this turn's own end fires.
                    let is_end = value.get("type").and_then(|t| t.as_str()) == Some("stream_end");
                    yield Ok(Event::default().data(value.to_string()));
                    if is_end {
                        break;
                    }
                }
                // We fell more than EVENTS_CHANNEL_CAPACITY events behind the
                // harness (would need a very slow consumer + a very chatty
                // turn) — skip the gap and keep going rather than stalling.
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!("SSE consumer lagged, skipped {skipped} events");
                    continue;
                }
                // events_tx dropped — process is shutting down.
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
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
