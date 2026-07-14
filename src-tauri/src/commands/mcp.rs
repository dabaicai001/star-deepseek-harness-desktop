use crate::mcp::{self, McpServerConfig, McpTool};
use serde_json::Value;

#[tauri::command]
pub async fn mcp_list_tools(server: McpServerConfig) -> Result<Vec<McpTool>, String> {
    mcp::list_tools(server).await
}

#[tauri::command]
pub async fn mcp_call_tool(
    server: McpServerConfig,
    tool_name: String,
    arguments: Value,
) -> Result<Value, String> {
    mcp::call_tool(server, tool_name, arguments).await
}
