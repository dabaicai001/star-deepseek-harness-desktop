//! Web 网关:本地 HTTP 代理,全流量经 reqwest 转发。
//!
//! 与旧版区别:HTTPS 在 reqwest 的 rustls 层正确终止(SNI/证书验证),
//! 前端 webview 全程只见本地明文 HTTP,无证书问题。
//! HTML 响应做 URL 改写,让子资源也走同一条中转链路。
//!
//! 注意:上游请求由 reqwest 在本机发出(非经 SSH 服务器中转);
//! 若需纯内网从服务器视角访问,请在 SSH 终端使用 curl。

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{timeout, Duration};
use reqwest::Client;

const MAX_REQUEST_HEAD_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 24 * 1024 * 1024;
const UPSTREAM_TIMEOUT_SEC: u64 = 30;

pub const GATEWAY_PATH_PREFIX: &str = "/__proxy__/";

pub struct GatewayHandle {
    pub port: u16,
    pub abort: tokio::task::AbortHandle,
    pub connections: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>>,
}

pub async fn start(local_port: u16) -> Result<GatewayHandle, String> {
    let listener = TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| format!("web gateway bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("web gateway local addr failed: {e}"))?
        .port();
    let connections: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let connections_loop = Arc::clone(&connections);
    let task = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let conn = tokio::spawn(async move {
                        if let Err(e) = handle_conn(stream).await {
                            tracing::debug!("web gateway conn closed: {e}");
                        }
                    });
                    if let Ok(mut v) = connections_loop.lock() {
                        v.push(conn.abort_handle());
                    }
                }
                Err(_) => break,
            }
        }
    });
    Ok(GatewayHandle {
        port,
        abort: task.abort_handle(),
        connections,
    })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

async fn read_request_head(stream: &mut TcpStream) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            return Ok((buf[..pos + 4].to_vec(), buf[pos + 4..].to_vec()));
        }
        if buf.len() >= MAX_REQUEST_HEAD_BYTES {
            return Err("request head too large".to_string());
        }
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read request failed: {e}"))?;
        if n == 0 {
            return Err("connection closed before request head".to_string());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

async fn respond_text(stream: &mut TcpStream, status: &str, message: &str) {
    let body = message.as_bytes();
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

async fn handle_conn(mut stream: TcpStream) -> Result<(), String> {
    let (head_bytes, _leftover) = read_request_head(&mut stream).await?;
    let head_text = String::from_utf8_lossy(&head_bytes).to_string();
    let mut lines = head_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_ascii_uppercase();
    let raw_path = parts.next().unwrap_or_default().to_string();

    // 解析 /__proxy__/<scheme>/<hostport>/<path>?<query>
    let Some(rest) = raw_path.strip_prefix(GATEWAY_PATH_PREFIX) else {
        respond_text(
            &mut stream,
            "404 Not Found",
            "web gateway: expect /__proxy__/<scheme>/<host>/<path>",
        )
        .await;
        return Ok(());
    };
    let mut seg = rest.splitn(3, '/');
    let scheme = seg.next().unwrap_or_default().to_string();
    let hostport = seg.next().unwrap_or_default().to_string();
    let tail = seg.next().unwrap_or_default();
    let path_query = if tail.is_empty() {
        "/".to_string()
    } else {
        format!("/{tail}")
    };
    if (scheme != "http" && scheme != "https") || hostport.is_empty() {
        respond_text(&mut stream, "400 Bad Request", "web gateway: bad proxy path").await;
        return Ok(());
    }

    let target_url = format!("{scheme}://{hostport}{path_query}");

    let client = Client::builder()
        .user_agent("Mozilla/5.0 (StarHub Web Gateway)")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("build reqwest client failed: {e}"))?;

    let resp = timeout(
        Duration::from_secs(UPSTREAM_TIMEOUT_SEC),
        client.request(
            reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET),
            &target_url,
        ),
    )
    .await
    .map_err(|_| "upstream timed out".to_string())?
    .and_then(|r| {
        r.error_for_status()
            .map_err(|e| format!("upstream status: {e}"))
    })?;

    // 收集响应,限制大小
    let status = resp.status().as_u16();
    let resp_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let status_text = resp.status().canonical_reason().unwrap_or("Unknown");
    let content_type = resp_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.to_ascii_lowercase())
        .unwrap_or_default();

    let mut body = Vec::new();
    {
        let mut chunk = [0u8; 32768];
        let mut total = 0usize;
        // reqwest 0.12 的 IntoAsyncRead 需要 boxed,这里简化用 bytes()
        let full = resp.bytes().await.map_err(|e| format!("read upstream body: {e}"))?;
        let slice = if full.len() > MAX_RESPONSE_BYTES {
            &full[..MAX_RESPONSE_BYTES]
        } else {
            &full
        };
        body.extend_from_slice(slice);
    }

    // HTML 改写
    if content_type.contains("text/html") {
        let html = String::from_utf8_lossy(&body);
        body = rewrite_html(&html, &scheme, &hostport).into_bytes();
    }

    // 回写响应
    const SKIP_HEADERS: &[&str] = &[
        "content-length",
        "transfer-encoding",
        "content-encoding",
        "connection",
        "keep-alive",
        "access-control-allow-origin",
        "access-control-allow-methods",
        "access-control-allow-headers",
    ];
    let mut out = format!("HTTP/1.1 {status} {status_text}\r\n");
    for (k, v) in &resp_headers {
        let lower = k.to_ascii_lowercase();
        if SKIP_HEADERS.contains(&lower.as_str()) {
            continue;
        }
        if lower == "location" {
            out.push_str(&format!("Location: {}\r\n", rewrite_location(v, &scheme, &hostport)));
            continue;
        }
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    stream
        .write_all(out.as_bytes())
        .await
        .map_err(|e| format!("write response failed: {e}"))?;
    stream
        .write_all(&body)
        .await
        .map_err(|e| format!("write body failed: {e}"))?;
    Ok(())
}

fn replace_root_relative(
    input: &str,
    needle: &str,
    page_prefix: &str,
    scheme_prefix: &str,
) -> String {
    let mut out = String::with_capacity(input.len() + input.len() / 4);
    let mut rest = input;
    while let Some(idx) = rest.find(needle) {
        let after = idx + needle.len();
        out.push_str(&rest[..after]);
        rest = &rest[after..];
        if rest.starts_with("/__proxy__/") {
            continue;
        }
        if rest.starts_with("//") {
            out.push_str(scheme_prefix);
            rest = &rest[2..];
        } else if rest.starts_with('/') {
            out.push_str(page_prefix);
        }
    }
    out.push_str(rest);
    out
}

fn rewrite_html(html: &str, scheme: &str, hostport: &str) -> String {
    let page_prefix = format!("{GATEWAY_PATH_PREFIX}{scheme}/{hostport}");
    let scheme_prefix = format!("{GATEWAY_PATH_PREFIX}{scheme}/");
    let mut s = html.to_string();
    for q in ['"', '\''] {
        s = s.replace(
            &format!("{q}https://"),
            &format!("{q}{GATEWAY_PATH_PREFIX}https/"),
        );
        s = s.replace(
            &format!("{q}http://"),
            &format!("{q}{GATEWAY_PATH_PREFIX}http/"),
        );
    }
    s = s.replace(
        &format!("(https://"),
        &format!("({GATEWAY_PATH_PREFIX}https/"),
    );
    s = s.replace(
        &format!("(http://"),
        &format!("({GATEWAY_PATH_PREFIX}http/"),
    );
    for q in ['"', '\''] {
        s = s.replace(&format!("{q}//"), &format!("{q}{scheme_prefix}"));
    }
    s = s.replace("(//", &format!("({scheme_prefix}"));
    for attr in ["href", "src", "action", "poster", "formaction"] {
        for q in ['"', '\''] {
            s = replace_root_relative(&s, &format!("{attr}={q}"), &page_prefix, &scheme_prefix);
        }
    }
    for needle in ["url(", "url(\"", "url('"] {
        s = replace_root_relative(&s, needle, &page_prefix, &scheme_prefix);
    }
    s
}

fn rewrite_location(value: &str, scheme: &str, hostport: &str) -> String {
    if let Some(rest) = value.strip_prefix("https://") {
        return format!("{GATEWAY_PATH_PREFIX}https/{rest}");
    }
    if let Some(rest) = value.strip_prefix("http://") {
        return format!("{GATEWAY_PATH_PREFIX}http/{rest}");
    }
    if let Some(rest) = value.strip_prefix("//") {
        return format!("{GATEWAY_PATH_PREFIX}{scheme}/{rest}");
    }
    if value.starts_with('/') {
        return format!("{GATEWAY_PATH_PREFIX}{scheme}/{hostport}{value}");
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_absolute_protocol_relative_and_root_urls() {
        let html = r#"<html><head><link href="/assets/a.css"></head><body>
<img src="https://cdn.example.com/i.png"><a href="//m.example.com/x">x</a>
<form action='/login'></form><script>var u = "https://api.example.com/v1";</script>
<style>.b{background:url(/img/b.png)}</style></body></html>"#;
        let out = rewrite_html(html, "https", "www.example.com");
        assert!(out.contains(r#"href="/__proxy__/https/www.example.com/assets/a.css""#));
        assert!(out.contains(r#"src="/__proxy__/https/cdn.example.com/i.png""#));
        assert!(out.contains(r#"href="/__proxy__/https/m.example.com/x""#));
        assert!(out.contains(r#"action='/__proxy__/https/www.example.com/login'"#));
        assert!(out.contains(r#""/__proxy__/https/api.example.com/v1""#));
        assert!(out.contains("url(/__proxy__/https/www.example.com/img/b.png)"));
    }

    #[test]
    fn rewrites_redirect_locations() {
        assert_eq!(
            rewrite_location("https://a.com/login", "http", "b.com"),
            "/__proxy__/https/a.com/login"
        );
    }
}
