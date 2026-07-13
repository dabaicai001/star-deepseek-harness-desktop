package adapters

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
)

func TestCollectDockerExecResultClosesStaleAttachAfterProcessExit(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		stdout := stdcopy.NewStdWriter(serverConn, stdcopy.Stdout)
		_, _ = stdout.Write([]byte("bin\netc\nlib\n"))
		stderr := stdcopy.NewStdWriter(serverConn, stdcopy.Stderr)
		_, _ = stderr.Write([]byte("warning\n"))
		// 模拟 exec 已退出,但远端 attach 连接没有发送 EOF。
		_, _ = serverConn.Read(make([]byte, 1))
		_ = serverConn.Close()
	}()

	resp := types.NewHijackedResponse(clientConn, types.MediaTypeMultiplexedStream)
	started := time.Now()
	result, err := collectDockerExecResult(
		context.Background(),
		resp,
		func(context.Context) (container.ExecInspect, error) {
			return container.ExecInspect{Running: false, ExitCode: 0, Pid: 42}, nil
		},
		5*time.Millisecond,
		10*time.Millisecond,
	)
	if err != nil {
		t.Fatalf("collect result: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("stale attach took too long to close: %v", elapsed)
	}
	if result.Stdout != "bin\netc\nlib\n" || result.Stderr != "warning\n" || result.ExitCode != 0 {
		t.Fatalf("unexpected result: %#v", result)
	}
	<-writerDone
}

func TestCollectDockerExecResultCancelsBlockedRead(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer serverConn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	resp := types.NewHijackedResponse(clientConn, types.MediaTypeMultiplexedStream)
	started := time.Now()
	_, err := collectDockerExecResult(
		ctx,
		resp,
		func(context.Context) (container.ExecInspect, error) {
			return container.ExecInspect{Running: true, Pid: 42}, nil
		},
		5*time.Millisecond,
		10*time.Millisecond,
	)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want context deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("blocked read was not cancelled promptly: %v", elapsed)
	}
}

func TestCollectDockerExecResultSupportsRawStream(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	go func() {
		_, _ = serverConn.Write([]byte("plain tty output\n"))
		_ = serverConn.Close()
	}()

	resp := types.NewHijackedResponse(clientConn, types.MediaTypeRawStream)
	result, err := collectDockerExecResult(
		context.Background(),
		resp,
		func(context.Context) (container.ExecInspect, error) {
			return container.ExecInspect{Running: false, ExitCode: 7, Pid: 42}, nil
		},
		5*time.Millisecond,
		10*time.Millisecond,
	)
	if err != nil {
		t.Fatalf("collect raw stream: %v", err)
	}
	if result.Stdout != "plain tty output\n" || result.ExitCode != 7 {
		t.Fatalf("unexpected raw result: %#v", result)
	}
}
