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

static PROXY_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn proxy_client() -> &'static reqwest::Client {
    PROXY_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(PROXY_TIMEOUT)
            .build()
            .expect("failed to build VOD proxy HTTP client")
    })
}

/// Only Twitch media CDNs are proxied — the handler refuses anything else so
/// it can never be abused as a general-purpose open proxy. Mirrors the VOD
/// host allowlist in resolve.rs.
fn is_allowed_media_host(host: &str) -> bool {
    host == "cloudfront.net"
        || host.ends_with(".cloudfront.net")
        || host == "ttvnw.net"
        || host.ends_with(".ttvnw.net")
        || host == "ttv-clips.net"
        || host.ends_with(".ttv-clips.net")
        || host == "twitch.tv"
        || host.ends_with(".twitch.tv")
}

/// Parse the custom-scheme URI (`ksvod://localhost/host/path?q=1`) and
/// reconstruct the original HTTPS URL (`https://host/path?q=1`). Returns
/// `None` if the host extracted from the path is not on the allowlist.
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
    if !is_allowed_media_host(host) {
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
        tauri::async_runtime::spawn(async move {
            let client = proxy_client();
            let result = client.get(&target).send().await;
            match result {
                Ok(resp) => {
                    let status = resp.status();
                    let content_type = resp
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("application/octet-stream")
                        .to_string();
                    let bytes = resp.bytes().await.unwrap_or_default();
                    responder.respond(
                        tauri::http::Response::builder()
                            .status(status.as_u16())
                            .header("content-type", content_type)
                            .header("access-control-allow-origin", "*")
                            .body(Cow::from(bytes.to_vec()))
                            .unwrap(),
                    );
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
