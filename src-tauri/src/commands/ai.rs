use crate::ai;
use serde_json::Value;

#[tauri::command]
pub async fn ai_chat(params: Value) -> Result<Value, String> {
    let request = ai::ChatRequest {
        provider: params["provider"].as_str().unwrap_or("claude").to_string(),
        api_key: params["api_key"].as_str().unwrap_or("").to_string(),
        model: params["model"]
            .as_str()
            .unwrap_or("claude-sonnet-4-20250514")
            .to_string(),
        messages: serde_json::from_value(params["messages"].clone()).unwrap_or_default(),
        temperature: params["temperature"].as_f64().map(|v| v as f32),
        max_tokens: params["max_tokens"].as_u64().map(|v| v as u32),
        system: params["system"].as_str().map(|s| s.to_string()),
    };

    if request.api_key.is_empty() {
        return Err("API key is required".to_string());
    }

    let response = ai::chat(request).await?;

    serde_json::to_value(&response).map_err(|e| format!("Serialize response failed: {}", e))
}

#[tauri::command]
pub async fn ai_list_models() -> Result<Value, String> {
    let models = ai::list_models();
    serde_json::to_value(&models).map_err(|e| format!("Serialize models failed: {}", e))
}
