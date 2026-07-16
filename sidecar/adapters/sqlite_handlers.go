package adapters

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/starhub/sidecar/pool"
)

func handleSQLiteConnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info SQLiteConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid sqlite params: %w", err)
		}
		adapter, err := NewSQLiteAdapter(&info)
		if err != nil {
			return nil, err
		}
		connID := fmt.Sprintf("sqlite_%d", time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{
			ID:       connID,
			Type:     pool.ConnSQLite,
			Database: "main",
		})
		return map[string]interface{}{
			"connId":   connID,
			"filePath": info.FilePath,
			"database": "main",
		}, nil
	}
}

func handleSQLiteTest() Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info SQLiteConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid sqlite params: %w", err)
		}
		start := time.Now()
		adapter, err := NewSQLiteAdapter(&info)
		if err != nil {
			return map[string]interface{}{"ok": false, "message": err.Error()}, nil
		}
		defer adapter.Close()
		if err := adapter.Ping(); err != nil {
			return map[string]interface{}{"ok": false, "message": err.Error()}, nil
		}
		elapsed := time.Since(start).Milliseconds()
		return map[string]interface{}{
			"ok":         true,
			"message":    fmt.Sprintf("OK in %dms (sqlite:%s)", elapsed, info.FilePath),
			"elapsed_ms": elapsed,
		}, nil
	}
}
