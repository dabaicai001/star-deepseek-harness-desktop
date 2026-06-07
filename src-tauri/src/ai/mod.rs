use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub provider: String,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub system: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatResponse {
    pub content: String,
    pub model: String,
    pub usage: Usage,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
}

pub fn list_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo { id: "claude-sonnet-4-20250514".into(), name: "Claude Sonnet 4".into(), provider: "claude".into() },
        ModelInfo { id: "claude-3-5-haiku-20241022".into(), name: "Claude 3.5 Haiku".into(), provider: "claude".into() },
        ModelInfo { id: "gpt-4o".into(), name: "GPT-4o".into(), provider: "openai".into() },
        ModelInfo { id: "gpt-4o-mini".into(), name: "GPT-4o Mini".into(), provider: "openai".into() },
        ModelInfo { id: "gpt-4-turbo".into(), name: "GPT-4 Turbo".into(), provider: "openai".into() },
    ]
}

pub async fn chat(request: ChatRequest) -> Result<ChatResponse, String> {
    let client = Client::new();

    match request.provider.as_str() {
        "claude" => chat_claude(&client, &request).await,
        "openai" => chat_openai(&client, &request).await,
        _ => Err(format!("Unsupported provider: {}", request.provider)),
    }
}

async fn chat_claude(client: &Client, request: &ChatRequest) -> Result<ChatResponse, String> {
    let system = request.system.clone().unwrap_or_default();

    let messages: Vec<serde_json::Value> = request.messages.iter()
        .filter(|m| m.role != "system")
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();

    let mut body = serde_json::json!({
        "model": request.model,
        "max_tokens": request.max_tokens.unwrap_or(4096),
        "messages": messages,
    });

    if !system.is_empty() {
        body["system"] = serde_json::Value::String(system);
    }
    if let Some(temp) = request.temperature {
        body["temperature"] = serde_json::json!(temp);
    }

    let resp = client.post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &request.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Read body failed: {}", e))?;

    if !status.is_success() {
        return Err(format!("Claude API error ({}): {}", status, text));
    }

    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Parse response failed: {}", e))?;

    let content = json["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let input_tokens = json["usage"]["input_tokens"].as_u64().unwrap_or(0) as u32;
    let output_tokens = json["usage"]["output_tokens"].as_u64().unwrap_or(0) as u32;

    Ok(ChatResponse {
        content,
        model: request.model.clone(),
        usage: Usage { input_tokens, output_tokens },
    })
}

async fn chat_openai(client: &Client, request: &ChatRequest) -> Result<ChatResponse, String> {
    let mut messages: Vec<serde_json::Value> = Vec::new();

    if let Some(system) = &request.system {
        messages.push(serde_json::json!({ "role": "system", "content": system }));
    }

    for m in &request.messages {
        messages.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }

    let mut body = serde_json::json!({
        "model": request.model,
        "messages": messages,
    });
    if let Some(temp) = request.temperature {
        body["temperature"] = serde_json::json!(temp);
    }
    if let Some(max) = request.max_tokens {
        body["max_tokens"] = serde_json::json!(max);
    }

    let resp = client.post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", request.api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Read body failed: {}", e))?;

    if !status.is_success() {
        return Err(format!("OpenAI API error ({}): {}", status, text));
    }

    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Parse response failed: {}", e))?;

    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let input_tokens = json["usage"]["prompt_tokens"].as_u64().unwrap_or(0) as u32;
    let output_tokens = json["usage"]["completion_tokens"].as_u64().unwrap_or(0) as u32;

    Ok(ChatResponse {
        content,
        model: request.model.clone(),
        usage: Usage { input_tokens, output_tokens },
    })
}
