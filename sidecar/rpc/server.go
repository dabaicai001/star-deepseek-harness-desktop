package rpc

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
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

// Methods returns a stable snapshot of all registered RPC method names.
func (s *Server) Methods() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	methods := make([]string, 0, len(s.handlers))
	for method := range s.handlers {
		methods = append(methods, method)
	}
	sort.Strings(methods)
	return methods
}

// Run 运行服务器，从 stdin 读取请求，输出到 stdout
func (s *Server) Run() error {
	return s.RunIO(os.Stdin, os.Stdout)
}

// maxRequestLineBytes 单条 RPC 请求行的最大字节数,防止异常输入撑爆内存。
const maxRequestLineBytes = 64 << 20

// RunIO runs the server with explicit streams, which keeps transport logic testable.
func (s *Server) RunIO(reader io.Reader, writer io.Writer) error {
	s.writer = writer
	bufReader := bufio.NewReaderSize(reader, 1<<20)

	for {
		data, tooLong, readErr := readRequestLine(bufReader)
		if tooLong {
			// 超限请求只回错误响应并继续服务,不能让整个 sidecar 进程退出。
			s.writeError("", ParseError, fmt.Sprintf("request exceeds %d bytes limit", maxRequestLineBytes))
		} else if len(bytes.TrimSpace(data)) > 0 {
			var req Request
			if err := json.Unmarshal(data, &req); err != nil {
				s.writeError("", ParseError, "Parse error: "+err.Error())
			} else {
				s.wg.Add(1)
				go func() {
					defer s.wg.Done()
					s.handleRequest(req)
				}()
			}
		}
		if readErr != nil {
			s.wg.Wait()
			if readErr == io.EOF {
				return nil
			}
			return readErr
		}
	}
}

// readRequestLine 读取一条以换行结尾的请求。超过 maxRequestLineBytes 的行
// 会被完整消耗并丢弃,返回 tooLong=true,由调用方回错误响应而不是终止循环。
func readRequestLine(reader *bufio.Reader) (line []byte, tooLong bool, err error) {
	var buf []byte
	for {
		frag, fragErr := reader.ReadSlice('\n')
		if !tooLong {
			buf = append(buf, frag...)
			if len(buf) > maxRequestLineBytes {
				tooLong = true
				buf = nil
			}
		}
		switch fragErr {
		case nil:
			return buf, tooLong, nil
		case bufio.ErrBufferFull:
			continue
		case io.EOF:
			if len(buf) > 0 {
				return buf, tooLong, nil
			}
			return nil, tooLong, io.EOF
		default:
			return nil, tooLong, fragErr
		}
	}
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
