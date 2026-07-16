package adapters

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/rs/zerolog/log"
	"golang.org/x/crypto/ssh"
)

// DockerAdapter 封装 Docker 连接
type DockerAdapter struct {
	cli          *client.Client
	info         *DockerConnInfo
	transport    *http.Transport
	sshClients   []*ssh.Client
	execMu       sync.RWMutex
	execSessions map[string]*dockerExecSession
}

// DockerConnInfo Docker 连接参数
type DockerConnInfo struct {
	Host       string           `json:"host,omitempty"`
	APIVersion string           `json:"apiVersion,omitempty"`
	Transport  string           `json:"transport,omitempty"`
	SocketPath string           `json:"socketPath,omitempty"`
	SSH        *DockerSSHConfig `json:"ssh,omitempty"`
}

// ContainerInfo 容器信息
type ContainerInfo struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Image   string            `json:"image"`
	State   string            `json:"state"`
	Status  string            `json:"status"`
	Created int64             `json:"created"`
	Ports   []PortInfo        `json:"ports"`
	Labels  map[string]string `json:"labels"`
}

// PortInfo 端口信息
type PortInfo struct {
	Private int    `json:"private"`
	Public  int    `json:"public,omitempty"`
	Type    string `json:"type"`
}

// ImageInfo 镜像信息
type ImageInfo struct {
	ID      string   `json:"id"`
	Tags    []string `json:"tags"`
	Size    int64    `json:"size"`
	Created int64    `json:"created"`
	Digest  string   `json:"digest,omitempty"`
}

// ContainerStats 容器资源统计
type ContainerStats struct {
	CPUPercent    float64 `json:"cpuPercent"`
	MemoryUsage   int64   `json:"memoryUsage"`
	MemoryLimit   int64   `json:"memoryLimit"`
	MemoryPercent float64 `json:"memoryPercent"`
	NetRx         int64   `json:"netRx"`
	NetTx         int64   `json:"netTx"`
	BlockRead     int64   `json:"blockRead"`
	BlockWrite    int64   `json:"blockWrite"`
	PIDs          int     `json:"pids"`
}

// LogEntry 日志条目
type LogEntry struct {
	Timestamp string `json:"timestamp"`
	Stream    string `json:"stream"`
	Message   string `json:"message"`
}

// NewDockerAdapter 创建 Docker 适配器
func NewDockerAdapter(info *DockerConnInfo) (*DockerAdapter, error) {
	opts := []client.Opt{client.FromEnv, client.WithAPIVersionNegotiation()}
	var httpTransport *http.Transport
	var sshClients []*ssh.Client

	if info.Transport == "ssh" {
		transport, clients, err := newDockerSSHTransport(info)
		if err != nil {
			return nil, err
		}
		httpTransport = transport
		sshClients = clients
		opts = append(opts,
			client.WithHost("http://docker-over-ssh"),
			client.WithHTTPClient(&http.Client{Transport: transport}),
		)
	} else if info.Host != "" {
		opts = append(opts, client.WithHost(info.Host))
	}

	cli, err := client.NewClientWithOpts(opts...)
	if err != nil {
		closeSSHClients(sshClients)
		return nil, fmt.Errorf("docker client create failed: %w", err)
	}

	// 测试连接
	pingCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err = cli.Ping(pingCtx)
	if err != nil {
		_ = cli.Close()
		if httpTransport != nil {
			httpTransport.CloseIdleConnections()
		}
		closeSSHClients(sshClients)
		return nil, fmt.Errorf("docker connect failed: %w", err)
	}

	log.Info().Str("host", info.Host).Msg("docker connected")

	return &DockerAdapter{
		cli:          cli,
		info:         info,
		transport:    httpTransport,
		sshClients:   sshClients,
		execSessions: make(map[string]*dockerExecSession),
	}, nil
}

// Close 关闭连接
func (a *DockerAdapter) Close() error {
	a.closeExecSessions()
	err := a.cli.Close()
	if a.transport != nil {
		a.transport.CloseIdleConnections()
	}
	closeSSHClients(a.sshClients)
	return err
}

// Ping 检测连接
func (a *DockerAdapter) Ping() error {
	_, err := a.cli.Ping(context.Background())
	return err
}

// ListContainers 列出容器
func (a *DockerAdapter) ListContainers(all bool) ([]ContainerInfo, error) {
	opts := container.ListOptions{All: all}
	containers, err := a.cli.ContainerList(context.Background(), opts)
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}

	result := make([]ContainerInfo, 0, len(containers))
	for _, c := range containers {
		ports := make([]PortInfo, 0, len(c.Ports))
		for _, p := range c.Ports {
			ports = append(ports, PortInfo{
				Private: int(p.PrivatePort),
				Public:  int(p.PublicPort),
				Type:    p.Type,
			})
		}

		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}

		result = append(result, ContainerInfo{
			ID:      c.ID[:12],
			Name:    name,
			Image:   c.Image,
			State:   c.State,
			Status:  c.Status,
			Created: c.Created,
			Ports:   ports,
			Labels:  c.Labels,
		})
	}

	return result, nil
}

// InspectContainer 获取容器详情
func (a *DockerAdapter) InspectContainer(containerID string) (map[string]interface{}, error) {
	info, err := a.cli.ContainerInspect(context.Background(), containerID)
	if err != nil {
		return nil, fmt.Errorf("inspect container: %w", err)
	}

	data, err := json.Marshal(info)
	if err != nil {
		return nil, err
	}

	var result map[string]interface{}
	json.Unmarshal(data, &result)
	return result, nil
}

// StartContainer 启动容器
func (a *DockerAdapter) StartContainer(containerID string) error {
	return a.cli.ContainerStart(context.Background(), containerID, container.StartOptions{})
}

// StopContainer 停止容器
func (a *DockerAdapter) StopContainer(containerID string, timeout *int) error {
	opts := container.StopOptions{}
	if timeout != nil {
		opts.Timeout = timeout
	}
	return a.cli.ContainerStop(context.Background(), containerID, opts)
}

// RestartContainer 重启容器
func (a *DockerAdapter) RestartContainer(containerID string, timeout *int) error {
	opts := container.StopOptions{}
	if timeout != nil {
		opts.Timeout = timeout
	}
	return a.cli.ContainerRestart(context.Background(), containerID, opts)
}

// RemoveContainer 删除容器
func (a *DockerAdapter) RemoveContainer(containerID string, force bool) error {
	opts := container.RemoveOptions{Force: force}
	return a.cli.ContainerRemove(context.Background(), containerID, opts)
}

// ContainerLogs 获取容器日志
func (a *DockerAdapter) ContainerLogs(containerID string, tail string, follow bool) ([]LogEntry, error) {
	if tail == "" {
		tail = "100"
	}

	opts := container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Timestamps: true,
		Tail:       tail,
		Follow:     false, // 我们不支持流式，只获取一次
	}

	reader, err := a.cli.ContainerLogs(context.Background(), containerID, opts)
	if err != nil {
		return nil, fmt.Errorf("container logs: %w", err)
	}
	defer reader.Close()

	var entries []LogEntry
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) < 8 {
			continue
		}

		// Docker 日志格式: 8 字节头 + 内容
		stream := "stdout"
		if line[0] == 2 {
			stream = "stderr"
		}

		// 尝试解析时间戳
		msg := line[8:]
		timestamp := ""
		parts := strings.SplitN(msg, " ", 2)
		if len(parts) == 2 {
			if _, err := time.Parse(time.RFC3339Nano, parts[0]); err == nil {
				timestamp = parts[0]
				msg = parts[1]
			}
		}

		entries = append(entries, LogEntry{
			Timestamp: timestamp,
			Stream:    stream,
			Message:   msg,
		})
	}

	return entries, nil
}

// ContainerStats 获取容器资源统计
func (a *DockerAdapter) ContainerStats(containerID string) (*ContainerStats, error) {
	statsResp, err := a.cli.ContainerStatsOneShot(context.Background(), containerID)
	if err != nil {
		return nil, fmt.Errorf("container stats: %w", err)
	}
	defer statsResp.Body.Close()

	var stats container.StatsResponse
	if err := json.NewDecoder(statsResp.Body).Decode(&stats); err != nil {
		return nil, fmt.Errorf("decode stats: %w", err)
	}

	// CPU 使用率计算
	cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(stats.CPUStats.SystemUsage - stats.PreCPUStats.SystemUsage)
	cpuPercent := 0.0
	if systemDelta > 0 && cpuDelta >= 0 {
		cpuPercent = (cpuDelta / systemDelta) * float64(len(stats.CPUStats.CPUUsage.PercpuUsage)) * 100.0
	}

	// 内存
	memUsage := stats.MemoryStats.Usage
	memLimit := stats.MemoryStats.Limit
	memPercent := 0.0
	if memLimit > 0 {
		memPercent = float64(memUsage) / float64(memLimit) * 100.0
	}

	// 网络
	var netRx, netTx int64
	for _, net := range stats.Networks {
		netRx += int64(net.RxBytes)
		netTx += int64(net.TxBytes)
	}

	// Block I/O
	var blockRead, blockWrite int64
	for _, bio := range stats.BlkioStats.IoServiceBytesRecursive {
		switch strings.ToLower(bio.Op) {
		case "read":
			blockRead += int64(bio.Value)
		case "write":
			blockWrite += int64(bio.Value)
		}
	}

	return &ContainerStats{
		CPUPercent:    cpuPercent,
		MemoryUsage:   int64(memUsage),
		MemoryLimit:   int64(memLimit),
		MemoryPercent: memPercent,
		NetRx:         netRx,
		NetTx:         netTx,
		BlockRead:     blockRead,
		BlockWrite:    blockWrite,
		PIDs:          int(stats.PidsStats.Current),
	}, nil
}

// ListImages 列出镜像
func (a *DockerAdapter) ListImages(all bool) ([]ImageInfo, error) {
	opts := image.ListOptions{All: all}
	images, err := a.cli.ImageList(context.Background(), opts)
	if err != nil {
		return nil, fmt.Errorf("list images: %w", err)
	}

	result := make([]ImageInfo, 0, len(images))
	for _, img := range images {
		tags := img.RepoTags
		if tags == nil {
			tags = []string{}
		}

		result = append(result, ImageInfo{
			ID:      img.ID[:19],
			Tags:    tags,
			Size:    img.Size,
			Created: img.Created,
		})
	}

	return result, nil
}

// PullImage 拉取镜像
func (a *DockerAdapter) PullImage(imageName string) (string, error) {
	reader, err := a.cli.ImagePull(context.Background(), imageName, image.PullOptions{})
	if err != nil {
		return "", fmt.Errorf("pull image: %w", err)
	}
	defer reader.Close()

	// 读取所有输出
	var lastLine string
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		lastLine = scanner.Text()
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("scan pull image: %w", err)
	}

	return lastLine, nil
}

// RemoveImage 删除镜像
func (a *DockerAdapter) RemoveImage(imageID string, force bool) ([]image.DeleteResponse, error) {
	opts := image.RemoveOptions{Force: force}
	return a.cli.ImageRemove(context.Background(), imageID, opts)
}

// PruneImages 清理悬空镜像
func (a *DockerAdapter) PruneImages() (image.PruneReport, error) {
	filterArgs := filters.NewArgs()
	filterArgs.Add("dangling", "true")
	return a.cli.ImagesPrune(context.Background(), filterArgs)
}

// PruneContainers 清理已停止的容器
func (a *DockerAdapter) PruneContainers() (container.PruneReport, error) {
	return a.cli.ContainersPrune(context.Background(), filters.NewArgs())
}

// ExecResult 容器内 exec 结果
type ExecResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
}

const (
	dockerExecInspectInterval = 100 * time.Millisecond
	dockerExecDrainTimeout    = 250 * time.Millisecond
)

type dockerExecCopyResult struct {
	stdout string
	stderr string
	err    error
}

type dockerExecInspectFunc func(context.Context) (container.ExecInspect, error)

func copyDockerExecOutput(resp types.HijackedResponse) <-chan dockerExecCopyResult {
	result := make(chan dockerExecCopyResult, 1)
	go func() {
		var stdoutBuf bytes.Buffer
		var stderrBuf bytes.Buffer
		var err error

		mediaType, known := resp.MediaType()
		if known && mediaType == types.MediaTypeRawStream {
			_, err = io.Copy(&stdoutBuf, resp.Reader)
		} else {
			_, err = stdcopy.StdCopy(&stdoutBuf, &stderrBuf, resp.Reader)
		}
		result <- dockerExecCopyResult{
			stdout: stdoutBuf.String(),
			stderr: stderrBuf.String(),
			err:    err,
		}
	}()
	return result
}

func collectDockerExecResult(
	ctx context.Context,
	resp types.HijackedResponse,
	inspect dockerExecInspectFunc,
	inspectInterval time.Duration,
	drainTimeout time.Duration,
) (*ExecResult, error) {
	defer resp.Close()
	// StarHub 的 Exec 是逐条命令模式,不向容器写 stdin。显式半关闭写端,
	// 避免部分 Docker 传输持续等待输入而不结束 attach 流。
	_ = resp.CloseWrite()

	copyDone := copyDockerExecOutput(resp)
	ticker := time.NewTicker(inspectInterval)
	defer ticker.Stop()

	finish := func(copyResult dockerExecCopyResult, exitCode int, ignoreCopyError bool) (*ExecResult, error) {
		if copyResult.err != nil && !ignoreCopyError {
			return nil, fmt.Errorf("docker exec read output: %w", copyResult.err)
		}
		return &ExecResult{
			Stdout:   copyResult.stdout,
			Stderr:   copyResult.stderr,
			ExitCode: exitCode,
		}, nil
	}

	for {
		select {
		case copyResult := <-copyDone:
			status, err := inspect(ctx)
			if err != nil {
				return nil, fmt.Errorf("docker exec inspect: %w", err)
			}
			return finish(copyResult, status.ExitCode, false)

		case <-ticker.C:
			status, err := inspect(ctx)
			if err != nil {
				resp.Close()
				<-copyDone
				return nil, fmt.Errorf("docker exec inspect: %w", err)
			}
			// Pid > 0 区分“命令已经运行并退出”和 attach 刚建立、进程尚未启动。
			if status.Running || status.Pid <= 0 {
				continue
			}

			drainTimer := time.NewTimer(drainTimeout)
			select {
			case copyResult := <-copyDone:
				if !drainTimer.Stop() {
					<-drainTimer.C
				}
				return finish(copyResult, status.ExitCode, false)
			case <-drainTimer.C:
				// 某些 Docker/SSH 传输在 exec 已退出后仍不发送 EOF。关闭连接会
				// 解锁 stdcopy;此时关闭产生的读错误不代表命令执行失败。
				resp.Close()
				return finish(<-copyDone, status.ExitCode, true)
			case <-ctx.Done():
				if !drainTimer.Stop() {
					<-drainTimer.C
				}
				resp.Close()
				<-copyDone
				return nil, fmt.Errorf("docker exec: %w", ctx.Err())
			}

		case <-ctx.Done():
			resp.Close()
			<-copyDone
			return nil, fmt.Errorf("docker exec: %w", ctx.Err())
		}
	}
}

// Exec 在容器内执行命令
func (a *DockerAdapter) Exec(containerID string, command []string, workdir string, timeoutSec int) (*ExecResult, error) {
	if timeoutSec <= 0 {
		timeoutSec = 30
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	execConfig := container.ExecOptions{
		Cmd:          command,
		AttachStdout: true,
		AttachStderr: true,
		WorkingDir:   workdir,
	}

	execID, err := a.cli.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return nil, fmt.Errorf("docker exec create: %w", err)
	}

	resp, err := a.cli.ContainerExecAttach(ctx, execID.ID, container.ExecStartOptions{})
	if err != nil {
		return nil, fmt.Errorf("docker exec attach: %w", err)
	}

	return collectDockerExecResult(
		ctx,
		resp,
		func(inspectCtx context.Context) (container.ExecInspect, error) {
			return a.cli.ContainerExecInspect(inspectCtx, execID.ID)
		},
		dockerExecInspectInterval,
		dockerExecDrainTimeout,
	)
}

const (
	dockerExecSessionReadWait       = time.Second
	dockerExecSessionResizeTimeout  = 5 * time.Second
	dockerExecSessionMaxOutputBytes = 4 << 20
)

var dockerInteractiveShellCommand = []string{
	"/bin/sh",
	"-c",
	`if command -v bash >/dev/null 2>&1; then exec bash -i; ` +
		`elif command -v ash >/dev/null 2>&1; then exec ash -i; ` +
		`else exec sh -i; fi`,
}

// DockerExecSessionStartResult 描述新建的交互式容器 Shell 会话。
type DockerExecSessionStartResult struct {
	SessionID string `json:"sessionId"`
}

// DockerExecSessionReadResult 是一次长轮询读取到的终端字节与会话状态。
// Data 使用 []byte，让 JSON 以 base64 传输，避免无效 UTF-8 破坏 ANSI 流。
type DockerExecSessionReadResult struct {
	Data     []byte `json:"data"`
	Running  bool   `json:"running"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
}

type dockerExecSession struct {
	id       string
	execID   string
	resp     types.HijackedResponse
	ctx      context.Context
	cancel   context.CancelFunc
	inspect  dockerExecInspectFunc
	notify   chan struct{}
	done     chan struct{}
	writeMu  sync.Mutex
	outputMu sync.Mutex
	stateMu  sync.RWMutex
	output   bytes.Buffer
	running  bool
	exitCode *int
	readErr  string
	finish   sync.Once
	close    sync.Once
}

func newDockerExecSession(
	id string,
	execID string,
	ctx context.Context,
	cancel context.CancelFunc,
	resp types.HijackedResponse,
	inspect dockerExecInspectFunc,
) *dockerExecSession {
	session := &dockerExecSession{
		id:      id,
		execID:  execID,
		resp:    resp,
		ctx:     ctx,
		cancel:  cancel,
		inspect: inspect,
		notify:  make(chan struct{}, 1),
		done:    make(chan struct{}),
		running: true,
	}
	go session.readLoop()
	return session
}

func (s *dockerExecSession) readLoop() {
	defer s.closeResponse()
	buffer := make([]byte, 32*1024)
	for {
		n, err := s.resp.Reader.Read(buffer)
		if n > 0 {
			s.appendOutput(buffer[:n])
		}
		if err == nil {
			continue
		}

		var exitCode *int
		readErr := ""
		if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) && !errors.Is(err, context.Canceled) {
			readErr = fmt.Sprintf("docker exec read output: %v", err)
		}
		if s.ctx.Err() == nil {
			inspectCtx, cancel := context.WithTimeout(s.ctx, dockerExecSessionResizeTimeout)
			status, inspectErr := s.inspect(inspectCtx)
			cancel()
			if inspectErr != nil {
				if readErr == "" {
					readErr = fmt.Sprintf("docker exec inspect: %v", inspectErr)
				}
			} else {
				code := status.ExitCode
				exitCode = &code
			}
		}
		s.finishSession(exitCode, readErr)
		return
	}
}

func (s *dockerExecSession) appendOutput(data []byte) {
	s.outputMu.Lock()
	if len(data) >= dockerExecSessionMaxOutputBytes {
		s.output.Reset()
		_, _ = s.output.Write(data[len(data)-dockerExecSessionMaxOutputBytes:])
	} else {
		overflow := s.output.Len() + len(data) - dockerExecSessionMaxOutputBytes
		if overflow > 0 {
			s.output.Next(overflow)
		}
		_, _ = s.output.Write(data)
	}
	s.outputMu.Unlock()

	select {
	case s.notify <- struct{}{}:
	default:
	}
}

func (s *dockerExecSession) finishSession(exitCode *int, readErr string) {
	s.finish.Do(func() {
		s.stateMu.Lock()
		s.running = false
		s.exitCode = exitCode
		s.readErr = readErr
		s.stateMu.Unlock()
		s.cancel()
		close(s.done)
	})
}

func (s *dockerExecSession) closeResponse() {
	s.close.Do(func() {
		s.resp.Close()
	})
}

func (s *dockerExecSession) stop() {
	s.cancel()
	s.closeResponse()
	s.finishSession(nil, "")
}

func (s *dockerExecSession) snapshot() DockerExecSessionReadResult {
	s.outputMu.Lock()
	data := append([]byte{}, s.output.Bytes()...)
	s.output.Reset()
	s.outputMu.Unlock()

	s.stateMu.RLock()
	result := DockerExecSessionReadResult{
		Data:     data,
		Running:  s.running,
		ExitCode: s.exitCode,
		Error:    s.readErr,
	}
	s.stateMu.RUnlock()
	return result
}

func (s *dockerExecSession) read(wait time.Duration) DockerExecSessionReadResult {
	result := s.snapshot()
	if len(result.Data) > 0 || !result.Running || wait <= 0 {
		return result
	}

	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-s.notify:
	case <-s.done:
	case <-timer.C:
	}
	return s.snapshot()
}

func (s *dockerExecSession) write(data string) error {
	if data == "" {
		return nil
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	s.stateMu.RLock()
	running := s.running
	s.stateMu.RUnlock()
	if !running {
		return fmt.Errorf("docker exec session %s is not running", s.id)
	}
	if _, err := io.WriteString(s.resp.Conn, data); err != nil {
		return fmt.Errorf("docker exec write input: %w", err)
	}
	return nil
}

func newDockerExecSessionID() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("docker exec session id: %w", err)
	}
	return "docker-exec-" + hex.EncodeToString(random), nil
}

func normalizeDockerExecSize(cols int, rows int) (uint, uint) {
	if cols < 1 {
		cols = 120
	}
	if rows < 1 {
		rows = 30
	}
	return uint(cols), uint(rows)
}

// StartExecSession 进入容器并创建一个持久的交互式 TTY Shell。
func (a *DockerAdapter) StartExecSession(containerID string, cols int, rows int) (*DockerExecSessionStartResult, error) {
	if containerID == "" {
		return nil, fmt.Errorf("containerId is required")
	}
	width, height := normalizeDockerExecSize(cols, rows)
	consoleSize := [2]uint{height, width}
	ctx, cancel := context.WithCancel(context.Background())

	execConfig := container.ExecOptions{
		Cmd:          dockerInteractiveShellCommand,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		Tty:          true,
		ConsoleSize:  &consoleSize,
		Env:          []string{"TERM=xterm-256color", "COLORTERM=truecolor"},
	}
	execID, err := a.cli.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("docker exec session create: %w", err)
	}

	resp, err := a.cli.ContainerExecAttach(ctx, execID.ID, container.ExecStartOptions{
		Tty:         true,
		ConsoleSize: &consoleSize,
	})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("docker exec session attach: %w", err)
	}

	sessionID, err := newDockerExecSessionID()
	if err != nil {
		resp.Close()
		cancel()
		return nil, err
	}
	session := newDockerExecSession(
		sessionID,
		execID.ID,
		ctx,
		cancel,
		resp,
		func(inspectCtx context.Context) (container.ExecInspect, error) {
			return a.cli.ContainerExecInspect(inspectCtx, execID.ID)
		},
	)

	a.execMu.Lock()
	a.execSessions[sessionID] = session
	a.execMu.Unlock()
	return &DockerExecSessionStartResult{SessionID: sessionID}, nil
}

func (a *DockerAdapter) execSession(sessionID string) (*dockerExecSession, error) {
	a.execMu.RLock()
	session, ok := a.execSessions[sessionID]
	a.execMu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("docker exec session not found: %s", sessionID)
	}
	return session, nil
}

// ReadExecSession 长轮询读取交互式 Shell 输出。
func (a *DockerAdapter) ReadExecSession(sessionID string, wait time.Duration) (*DockerExecSessionReadResult, error) {
	session, err := a.execSession(sessionID)
	if err != nil {
		return nil, err
	}
	if wait < 0 || wait > dockerExecSessionReadWait {
		wait = dockerExecSessionReadWait
	}
	result := session.read(wait)
	return &result, nil
}

// WriteExecSession 把 xterm 原始输入写入交互式 Shell。
func (a *DockerAdapter) WriteExecSession(sessionID string, data string) error {
	session, err := a.execSession(sessionID)
	if err != nil {
		return err
	}
	return session.write(data)
}

// ResizeExecSession 同步 xterm 与容器 TTY 的行列数。
func (a *DockerAdapter) ResizeExecSession(sessionID string, cols int, rows int) error {
	session, err := a.execSession(sessionID)
	if err != nil {
		return err
	}
	width, height := normalizeDockerExecSize(cols, rows)
	ctx, cancel := context.WithTimeout(context.Background(), dockerExecSessionResizeTimeout)
	defer cancel()
	if err := a.cli.ContainerExecResize(ctx, session.execID, container.ResizeOptions{
		Width:  width,
		Height: height,
	}); err != nil {
		return fmt.Errorf("docker exec resize: %w", err)
	}
	return nil
}

// CloseExecSession 关闭并移除一个交互式 Shell 会话。
func (a *DockerAdapter) CloseExecSession(sessionID string) error {
	a.execMu.Lock()
	session, ok := a.execSessions[sessionID]
	if ok {
		delete(a.execSessions, sessionID)
	}
	a.execMu.Unlock()
	if !ok {
		return nil
	}
	session.stop()
	return nil
}

func (a *DockerAdapter) closeExecSessions() {
	a.execMu.Lock()
	sessions := make([]*dockerExecSession, 0, len(a.execSessions))
	for sessionID, session := range a.execSessions {
		sessions = append(sessions, session)
		delete(a.execSessions, sessionID)
	}
	a.execMu.Unlock()
	for _, session := range sessions {
		session.stop()
	}
}
