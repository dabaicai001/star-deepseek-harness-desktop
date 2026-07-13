package adapters

import (
	"bytes"
	"context"
	"errors"
	"io"
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

func TestDockerExecSessionStreamsTTYInputAndOutput(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	resp := types.NewHijackedResponse(clientConn, types.MediaTypeRawStream)
	session := newDockerExecSession(
		"session-test",
		"exec-test",
		ctx,
		cancel,
		resp,
		func(context.Context) (container.ExecInspect, error) {
			return container.ExecInspect{Running: false, ExitCode: 0, Pid: 42}, nil
		},
	)
	t.Cleanup(func() {
		session.stop()
		_ = serverConn.Close()
	})

	serverErr := make(chan error, 1)
	go func() {
		if _, err := serverConn.Write([]byte("root@container:/# ")); err != nil {
			serverErr <- err
			return
		}
		input := make([]byte, len("pwd\r"))
		if _, err := io.ReadFull(serverConn, input); err != nil {
			serverErr <- err
			return
		}
		if !bytes.Equal(input, []byte("pwd\r")) {
			serverErr <- errors.New("unexpected terminal input")
			return
		}
		if _, err := serverConn.Write([]byte("pwd\r\n/\r\nroot@container:/# ")); err != nil {
			serverErr <- err
			return
		}
		serverErr <- serverConn.Close()
	}()

	first := session.read(500 * time.Millisecond)
	if string(first.Data) != "root@container:/# " || !first.Running {
		t.Fatalf("first read = %#v", first)
	}
	if err := session.write("pwd\r"); err != nil {
		t.Fatalf("write input: %v", err)
	}
	second := session.read(500 * time.Millisecond)
	if string(second.Data) != "pwd\r\n/\r\nroot@container:/# " {
		t.Fatalf("second read data = %q", second.Data)
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("server stream: %v", err)
	}

	deadline := time.Now().Add(500 * time.Millisecond)
	for second.Running && time.Now().Before(deadline) {
		second = session.read(20 * time.Millisecond)
	}
	if second.Running || second.ExitCode == nil || *second.ExitCode != 0 || second.Error != "" {
		t.Fatalf("finished session = %#v", second)
	}
}

func TestDockerExecSessionStopUnblocksLongPoll(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	session := newDockerExecSession(
		"session-stop",
		"exec-stop",
		ctx,
		cancel,
		types.NewHijackedResponse(clientConn, types.MediaTypeRawStream),
		func(context.Context) (container.ExecInspect, error) {
			return container.ExecInspect{}, nil
		},
	)
	defer serverConn.Close()

	resultCh := make(chan DockerExecSessionReadResult, 1)
	go func() {
		resultCh <- session.read(time.Second)
	}()
	time.Sleep(10 * time.Millisecond)
	session.stop()

	select {
	case result := <-resultCh:
		if result.Running {
			t.Fatalf("session still running after stop: %#v", result)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("long poll did not unblock after session stop")
	}
}

func TestNormalizeDockerExecSize(t *testing.T) {
	tests := []struct {
		name     string
		cols     int
		rows     int
		wantCols uint
		wantRows uint
	}{
		{name: "uses terminal size", cols: 160, rows: 48, wantCols: 160, wantRows: 48},
		{name: "defaults invalid size", cols: 0, rows: -1, wantCols: 120, wantRows: 30},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cols, rows := normalizeDockerExecSize(test.cols, test.rows)
			if cols != test.wantCols || rows != test.wantRows {
				t.Fatalf("size = %dx%d, want %dx%d", cols, rows, test.wantCols, test.wantRows)
			}
		})
	}
}
