package adapters

import (
	"encoding/json"
	"fmt"

	"github.com/starhub/sidecar/pool"
)

// handleBackupDatabase 处理 db.backup RPC
func handleBackupDatabase(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID     string `json:"connId"`
			Format     string `json:"format,omitempty"`
			OutputPath string `json:"outputPath"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		if p.ConnID == "" || p.OutputPath == "" {
			return nil, fmt.Errorf("connId and outputPath are required")
		}
		if err := BackupDatabase(mgr, p.ConnID, p.Format, p.OutputPath); err != nil {
			return nil, err
		}
		return map[string]interface{}{"ok": true, "path": p.OutputPath}, nil
	}
}

// handleRestoreDatabase 处理 db.restore RPC
func handleRestoreDatabase(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			InputPath string `json:"inputPath"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		if p.ConnID == "" || p.InputPath == "" {
			return nil, fmt.Errorf("connId and inputPath are required")
		}
		if err := RestoreDatabase(mgr, p.ConnID, p.InputPath); err != nil {
			return nil, err
		}
		return map[string]interface{}{"ok": true}, nil
	}
}

// handleListBackups 处理 db.listBackups RPC
func handleListBackups(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			BackupDir string `json:"backupDir"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		if p.BackupDir == "" {
			return nil, fmt.Errorf("backupDir is required")
		}
		return ListBackups(p.BackupDir)
	}
}
