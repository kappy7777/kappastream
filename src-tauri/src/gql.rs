use futures_util::StreamExt;
use std::time::Duration;

// Twitch's public anonymous GQL endpoint (same one the web client uses with
// the well-known public Client-ID). The Rust command below is a thin
// CORS-bypassing transport — it POSTs whatever JSON body the JS side builds,
// with the Client-ID pinned here so the (untrusted) webview cannot override
// it, and returns the raw response body for JS to JSON.parse. Mirrors the
// shape/conventions of `decapi.rs` (timeout clamp, streaming body cap,
// string-typed errors).
const GQL_URL: &str = "https://gql.twitch.tv/gql";
const CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 15_000;
// 100 logins resolve to ~23 KB; 256 KB leaves generous headroom for a full
// favorites list (MAX_FAVORITES = 100) while still bounding runaway responses.
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_REQUEST_BYTES: usize = 64 * 1024;

pub struct GqlClient(reqwest::Client);

impl GqlClient {
    pub fn new() -> Result<Self, reqwest::Error> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Kappastream/", env!("CARGO_PKG_VERSION")))
            .build()
            .map(Self)
    }
}

#[tauri::command]
pub async fn gql_fetch(
    client: tauri::State<'_, GqlClient>,
    body: String,
    timeout_ms: u64,
) -> Result<String, String> {
    if body.len() > MAX_REQUEST_BYTES {
        return Err("request too large".to_string());
    }

    let response = client
        .0
        .post(GQL_URL)
        .timeout(Duration::from_millis(
            timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
        ))
        .header("content-type", "application/json")
        .header("accept", "application/json")
        // Client-ID is pinned in Rust (not JS) so the untrusted webview cannot
        // impersonate another app or omit it. Matches the posture that lets
        // `withGlobalTauri:false` stay off.
        .header("client-id", CLIENT_ID)
        .body(body)
        .send()
        .await
        .map_err(|error| format!("request: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("response too large".to_string());
    }

    let mut buf = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("body: {error}"))?;
        if buf.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("response too large".to_string());
        }
        buf.extend_from_slice(&chunk);
    }

    let body = String::from_utf8(buf).map_err(|_| "response was not UTF-8".to_string())?;
    if body.is_empty() {
        return Err("empty response".to_string());
    }
    Ok(body)
}
