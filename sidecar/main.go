package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/starhub/sidecar/rpc"
)

func main() {
	// 日志输出到 stderr，不污染 stdout
	fmt.Fprintf(os.Stderr, "StarHub Sidecar starting...\n")

	server := rpc.NewServer()

	// 注册 ping 方法用于测试连接
	server.Register("ping", func(params json.RawMessage) (interface{}, error) {
		return "pong", nil
	})

	// 注册版本方法
	server.Register("version", func(params json.RawMessage) (interface{}, error) {
		return map[string]string{
			"version": "0.1.0",
			"go":      "1.22+",
		}, nil
	})

	fmt.Fprintf(os.Stderr, "StarHub Sidecar ready\n")

	if err := server.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Server error: %v\n", err)
		os.Exit(1)
	}
}
