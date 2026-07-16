package adapters

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/starhub/sidecar/pool"
)

func handleMSSQLConnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info MSSQLConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid mssql params: %w", err)
		}
		adapter, err := NewMSSQLAdapter(&info)
		if err != nil {
			return nil, err
		}
		connID := fmt.Sprintf("mssql_%s_%d_%d", info.Host, info.Port, time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{
			ID:       connID,
			Type:     pool.ConnMSSQL,
			Host:     info.Host,
			Port:     info.Port,
			Database: info.Database,
		})
		return map[string]interface{}{
			"connId":   connID,
			"host":     info.Host,
			"port":     info.Port,
			"database": info.Database,
		}, nil
	}
}

func handleMSSQLTest() Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info MSSQLConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid mssql params: %w", err)
		}
		start := time.Now()
		adapter, err := NewMSSQLAdapter(&info)
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
			"message":    fmt.Sprintf("OK in %dms (%s@%s:%d/%s)", elapsed, info.Username, info.Host, info.Port, info.Database),
			"elapsed_ms": elapsed,
		}, nil
	}
}
