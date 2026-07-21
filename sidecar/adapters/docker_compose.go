package adapters

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
	"github.com/starhub/sidecar/pool"
)

// composeCmdTimeout 限制 docker compose 子进程最长执行时间(up 可能拉取镜像)
const composeCmdTimeout = 30 * time.Minute

// composeFileNames docker compose 默认查找的文件名（按优先级）
var composeFileNames = []string{"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"}

// findComposeFile 在 workDir 中查找 compose 文件路径，找不到则返回 docker-compose.yml 兜底（由 docker compose 报错）。
func findComposeFile(workDir string) string {
	for _, name := range composeFileNames {
		path := filepath.Join(workDir, name)
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return filepath.Join(workDir, "docker-compose.yml")
}

// runComposeCmd 在 workDir 下执行 docker compose 子命令，返回合并的 stdout+stderr。
func runComposeCmd(workDir string, args []string) (string, error) {
	fullArgs := append([]string{"compose"}, args...)
	ctx, cancel := context.WithTimeout(context.Background(), composeCmdTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", fullArgs...)
	cmd.Dir = workDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("docker compose failed: %w", err)
	}
	log.Debug().Str("workDir", workDir).Strs("args", args).Msg("docker compose executed")
	return string(output), nil
}

// ComposeUp 执行 docker compose up -d [serviceName]
func ComposeUp(workDir string, serviceName string) (string, error) {
	args := []string{"up", "-d"}
	if serviceName != "" {
		args = append(args, serviceName)
	}
	return runComposeCmd(workDir, args)
}

// ComposeDown 执行 docker compose down
func ComposeDown(workDir string) (string, error) {
	return runComposeCmd(workDir, []string{"down"})
}

// ComposePs 执行 docker compose ps --format json，返回解析后的 JSON。
func ComposePs(workDir string) (interface{}, error) {
	output, err := runComposeCmd(workDir, []string{"ps", "--format", "json"})
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(output)
	// docker compose ps --format json 可能返回 JSON 数组或换行分隔的 JSON 对象
	var result interface{}
	if jsonErr := json.Unmarshal([]byte(trimmed), &result); jsonErr == nil {
		return result, nil
	}
	// 尝试按行解析 NDJSON
	lines := strings.Split(trimmed, "\n")
	var items []interface{}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var item interface{}
		if json.Unmarshal([]byte(line), &item) == nil {
			items = append(items, item)
		}
	}
	if len(items) > 0 {
		return items, nil
	}
	// 解析失败时返回原始输出
	return map[string]interface{}{"raw": output}, nil
}

// ComposeLogs 执行 docker compose logs [--tail N] [serviceName]
func ComposeLogs(workDir string, serviceName string, tail int) (string, error) {
	args := []string{"logs"}
	if tail > 0 {
		args = append(args, "--tail", fmt.Sprintf("%d", tail))
	}
	if serviceName != "" {
		args = append(args, serviceName)
	}
	return runComposeCmd(workDir, args)
}

// ComposeConfig 执行 docker compose config（验证配置并输出合并后的 YAML）
func ComposeConfig(workDir string) (string, error) {
	return runComposeCmd(workDir, []string{"config"})
}

// ComposeList 扫描 workDir 下的 docker-compose.yml/yaml 文件，返回完整路径列表。
func ComposeList(workDir string) ([]string, error) {
	entries, err := os.ReadDir(workDir)
	if err != nil {
		return nil, fmt.Errorf("read directory: %w", err)
	}
	var found []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		for _, cn := range composeFileNames {
			if name == cn {
				found = append(found, filepath.Join(workDir, name))
				break
			}
		}
	}
	return found, nil
}

// ─── Docker Compose Handlers ───

func handleDockerComposeUp(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			WorkDir     string `json:"workDir"`
			ServiceName string `json:"serviceName,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		if p.WorkDir == "" {
			return nil, fmt.Errorf("workDir is required")
		}
		output, err := ComposeUp(p.WorkDir, p.ServiceName)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"output": output}, nil
	}
}

func handleDockerComposeDown(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			WorkDir string `json:"workDir"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		if p.WorkDir == "" {
			return nil, fmt.Errorf("workDir is required")
		}
		output, err := ComposeDown(p.WorkDir)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"output": output}, nil
	}
}

func handleDockerComposePs(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			WorkDir string `json:"workDir"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		if p.WorkDir == "" {
			return nil, fmt.Errorf("workDir is required")
		}
		return ComposePs(p.WorkDir)
	}
}

func handleDockerComposeLogs(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			WorkDir     string `json:"workDir"`
			ServiceName string `json:"serviceName,omitempty"`
			Tail        int    `json:"tail,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		if p.WorkDir == "" {
			return nil, fmt.Errorf("workDir is required")
		}
		output, err := ComposeLogs(p.WorkDir, p.ServiceName, p.Tail)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"output": output}, nil
	}
}

func handleDockerComposeConfig(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			WorkDir string `json:"workDir"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		if p.WorkDir == "" {
			return nil, fmt.Errorf("workDir is required")
		}
		output, err := ComposeConfig(p.WorkDir)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"output": output}, nil
	}
}

func handleDockerComposeList(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			WorkDir string `json:"workDir"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		if p.WorkDir == "" {
			return nil, fmt.Errorf("workDir is required")
		}
		return ComposeList(p.WorkDir)
	}
}
