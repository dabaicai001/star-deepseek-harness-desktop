package adapters

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/rs/zerolog/log"
)

// DockerAdapter 封装 Docker 连接
type DockerAdapter struct {
	cli  *client.Client
	ctx  context.Context
	info *DockerConnInfo
}

// DockerConnInfo Docker 连接参数
type DockerConnInfo struct {
	Host       string `json:"host,omitempty"`
	APIVersion string `json:"apiVersion,omitempty"`
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
	ID       string   `json:"id"`
	Tags     []string `json:"tags"`
	Size     int64    `json:"size"`
	Created  int64    `json:"created"`
	Digest   string   `json:"digest,omitempty"`
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
	ctx := context.Background()
	opts := []client.Opt{client.FromEnv, client.WithAPIVersionNegotiation()}

	if info.Host != "" {
		opts = append(opts, client.WithHost(info.Host))
	}

	cli, err := client.NewClientWithOpts(opts...)
	if err != nil {
		return nil, fmt.Errorf("docker client create failed: %w", err)
	}

	// 测试连接
	_, err = cli.Ping(ctx)
	if err != nil {
		return nil, fmt.Errorf("docker connect failed: %w", err)
	}

	log.Info().Str("host", info.Host).Msg("docker connected")

	return &DockerAdapter{
		cli:  cli,
		ctx:  ctx,
		info: info,
	}, nil
}

// Close 关闭连接
func (a *DockerAdapter) Close() error {
	return a.cli.Close()
}

// Ping 检测连接
func (a *DockerAdapter) Ping() error {
	_, err := a.cli.Ping(a.ctx)
	return err
}

// ListContainers 列出容器
func (a *DockerAdapter) ListContainers(all bool) ([]ContainerInfo, error) {
	opts := container.ListOptions{All: all}
	containers, err := a.cli.ContainerList(a.ctx, opts)
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
	info, err := a.cli.ContainerInspect(a.ctx, containerID)
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
	return a.cli.ContainerStart(a.ctx, containerID, container.StartOptions{})
}

// StopContainer 停止容器
func (a *DockerAdapter) StopContainer(containerID string, timeout *int) error {
	opts := container.StopOptions{}
	if timeout != nil {
		opts.Timeout = timeout
	}
	return a.cli.ContainerStop(a.ctx, containerID, opts)
}

// RestartContainer 重启容器
func (a *DockerAdapter) RestartContainer(containerID string, timeout *int) error {
	opts := container.StopOptions{}
	if timeout != nil {
		opts.Timeout = timeout
	}
	return a.cli.ContainerRestart(a.ctx, containerID, opts)
}

// RemoveContainer 删除容器
func (a *DockerAdapter) RemoveContainer(containerID string, force bool) error {
	opts := container.RemoveOptions{Force: force}
	return a.cli.ContainerRemove(a.ctx, containerID, opts)
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

	reader, err := a.cli.ContainerLogs(a.ctx, containerID, opts)
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
	statsResp, err := a.cli.ContainerStatsOneShot(a.ctx, containerID)
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
	images, err := a.cli.ImageList(a.ctx, opts)
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
	reader, err := a.cli.ImagePull(a.ctx, imageName, image.PullOptions{})
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

	return lastLine, nil
}

// RemoveImage 删除镜像
func (a *DockerAdapter) RemoveImage(imageID string, force bool) ([]image.DeleteResponse, error) {
	opts := image.RemoveOptions{Force: force}
	return a.cli.ImageRemove(a.ctx, imageID, opts)
}

// PruneImages 清理悬空镜像
func (a *DockerAdapter) PruneImages() (image.PruneReport, error) {
	filterArgs := filters.NewArgs()
	filterArgs.Add("dangling", "true")
	return a.cli.ImagesPrune(a.ctx, filterArgs)
}

// PruneContainers 清理已停止的容器
func (a *DockerAdapter) PruneContainers() (container.PruneReport, error) {
	return a.cli.ContainersPrune(a.ctx, filters.NewArgs())
}
