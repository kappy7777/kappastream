use futures_util::StreamExt;
use std::borrow::Cow;
use std::sync::OnceLock;
use std::time::Duration;

// VOD/clip media on Twitch is served from CloudFront (e.g.
// d2nvs31859zcd8.cloudfront.net) which does NOT send CORS headers.  In the
// Tauri WebView hls.js uses XHR/fetch which is CORS-blocked, so VOD playback
// fails with a networkError.  The live CDN (ttvnw.net) DOES send
// Access-Control-Allow-Origin: * which is why live works without a proxy.
//
// Solution: register a custom URI scheme `ksvod` that proxies HLS requests
// through Rust (reqwest — no browser CORS involved) and adds the missing CORS
// header to the response.  The frontend rewrites the VOD URL from
//   https://d2nvs31859zcd8.cloudfront.net/abc/index-dvr.m3u8
// to
//   ksvod://localhost/d2nvs31859zcd8.cloudfront.net/abc/index-dvr.m3u8
// hls.js loads the manifest via XHR to the ksvod scheme; relative segment URLs
// in the manifest (e.g. "0.mp4") are resolved against the ksvod base URL and
// also go through the proxy automatically.

const PROXY_TIMEOUT: Duration = Duration::from_secs(30);
// Bound only the connect (TCP + TLS handshake) phase, independently of the
// overall request timeout. A hung connection (e.g. a blackholed CDN edge) then
// fails fast instead of holding the handler for the full PROXY_TIMEOUT. The
// overall `.timeout()` still bounds headers + body; with Range support the body
// is a small byte-range segment, so 30 s overall is ample for a progressing
// download. (See finding #12: `.timeout()` alone covers the whole request.)
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

// Upper bound on a single proxied response (manifest or segment). hls.js fetches
// one resource per request; a multi-hour VOD `index-dvr.m3u8` can run to a few
// MB and a full un-ranged .ts resource backing many byte-range segments can be
// tens of MB, so 64 MB is generous for any legitimate payload while still
// bounding memory against a hostile or broken upstream. Mirrors the streaming
// cap in gql.rs (far smaller there because GQL payloads are kilobytes).
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

static PROXY_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn proxy_client() -> &'static reqwest::Client {
    PROXY_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Redirects are disabled on purpose: `reconstruct_https_url`
            // validates only the *initial* URL against the shared VOD allowlist,
            // so following a 302 would let an allowlisted host bounce the fetch
            // to an arbitrary destination and relay the body back to the WebView
            // (with CORS *). A redirect surfaces as its 3xx status instead; if a
            // path genuinely needs one, re-validate each hop via `Policy::custom`
            // rather than re-enabling the default (10-hop) follower.
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(PROXY_CONNECT_TIMEOUT)
            .timeout(PROXY_TIMEOUT)
            .build()
            .expect("failed to build VOD proxy HTTP client")
    })
}

/// Parse the custom-scheme URI (`ksvod://localhost/host/path?q=1`) and
/// reconstruct the original HTTPS URL (`https://host/path?q=1`). Returns
/// `None` if the host extracted from the path is not on the shared VOD
/// allowlist (see `resolve::is_allowed_vod_host`).
fn reconstruct_https_url(raw_uri: &str) -> Option<String> {
    // The path component after "ksvod://localhost/" encodes the original
    // "host/path?query". Strip the prefix, prepend "https://", and validate.
    let rest = raw_uri
        .strip_prefix("ksvod://localhost/")
        .or_else(|| raw_uri.strip_prefix("ksvod://"))?;
    // Guard against double slashes or empty host.
    if rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    let target = format!("https://{rest}");
    let parsed = url::Url::parse(&target).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    if !crate::resolve::is_allowed_vod_host(host) {
        return None;
    }
    Some(target)
}

/// Register the `ksvod` URI scheme protocol on the Tauri builder. Each request
/// is fetched via reqwest (bypassing browser CORS) and returned with
/// `Access-Control-Allow-Origin: *` so hls.js's XHR sees a CORS-permitted
/// response.
pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol("ksvod", |_ctx, request, responder| {
        let raw_uri = request.uri().to_string();
        let target = match reconstruct_https_url(&raw_uri) {
            Some(t) => t,
            None => {
                responder.respond(
                    tauri::http::Response::builder()
                        .status(403u16)
                        .header("access-control-allow-origin", "*")
                        .body(Cow::from(b"host not allowed".to_vec()))
                        .unwrap(),
                );
                return;
            }
        };
        // Forward the Range header so hls.js can fetch byte-range segments from
        // VOD playlists that use #EXT-X-BYTERANGE (Twitch VODs do): without it
        // each byte-range segment would pull the whole backing resource. Clips
        // bypass the proxy entirely (native <video src=https> hits CloudFront
        // directly), so this only matters for the HLS path.
        let range_header = request
            .headers()
            .get("range")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string());
        tauri::async_runtime::spawn(async move {
            let client = proxy_client();
            let mut upstream = client.get(&target);
            if let Some(range) = range_header.as_deref() {
                upstream = upstream.header("range", range);
            }
            let result = upstream.send().await;
            match result {
                Ok(resp) => {
                    let status = resp.status();
                    let content_type = resp
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("application/octet-stream")
                        .to_string();
                    // Forward the ranged-response headers so hls.js sees the
                    // slice bounds (206 + content-range) and knows the resource
                    // is rangeable (accept-ranges).
                    let content_range = resp
                        .headers()
                        .get("content-range")
                        .and_then(|v| v.to_str().ok())
                        .map(String::from);
                    let accept_ranges = resp
                        .headers()
                        .get("accept-ranges")
                        .and_then(|v| v.to_str().ok())
                        .map(String::from);

                    if resp
                        .content_length()
                        .is_some_and(|len| len > MAX_RESPONSE_BYTES as u64)
                    {
                        responder.respond(
                            tauri::http::Response::builder()
                                .status(413u16)
                                .header("access-control-allow-origin", "*")
                                .body(Cow::from(b"response too large".to_vec()))
                                .unwrap(),
                        );
                        return;
                    }

                    // Stream the body with a running cap (saturating_add guards
                    // against overflow) instead of `bytes().await` so neither a
                    // lying Content-Length nor a chunked, unbounded body can grow
                    // memory past MAX_RESPONSE_BYTES.
                    let mut buf = Vec::new();
                    let mut stream = resp.bytes_stream();
                    let mut oversize = false;
                    while let Some(chunk) = stream.next().await {
                        let chunk = match chunk {
                            Ok(c) => c,
                            Err(_) => {
                                // Mid-transfer read failure: surface as 502, not
                                // a 200 with an empty body (see #4 rationale).
                                responder.respond(
                                    tauri::http::Response::builder()
                                        .status(502u16)
                                        .header("access-control-allow-origin", "*")
                                        .body(Cow::from(b"proxy read failed".to_vec()))
                                        .unwrap(),
                                );
                                return;
                            }
                        };
                        if buf.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                            oversize = true;
                            break;
                        }
                        buf.extend_from_slice(&chunk);
                    }
                    if oversize {
                        responder.respond(
                            tauri::http::Response::builder()
                                .status(413u16)
                                .header("access-control-allow-origin", "*")
                                .body(Cow::from(b"response too large".to_vec()))
                                .unwrap(),
                        );
                        return;
                    }

                    let mut builder = tauri::http::Response::builder()
                        .status(status.as_u16())
                        .header("content-type", content_type)
                        .header("access-control-allow-origin", "*");
                    if let Some(cr) = content_range {
                        builder = builder.header("content-range", cr);
                    }
                    if let Some(ar) = accept_ranges {
                        builder = builder.header("accept-ranges", ar);
                    }
                    responder.respond(builder.body(Cow::from(buf)).unwrap());
                }
                Err(_) => {
                    responder.respond(
                        tauri::http::Response::builder()
                            .status(502u16)
                            .header("access-control-allow-origin", "*")
                            .body(Cow::from(b"proxy fetch failed".to_vec()))
                            .unwrap(),
                    );
                }
            }
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconstruct_cloudfront_manifest() {
        let url = reconstruct_https_url(
            "ksvod://localhost/d2nvs31859zcd8.cloudfront.net/abc/index-dvr.m3u8",
        );
        assert_eq!(
            url.as_deref(),
            Some("https://d2nvs31859zcd8.cloudfront.net/abc/index-dvr.m3u8")
        );
    }

    #[test]
    fn reconstruct_with_query() {
        let url = reconstruct_https_url(
            "ksvod://localhost/d1ndex63qxojbr.cloudfront.net/v/foo.mp4?token=abc&sig=def",
        );
        assert_eq!(
            url.as_deref(),
            Some("https://d1ndex63qxojbr.cloudfront.net/v/foo.mp4?token=abc&sig=def")
        );
    }

    #[test]
    fn reconstruct_ttvnw_host() {
        let url = reconstruct_https_url(
            "ksvod://localhost/euc13.playlist.ttvnw.net/v1/playlist/abc.m3u8",
        );
        assert!(url.is_some());
    }

    #[test]
    fn reconstruct_rejects_non_allowlisted_host() {
        assert_eq!(
            reconstruct_https_url("ksvod://localhost/evil.example.net/steal"),
            None
        );
        // "notcloudfront.net" is a suffix-match trap — must be rejected.
        assert_eq!(
            reconstruct_https_url("ksvod://localhost/notcloudfront.net/x"),
            None
        );
    }

    #[test]
    fn reconstruct_rejects_empty_and_malformed() {
        assert_eq!(reconstruct_https_url("ksvod://localhost/"), None);
        assert_eq!(reconstruct_https_url("ksvod://localhost//double"), None);
        assert_eq!(reconstruct_https_url("not-even-ksvod"), None);
    }
}
