package rpc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// Handler 是 RPC 方法处理函数
type Handler func(params json.RawMessage) (interface{}, error)

// Server 是 JSON-RPC 服务器
type Server struct {
	mu       sync.RWMutex
	handlers map[string]Handler
}

// NewServer 创建新的 RPC 服务器
func NewServer() *Server {
	return &Server{
		handlers: make(map[string]Handler),
	}
}

// Register 注册 RPC 方法
func (s *Server) Register(method string, handler Handler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handlers[method] = handler
}

// Run 运行服务器，从 stdin 读取请求，输出到 stdout
func (s *Server) Run() error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 10<<20) // 10MB buffer

	for scanner.Scan() {
		data := scanner.Bytes()
		if len(data) == 0 {
			continue
		}

		var req Request
		if err := json.Unmarshal(data, &req); err != nil {
			s.writeError("", ParseError, "Parse error: "+err.Error())
			continue
		}

		go s.handleRequest(req)
	}

	return scanner.Err()
}

func (s *Server) handleRequest(req Request) {
	s.mu.RLock()
	handler, ok := s.handlers[req.Method]
	s.mu.RUnlock()

	if !ok {
		s.writeError(req.ID, MethodNotFound, "Method not found: "+req.Method)
		return
	}

	result, err := handler(req.Params)
	if err != nil {
		s.writeError(req.ID, InternalError, err.Error())
		return
	}

	s.writeResult(req.ID, result)
}

func (s *Server) writeResult(id string, result interface{}) {
	resp := Response{
		ID:     id,
		Result: result,
	}
	s.writeResponse(resp)
}

func (s *Server) writeError(id string, code int, message string) {
	resp := Response{
		ID: id,
		Error: &Error{
			Code:    code,
			Message: message,
		},
	}
	s.writeResponse(resp)
}

func (s *Server) writeResponse(resp Response) {
	data, err := json.Marshal(resp)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error marshaling response: %v\n", err)
		return
	}
	fmt.Println(string(data))
}
