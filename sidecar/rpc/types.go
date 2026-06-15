package rpc

import "encoding/json"

// Request 表示 JSON-RPC 请求
type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

// Response 表示 JSON-RPC 响应
type Response struct {
	ID     string      `json:"id"`
	Result interface{} `json:"result,omitempty"`
	Error  *Error      `json:"error,omitempty"`
}

// Error 表示 JSON-RPC 错误
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ErrorCode 定义错误码
const (
	ParseError     = -32700
	InvalidRequest = -32600
	MethodNotFound = -32601
	InvalidParams  = -32602
	InternalError  = -32603
)
