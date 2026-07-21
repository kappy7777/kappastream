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

// User-Agent for the GQL transport. gql.twitch.tv is Twitch's unofficial
// internal endpoint (the web client's own pipe), and an app-identifying UA
// such as "Kappastream/<ver>" is a single-rule block target — one server-side
// filter on that string would disable every kappastream install at once. A
// generic Chrome-on-Linux UA is unremarkable among the millions of identical
// requests the endpoint already sees.
//
// Chrome 150 is current stable on Linux desktop as of July 2026. The
// ".0.0.0" minor is correct and deliberate: real Chrome has reported a zeroed
// minor version since UA-client-hint reduction, so no build/patch number is
// needed and this string does not go stale the way a full version would. The
// major version is worth bumping occasionally when it falls far behind.
//
// Do NOT add Sec-CH-UA / sec-ch-ua-* client-hint headers. reqwest sending a
// Chrome UA with no client hints is unremarkable; hints that disagree with the
// UA string are a *worse* fingerprint than none (a real Chrome always sends
// matching hints, so the mismatch flags us as an impostor).
//
// NOTE the asymmetry with decapi.rs, which keeps the honest "Kappastream/<ver>"
// UA on purpose: DecAPI is a small donation-funded service we depend on as a
// guest, and identifying ourselves there is correct. Do not "harmonize" them.
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

pub struct GqlClient(reqwest::Client);

impl GqlClient {
    pub fn new() -> Result<Self, reqwest::Error> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(USER_AGENT)
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

#[cfg(test)]
mod tests {
    use super::USER_AGENT;

    // Guard against a future cleanup pass reverting the GQL User-Agent to an
    // app-identifying string. gql.twitch.tv is Twitch's unofficial internal
    // endpoint, and a "Kappastream/..." UA is a single-rule block target —
    // one filter on it disables every install at once. See the USER_AGENT
    // rationale above. (decapi.rs intentionally keeps the honest UA.)
    #[test]
    fn gql_user_agent_is_not_app_identifying() {
        assert!(
            !USER_AGENT.contains("Kappastream"),
            "GQL User-Agent must not identify the app (single-rule block target); got: {USER_AGENT}"
        );
        assert!(
            USER_AGENT.contains("Mozilla/5.0"),
            "GQL User-Agent must look like a browser; got: {USER_AGENT}"
        );
    }

    // The "\\<newline>" line-continuation in the const strips the newline +
    // leading whitespace, so the real value must keep a space between the
    // platform token and AppleWebKit (a real Chrome UA does). Catches an
    // accidental edit that breaks the spacing.
    #[test]
    fn gql_user_agent_internal_spacing_is_intact() {
        assert!(
            USER_AGENT.contains("Linux x86_64) AppleWebKit/537.36"),
            "GQL User-Agent lost its inter-token spacing; got: {USER_AGENT}"
        );
    }
}
