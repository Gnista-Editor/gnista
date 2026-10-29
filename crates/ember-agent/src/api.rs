//! The Claude Messages API, over HTTP with streaming, as the API documents
//! for languages without an official SDK.
//!
//! A [`Model`] takes a request body and streams the response's events back
//! over a channel, from a thread of its own, so the editor never waits on
//! the network. [`Anthropic`] is the real one; tests use a scripted model.

use std::io::{BufRead, BufReader};
use std::sync::mpsc::{Receiver, Sender, channel};

use serde_json::{Value, json};

/// The API version these requests are written for.
const API_VERSION: &str = "2026-10-21";
/// Server-side fallback when a safety classifier declines a request.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// Where the key lives in the system keychain.
pub const KEYCHAIN_SERVICE: &str = "ember";
pub const KEYCHAIN_ACCOUNT: &str = "anthropic-api-key";

/// What comes back from a request: the stream's events, each its `data`
/// object, or an error that ends it.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Data(Value),
    Error(String),
}

/// Something that answers a Messages request with a stream of events.
pub trait Model {
    fn send(&self, body: Value) -> Receiver<Event>;
}

/// The settings a request is built from.
pub struct Settings {
    pub model: String,
    pub effort: String,
    pub max_tokens: u64,
}

/// The body of a streamed Messages request: the system prompt and tools
/// first and unchanging, so the prompt cache holds them, then the
/// conversation. Thinking is left to the model's adaptive default.
pub fn request_body(settings: &Settings, system: &str, tools: &Value, messages: &[Value]) -> Value {
    json!({
        "model": settings.model,
        "max_tokens": settings.max_tokens,
        "stream": true,
        "system": system,
        "tools": tools,
        "messages": messages,
        "output_config": { "effort": settings.effort },
        "cache_control": { "type": "ephemeral" },
        "fallbacks": "default",
    })
}

/// The API key: `ANTHROPIC_API_KEY`, else the system keychain.
pub fn api_key() -> Result<String, String> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY")
        && !key.is_empty()
    {
        return Ok(key);
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .and_then(|entry| entry.get_password())
        .map_err(|_| {
            format!(
                "No API key. Set ANTHROPIC_API_KEY, or keep it in the keychain as service {KEYCHAIN_SERVICE:?}, \
                 account {KEYCHAIN_ACCOUNT:?}. On macOS: =security add-generic-password -s {KEYCHAIN_SERVICE} -a {KEYCHAIN_ACCOUNT} -w=."
            )
        })
}

/// The Claude API.
pub struct Anthropic {
    pub url: String,
}

impl Default for Anthropic {
    fn default() -> Anthropic {
        Anthropic { url: "https://api.anthropic.com/v1/messages".into() }
    }
}

impl Model for Anthropic {
    fn send(&self, body: Value) -> Receiver<Event> {
        let (tx, rx) = channel();
        let url = self.url.clone();
        std::thread::spawn(move || {
            if let Err(e) = stream(&url, &body, &tx) {
                let _ = tx.send(Event::Error(e));
            }
        });
        rx
    }
}

/// Sends the request and passes each event of the response on, until the
/// stream ends or the receiver is dropped.
fn stream(url: &str, body: &Value, tx: &Sender<Event>) -> Result<(), String> {
    let key = api_key()?;
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    let response = agent
        .post(url)
        .header("x-api-key", &key)
        .header("anthropic-version", API_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .send_json(body)
        .map_err(|e| format!("Could not reach the API: {e}"))?;
    let status = response.status().as_u16();
    let mut body = response.into_body();
    if status != 200 {
        let text = body.read_to_string().unwrap_or_default();
        return Err(api_error(status, &text));
    }
    for event in parse_sse(BufReader::new(body.into_reader())) {
        if tx.send(event).is_err() {
            break;
        }
    }
    Ok(())
}

/// An error response as a sentence: the API's own message if it sent one.
fn api_error(status: u16, text: &str) -> String {
    let message = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| text.trim().to_string());
    format!("The API answered {status}: {message}")
}

/// Server-sent events: each `data:` line's JSON, in order. An `error`
/// event becomes [`Event::Error`]; `ping`s are dropped.
pub fn parse_sse(reader: impl BufRead) -> impl Iterator<Item = Event> {
    reader.lines().map_while(Result::ok).filter_map(|line| {
        let data = line.strip_prefix("data:")?.trim();
        let value: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(e) => return Some(Event::Error(format!("Unreadable event from the API: {e}"))),
        };
        match value.get("type").and_then(Value::as_str) {
            Some("ping") => None,
            Some("error") => {
                let message = value.pointer("/error/message").and_then(Value::as_str).unwrap_or("unknown error");
                Some(Event::Error(format!("The API reported an error: {message}")))
            }
            _ => Some(Event::Data(value)),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_events_are_parsed_in_order() {
        let stream = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\"}}\n\n\
            event: ping\ndata: {\"type\":\"ping\"}\n\n\
            event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n\
            event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
        let events: Vec<Event> = parse_sse(stream.as_bytes()).collect();
        assert_eq!(events.len(), 3);
        assert_eq!(events[1], Event::Data(json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}})));
        assert_eq!(events[2], Event::Error("The API reported an error: Overloaded".into()));
    }

    #[test]
    fn requests_cache_and_fall_back() {
        let settings = Settings { model: "claude-opus-5-5".into(), effort: "medium".into(), max_tokens: 64000 };
        let body = request_body(&settings, "system", &json!([]), &[json!({"role": "user", "content": "hi"})]);
        assert_eq!(body["model"], "claude-opus-5-5");
        assert_eq!(body["stream"], true);
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["cache_control"]["type"], "ephemeral");
        assert_eq!(body["output_config"]["effort"], "medium");
        assert!(body.get("temperature").is_none() && body.get("thinking").is_none());
    }

    #[test]
    fn error_responses_say_what_the_api_said() {
        let text = r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#;
        assert_eq!(api_error(401, text), "The API answered 401: invalid x-api-key");
    }
}
