package rpc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
)

// Handler 是 RPC 方法处理函数
type Handler func(params json.RawMessage) (interface{}, error)

// Server 是 JSON-RPC 服务器
type Server struct {
	mu       sync.RWMutex
	handlers map[string]Handler
	writeMu  sync.Mutex // 保护 stdout 写入
	writer   io.Writer
	wg       sync.WaitGroup
}

// NewServer 创建新的 RPC 服务器
func NewServer() *Server {
	return &Server{
		handlers: make(map[string]Handler),
		writer:   os.Stdout,
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
	return s.RunIO(os.Stdin, os.Stdout)
}

// RunIO runs the server with explicit streams, which keeps transport logic testable.
func (s *Server) RunIO(reader io.Reader, writer io.Writer) error {
	s.writer = writer
	scanner := bufio.NewScanner(reader)
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

		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handleRequest(req)
		}()
	}

	err := scanner.Err()
	s.wg.Wait()
	return err
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

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := fmt.Fprintln(s.writer, string(data)); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing response: %v\n", err)
	}
}
