use futures_util::StreamExt;
use std::time::Duration;

const DECAPI_BASE: &str = "https://decapi.me";
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 15_000;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const ALLOWED_ENDPOINTS: &[&str] = &["uptime", "title", "viewercount", "game", "avatar", "id"];

pub struct DecApiClient(reqwest::Client);

impl DecApiClient {
    pub fn new() -> Result<Self, reqwest::Error> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Kappastream/", env!("CARGO_PKG_VERSION")))
            .build()
            .map(Self)
    }
}

fn is_valid_endpoint(endpoint: &str) -> bool {
    ALLOWED_ENDPOINTS.contains(&endpoint)
}

fn is_valid_channel_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 25
        && name
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

#[tauri::command]
pub async fn decapi_fetch(
    client: tauri::State<'_, DecApiClient>,
    path: String,
    timeout_ms: u64,
) -> Result<String, String> {
    if path.len() > 64 {
        return Err("invalid path".to_string());
    }
    let parts: Vec<&str> = path.rsplitn(3, '/').collect();
    if parts.len() != 3 || parts[2] != "twitch" {
        return Err(format!("invalid path: {path}"));
    }
    let endpoint = parts[1];
    let channel = parts[0];
    if !is_valid_endpoint(endpoint) {
        return Err(format!("endpoint not allowed: {endpoint}"));
    }
    if !is_valid_channel_name(channel) {
        return Err(format!("invalid channel name: {channel}"));
    }

    let url = format!("{DECAPI_BASE}/twitch/{endpoint}/{channel}");
    let response = client
        .0
        .get(url)
        .timeout(Duration::from_millis(
            timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
        ))
        .header("accept", "text/plain")
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

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("body: {error}"))?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("response too large".to_string());
        }
        body.extend_from_slice(&chunk);
    }

    let body = String::from_utf8(body).map_err(|_| "response was not UTF-8".to_string())?;
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("empty response".to_string());
    }
    Ok(trimmed.to_string())
}
