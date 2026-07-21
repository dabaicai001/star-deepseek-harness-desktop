use bytes::Bytes;
use futures::{stream::BoxStream, StreamExt};
use reqwest::{header, Client, RequestBuilder, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const PROTOCOL_VERSION: &str = "2025-06-18";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_STDIO_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOOL_PAGES: usize = 100;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpKeyValue {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub env: Vec<McpKeyValue>,
    #[serde(default)]
    pub headers: Vec<McpKeyValue>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, rename = "inputSchema")]
    pub input_schema: Value,
    #[serde(default)]
    pub annotations: Value,
}

fn initialize_request(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "StarHub", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

fn initialized_notification() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    })
}

fn rpc_request(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn id_matches(value: &Value, id: u64) -> bool {
    value.get("id").is_some_and(|candidate| {
        candidate.as_u64() == Some(id)
            || candidate
                .as_str()
                .and_then(|value| value.parse::<u64>().ok())
                == Some(id)
    })
}

fn rpc_result(message: Value) -> Result<Value, String> {
    if let Some(error) = message.get("error") {
        let code = error
            .get("code")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Unknown MCP JSON-RPC error");
        return Err(format!("MCP JSON-RPC error {code}: {detail}"));
    }
    message
        .get("result")
        .cloned()
        .ok_or_else(|| "MCP response is missing result".to_string())
}

fn validate_server(server: &McpServerConfig) -> Result<(), String> {
    if server.id.trim().is_empty() || server.name.trim().is_empty() {
        return Err("MCP server id and name are required".to_string());
    }
    match server.transport.as_str() {
        "stdio" if server.command.trim().is_empty() => {
            Err("stdio MCP server command is required".to_string())
        }
        "stdio" => Ok(()),
        "streamable-http" | "sse" if server.url.trim().is_empty() => {
            Err("HTTP MCP server URL is required".to_string())
        }
        "streamable-http" | "sse" => {
            let url = Url::parse(server.url.trim()).map_err(|e| format!("Invalid MCP URL: {e}"))?;
            if url.scheme() != "http" && url.scheme() != "https" {
                return Err("MCP URL must use http or https".to_string());
            }
            Ok(())
        }
        other => Err(format!("Unsupported MCP transport: {other}")),
    }
}

struct StdioMcpClient {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    /// 长驻 client 的递增请求 id(1 留给 initialize)
    next_id: u64,
}

impl StdioMcpClient {
    async fn connect(server: &McpServerConfig) -> Result<Self, String> {
        let mut command = Command::new(server.command.trim());
        command
            .args(&server.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if !server.cwd.trim().is_empty() {
            command.current_dir(server.cwd.trim());
        }
        for item in &server.env {
            if !item.name.trim().is_empty() {
                command.env(item.name.trim(), &item.value);
            }
        }
        #[cfg(target_os = "windows")]
        command.as_std_mut().creation_flags(0x0800_0000);

        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to start MCP server {}: {e}", server.name))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MCP stdio stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP stdio stdout is unavailable".to_string())?;
        if let Some(stderr) = child.stderr.take() {
            let server_name = server.name.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(mcp_server = %server_name, "{line}");
                }
            });
        }
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
            next_id: 2,
        })
    }

    fn next_request_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    async fn send(&mut self, message: &Value) -> Result<(), String> {
        let serialized = serde_json::to_string(message).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(serialized.as_bytes())
            .await
            .map_err(|e| format!("Failed to write MCP stdio request: {e}"))?;
        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to delimit MCP stdio request: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush MCP stdio request: {e}"))
    }

    async fn wait_for(&mut self, id: u64) -> Result<Value, String> {
        // 超时覆盖整个请求,而不是每读一行就重置
        timeout(REQUEST_TIMEOUT, async {
            loop {
                let line = self
                    .stdout
                    .next_line()
                    .await
                    .map_err(|e| format!("Failed to read MCP stdio response: {e}"))?
                    .ok_or_else(|| "MCP stdio server closed stdout".to_string())?;
                if line.len() > MAX_STDIO_MESSAGE_BYTES {
                    return Err("MCP stdio response exceeded 8 MiB".to_string());
                }
                let message: Value = match serde_json::from_str(&line) {
                    Ok(value) => value,
                    Err(error) => {
                        tracing::warn!("Ignoring malformed MCP stdout line: {error}");
                        continue;
                    }
                };
                if id_matches(&message, id) {
                    return Ok(message);
                }
            }
        })
        .await
        .map_err(|_| format!("MCP stdio response timed out for request {id}"))?
    }

    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        self.send(&rpc_request(id, method, params)).await?;
        rpc_result(self.wait_for(id).await?)
    }

    async fn initialize(&mut self) -> Result<(), String> {
        self.send(&initialize_request(1)).await?;
        rpc_result(self.wait_for(1).await?)?;
        self.send(&initialized_notification()).await
    }

    async fn shutdown(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

/// 长驻 stdio MCP client 缓存(按 server.id):避免每次调用都 spawn + initialize + kill。
/// 请求失败(通常是进程崩溃)时淘汰缓存,下一次调用自动重建。
static STDIO_CLIENTS: OnceLock<
    tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<StdioMcpClient>>>>,
> = OnceLock::new();

fn stdio_clients(
) -> &'static tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<StdioMcpClient>>>> {
    STDIO_CLIENTS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

async fn get_stdio_client(
    server: &McpServerConfig,
) -> Result<Arc<tokio::sync::Mutex<StdioMcpClient>>, String> {
    if let Some(client) = stdio_clients().lock().await.get(&server.id) {
        return Ok(client.clone());
    }
    let mut client = StdioMcpClient::connect(server).await?;
    if let Err(error) = client.initialize().await {
        client.shutdown().await;
        return Err(error);
    }
    let client = Arc::new(tokio::sync::Mutex::new(client));
    stdio_clients()
        .lock()
        .await
        .insert(server.id.clone(), client.clone());
    Ok(client)
}

/// 淘汰缓存的 stdio client 并杀掉残留进程,下一次调用会重新 spawn + initialize。
async fn evict_stdio_client(server_id: &str) {
    let client = stdio_clients().lock().await.remove(server_id);
    if let Some(client) = client {
        client.lock().await.shutdown().await;
    }
}

async fn stdio_list_tools(server: &McpServerConfig) -> Result<Vec<McpTool>, String> {
    let client = get_stdio_client(server).await?;
    let mut guard = client.lock().await;
    let result = async {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_TOOL_PAGES {
            let id = guard.next_request_id();
            let params = cursor
                .as_ref()
                .map(|value| json!({ "cursor": value }))
                .unwrap_or_else(|| json!({}));
            let response = guard.request(id, "tools/list", params).await?;
            let page_tools = response.get("tools").cloned().unwrap_or_else(|| json!([]));
            tools.extend(
                serde_json::from_value::<Vec<McpTool>>(page_tools)
                    .map_err(|e| format!("Invalid MCP tools/list response: {e}"))?,
            );
            cursor = response
                .get("nextCursor")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            if cursor.is_none() {
                return Ok(tools);
            }
        }
        Err("MCP tools/list exceeded 100 pages".to_string())
    }
    .await;
    match result {
        Ok(tools) => Ok(tools),
        Err(error) => {
            drop(guard);
            evict_stdio_client(&server.id).await;
            Err(error)
        }
    }
}

async fn stdio_call_tool(
    server: &McpServerConfig,
    tool_name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let client = get_stdio_client(server).await?;
    let mut guard = client.lock().await;
    let id = guard.next_request_id();
    let result = guard
        .request(
            id,
            "tools/call",
            json!({ "name": tool_name, "arguments": arguments }),
        )
        .await;
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            drop(guard);
            evict_stdio_client(&server.id).await;
            Err(error)
        }
    }
}

#[derive(Debug)]
struct SseEvent {
    event: String,
    data: String,
}

struct SseReader {
    stream: BoxStream<'static, Result<Bytes, reqwest::Error>>,
    buffer: String,
    ready: VecDeque<SseEvent>,
}

impl SseReader {
    fn new(response: Response) -> Self {
        Self {
            stream: response.bytes_stream().boxed(),
            buffer: String::new(),
            ready: VecDeque::new(),
        }
    }

    fn parse_ready(&mut self) {
        self.buffer = self.buffer.replace("\r\n", "\n");
        while let Some(index) = self.buffer.find("\n\n") {
            let block = self.buffer[..index].to_string();
            self.buffer.drain(..index + 2);
            let mut event = "message".to_string();
            let mut data = Vec::new();
            for line in block.lines() {
                if line.starts_with(':') {
                    continue;
                }
                if let Some(value) = line.strip_prefix("event:") {
                    event = value.trim_start().to_string();
                } else if let Some(value) = line.strip_prefix("data:") {
                    data.push(value.trim_start().to_string());
                }
            }
            if !data.is_empty() || event != "message" {
                self.ready.push_back(SseEvent {
                    event,
                    data: data.join("\n"),
                });
            }
        }
    }

    async fn next_event(&mut self) -> Result<SseEvent, String> {
        loop {
            self.parse_ready();
            if let Some(event) = self.ready.pop_front() {
                return Ok(event);
            }
            let chunk = timeout(REQUEST_TIMEOUT, self.stream.next())
                .await
                .map_err(|_| "MCP SSE response timed out".to_string())?
                .ok_or_else(|| "MCP SSE stream closed".to_string())?
                .map_err(|e| format!("Failed to read MCP SSE stream: {e}"))?;
            self.buffer.push_str(&String::from_utf8_lossy(&chunk));
            if self.buffer.len() > MAX_STDIO_MESSAGE_BYTES {
                return Err("MCP SSE event exceeded 8 MiB".to_string());
            }
        }
    }

    async fn wait_for_json_rpc(&mut self, id: u64) -> Result<Value, String> {
        loop {
            let event = self.next_event().await?;
            if event.event != "message" && event.event != "" {
                continue;
            }
            let message: Value = serde_json::from_str(&event.data)
                .map_err(|e| format!("Invalid MCP SSE JSON-RPC message: {e}"))?;
            if id_matches(&message, id) {
                return Ok(message);
            }
        }
    }
}

fn add_configured_headers(
    mut request: RequestBuilder,
    server: &McpServerConfig,
) -> Result<RequestBuilder, String> {
    for item in &server.headers {
        if item.name.trim().is_empty() {
            continue;
        }
        let name = header::HeaderName::from_bytes(item.name.trim().as_bytes())
            .map_err(|e| format!("Invalid MCP header name {}: {e}", item.name))?;
        let value = header::HeaderValue::from_str(&item.value)
            .map_err(|e| format!("Invalid MCP header value for {}: {e}", item.name))?;
        request = request.header(name, value);
    }
    Ok(request)
}

fn response_session_id(response: &Response) -> Option<String> {
    response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

async fn response_error(response: Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let summary: String = body.chars().take(2000).collect();
    format!("MCP HTTP error {status}: {summary}")
}

async fn parse_http_json_rpc(response: Response, id: u64) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let is_sse = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
    if is_sse {
        return SseReader::new(response).wait_for_json_rpc(id).await;
    }
    let message: Value = response
        .json()
        .await
        .map_err(|e| format!("Invalid MCP HTTP JSON response: {e}"))?;
    if !id_matches(&message, id) {
        return Err(format!("MCP HTTP response id did not match request {id}"));
    }
    Ok(message)
}

struct HttpMcpClient {
    client: Client,
    server: McpServerConfig,
    url: Url,
    session_id: Option<String>,
    protocol_version: String,
}

enum HttpInitialize {
    Ready(HttpMcpClient),
    LegacyFallback,
}

impl HttpMcpClient {
    async fn initialize(server: &McpServerConfig) -> Result<HttpInitialize, String> {
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| format!("Failed to create MCP HTTP client: {e}"))?;
        let url = Url::parse(server.url.trim()).map_err(|e| format!("Invalid MCP URL: {e}"))?;
        let request = add_configured_headers(
            client
                .post(url.clone())
                .header(header::ACCEPT, "application/json, text/event-stream")
                .header(header::CONTENT_TYPE, "application/json")
                .json(&initialize_request(1)),
            server,
        )?;
        let response = request
            .send()
            .await
            .map_err(|e| format!("MCP Streamable HTTP initialize failed: {e}"))?;
        if response.status() == StatusCode::NOT_FOUND
            || response.status() == StatusCode::METHOD_NOT_ALLOWED
        {
            return Ok(HttpInitialize::LegacyFallback);
        }
        let session_id = response_session_id(&response);
        let initialized = rpc_result(parse_http_json_rpc(response, 1).await?)?;
        let protocol_version = initialized
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(PROTOCOL_VERSION)
            .to_string();
        let ready = Self {
            client,
            server: server.clone(),
            url,
            session_id,
            protocol_version,
        };
        ready.notify_initialized().await?;
        Ok(HttpInitialize::Ready(ready))
    }

    fn post(&self, body: &Value) -> Result<RequestBuilder, String> {
        let mut request = self
            .client
            .post(self.url.clone())
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header(header::CONTENT_TYPE, "application/json")
            .header("mcp-protocol-version", &self.protocol_version)
            .json(body);
        if let Some(session_id) = &self.session_id {
            request = request.header("mcp-session-id", session_id);
        }
        add_configured_headers(request, &self.server)
    }

    async fn notify_initialized(&self) -> Result<(), String> {
        let response = self
            .post(&initialized_notification())?
            .send()
            .await
            .map_err(|e| format!("MCP initialized notification failed: {e}"))?;
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        Ok(())
    }

    async fn request(&self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        let response = self
            .post(&rpc_request(id, method, params))?
            .send()
            .await
            .map_err(|e| format!("MCP Streamable HTTP request failed: {e}"))?;
        rpc_result(parse_http_json_rpc(response, id).await?)
    }

    async fn close(&self) {
        let Some(session_id) = &self.session_id else {
            return;
        };
        let request = self
            .client
            .delete(self.url.clone())
            .header("mcp-session-id", session_id)
            .header("mcp-protocol-version", &self.protocol_version);
        if let Ok(request) = add_configured_headers(request, &self.server) {
            let _ = request.send().await;
        }
    }
}

async fn http_list_tools(server: &McpServerConfig) -> Result<Vec<McpTool>, String> {
    match HttpMcpClient::initialize(server).await? {
        HttpInitialize::LegacyFallback => legacy_sse_list_tools(server).await,
        HttpInitialize::Ready(client) => {
            let result = async {
                let mut tools = Vec::new();
                let mut cursor: Option<String> = None;
                for page in 0..MAX_TOOL_PAGES {
                    let params = cursor
                        .as_ref()
                        .map(|value| json!({ "cursor": value }))
                        .unwrap_or_else(|| json!({}));
                    let response = client
                        .request(page as u64 + 2, "tools/list", params)
                        .await?;
                    tools.extend(
                        serde_json::from_value::<Vec<McpTool>>(
                            response.get("tools").cloned().unwrap_or_else(|| json!([])),
                        )
                        .map_err(|e| format!("Invalid MCP tools/list response: {e}"))?,
                    );
                    cursor = response
                        .get("nextCursor")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string);
                    if cursor.is_none() {
                        return Ok(tools);
                    }
                }
                Err("MCP tools/list exceeded 100 pages".to_string())
            }
            .await;
            client.close().await;
            result
        }
    }
}

async fn http_call_tool(
    server: &McpServerConfig,
    tool_name: &str,
    arguments: Value,
) -> Result<Value, String> {
    match HttpMcpClient::initialize(server).await? {
        HttpInitialize::LegacyFallback => legacy_sse_call_tool(server, tool_name, arguments).await,
        HttpInitialize::Ready(client) => {
            let result = client
                .request(
                    2,
                    "tools/call",
                    json!({ "name": tool_name, "arguments": arguments }),
                )
                .await;
            client.close().await;
            result
        }
    }
}

async fn open_legacy_sse(server: &McpServerConfig) -> Result<(Client, Url, SseReader), String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to create MCP SSE client: {e}"))?;
    let base_url =
        Url::parse(server.url.trim()).map_err(|e| format!("Invalid MCP SSE URL: {e}"))?;
    let request = add_configured_headers(
        client
            .get(base_url.clone())
            .header(header::ACCEPT, "text/event-stream"),
        server,
    )?;
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to open MCP SSE stream: {e}"))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let mut reader = SseReader::new(response);
    let endpoint = loop {
        let event = reader.next_event().await?;
        if event.event == "endpoint" {
            break event.data;
        }
    };
    let endpoint_url = base_url
        .join(endpoint.trim())
        .map_err(|e| format!("Invalid MCP SSE endpoint: {e}"))?;
    if endpoint_url.scheme() != base_url.scheme()
        || endpoint_url.host_str() != base_url.host_str()
        || endpoint_url.port_or_known_default() != base_url.port_or_known_default()
    {
        return Err("MCP SSE endpoint must use the same origin as the configured URL".to_string());
    }
    Ok((client, endpoint_url, reader))
}

async fn legacy_post(
    client: &Client,
    server: &McpServerConfig,
    endpoint: &Url,
    body: &Value,
) -> Result<(), String> {
    let request = add_configured_headers(
        client
            .post(endpoint.clone())
            .header(header::ACCEPT, "application/json")
            .header(header::CONTENT_TYPE, "application/json")
            .json(body),
        server,
    )?;
    let response = request
        .send()
        .await
        .map_err(|e| format!("MCP SSE POST failed: {e}"))?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    Ok(())
}

async fn initialize_legacy_sse(
    server: &McpServerConfig,
) -> Result<(Client, Url, SseReader), String> {
    let (client, endpoint, mut reader) = open_legacy_sse(server).await?;
    legacy_post(&client, server, &endpoint, &initialize_request(1)).await?;
    rpc_result(reader.wait_for_json_rpc(1).await?)?;
    legacy_post(&client, server, &endpoint, &initialized_notification()).await?;
    Ok((client, endpoint, reader))
}

async fn legacy_sse_list_tools(server: &McpServerConfig) -> Result<Vec<McpTool>, String> {
    let (client, endpoint, mut reader) = initialize_legacy_sse(server).await?;
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 0..MAX_TOOL_PAGES {
        let id = page as u64 + 2;
        let params = cursor
            .as_ref()
            .map(|value| json!({ "cursor": value }))
            .unwrap_or_else(|| json!({}));
        legacy_post(
            &client,
            server,
            &endpoint,
            &rpc_request(id, "tools/list", params),
        )
        .await?;
        let response = rpc_result(reader.wait_for_json_rpc(id).await?)?;
        tools.extend(
            serde_json::from_value::<Vec<McpTool>>(
                response.get("tools").cloned().unwrap_or_else(|| json!([])),
            )
            .map_err(|e| format!("Invalid MCP tools/list response: {e}"))?,
        );
        cursor = response
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if cursor.is_none() {
            return Ok(tools);
        }
    }
    Err("MCP tools/list exceeded 100 pages".to_string())
}

async fn legacy_sse_call_tool(
    server: &McpServerConfig,
    tool_name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let (client, endpoint, mut reader) = initialize_legacy_sse(server).await?;
    legacy_post(
        &client,
        server,
        &endpoint,
        &rpc_request(
            2,
            "tools/call",
            json!({ "name": tool_name, "arguments": arguments }),
        ),
    )
    .await?;
    rpc_result(reader.wait_for_json_rpc(2).await?)
}

pub async fn list_tools(server: McpServerConfig) -> Result<Vec<McpTool>, String> {
    validate_server(&server)?;
    match server.transport.as_str() {
        "stdio" => stdio_list_tools(&server).await,
        "streamable-http" => http_list_tools(&server).await,
        "sse" => legacy_sse_list_tools(&server).await,
        other => Err(format!("Unsupported MCP transport: {other}")),
    }
}

pub async fn call_tool(
    server: McpServerConfig,
    tool_name: String,
    arguments: Value,
) -> Result<Value, String> {
    validate_server(&server)?;
    if tool_name.trim().is_empty() {
        return Err("MCP tool name is required".to_string());
    }
    match server.transport.as_str() {
        "stdio" => stdio_call_tool(&server, &tool_name, arguments).await,
        "streamable-http" => http_call_tool(&server, &tool_name, arguments).await,
        "sse" => legacy_sse_call_tool(&server, &tool_name, arguments).await,
        other => Err(format!("Unsupported MCP transport: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{id_matches, rpc_result, stdio_call_tool, stdio_list_tools, McpServerConfig};
    use serde_json::json;

    fn node_stdio_server() -> Option<McpServerConfig> {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            return None;
        }
        let script = r#"
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: message.params.arguments.text }] } });
  }
});
"#;
        Some(McpServerConfig {
            id: "test-stdio".to_string(),
            name: "Test stdio".to_string(),
            enabled: true,
            transport: "stdio".to_string(),
            command: "node".to_string(),
            args: vec!["-e".to_string(), script.to_string()],
            cwd: String::new(),
            url: String::new(),
            env: Vec::new(),
            headers: Vec::new(),
        })
    }

    #[test]
    fn matches_numeric_and_string_json_rpc_ids() {
        assert!(id_matches(&json!({ "id": 7 }), 7));
        assert!(id_matches(&json!({ "id": "7" }), 7));
        assert!(!id_matches(&json!({ "id": 8 }), 7));
    }

    #[test]
    fn exposes_json_rpc_errors() {
        let error = rpc_result(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "error": { "code": -32601, "message": "missing" }
        }))
        .unwrap_err();
        assert!(error.contains("-32601"));
        assert!(error.contains("missing"));
    }

    #[test]
    fn deserializes_camel_case_server_config() {
        let config: McpServerConfig = serde_json::from_value(json!({
            "id": "filesystem",
            "name": "Filesystem",
            "enabled": true,
            "transport": "stdio",
            "command": "server",
            "args": [],
            "cwd": "",
            "url": "",
            "env": [],
            "headers": []
        }))
        .unwrap();
        assert_eq!(config.transport, "stdio");
    }

    #[tokio::test]
    async fn discovers_and_calls_a_stdio_tool() {
        let Some(server) = node_stdio_server() else {
            return;
        };
        let tools = stdio_list_tools(&server).await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");

        let result = stdio_call_tool(&server, "echo", json!({ "text": "hello" }))
            .await
            .unwrap();
        assert_eq!(result["content"][0]["text"], "hello");
    }
}
