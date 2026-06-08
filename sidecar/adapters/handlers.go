package adapters

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/starhub/sidecar/pool"
	"github.com/starhub/sidecar/rpc"
)

// Handler 是 RPC 处理函数（复用 rpc 包的类型）
type Handler = rpc.Handler

// RegisterDBHandlers 注册所有数据库相关 RPC 方法
func RegisterDBHandlers(server ServerInterface, mgr *pool.Manager) {
	// MySQL
	server.Register("db.mysql.connect", handleMySQLConnect(mgr))
	server.Register("db.mysql.test", handleMySQLTest())
	server.Register("db.mysql.disconnect", handleDisconnect(mgr))
	server.Register("db.mysql.listDatabases", handleMySQLListDatabases(mgr))
	server.Register("db.mysql.listTables", handleMySQLListTables(mgr))
	server.Register("db.mysql.listColumns", handleMySQLListColumns(mgr))
	server.Register("db.mysql.listIndexes", handleMySQLListIndexes(mgr))
	server.Register("db.mysql.execute", handleMySQLExecute(mgr))
	server.Register("db.mysql.explain", handleMySQLExplain(mgr))
	server.Register("db.mysql.getTableDDL", handleMySQLGetTableDDL(mgr))
	server.Register("db.mysql.getTableData", handleMySQLGetTableData(mgr))
	server.Register("db.mysql.dropTable", handleMySQLDropTable(mgr))
	server.Register("db.mysql.truncateTable", handleMySQLTruncateTable(mgr))
	server.Register("db.mysql.renameTable", handleMySQLRenameTable(mgr))
	server.Register("db.mysql.insertRow", handleMySQLInsertRow(mgr))
	server.Register("db.mysql.updateRows", handleMySQLUpdateRows(mgr))
	server.Register("db.mysql.deleteRows", handleMySQLDeleteRows(mgr))
	server.Register("db.mysql.exportData", handleMySQLExportData(mgr))
	server.Register("db.mysql.getRowCount", handleMySQLGetRowCount(mgr))

	// Redis
	server.Register("db.redis.connect", handleRedisConnect(mgr))
	server.Register("db.redis.test", handleRedisTest())
	server.Register("db.redis.disconnect", handleDisconnect(mgr))
	server.Register("db.redis.select", handleRedisSelect(mgr))
	server.Register("db.redis.scan", handleRedisScan(mgr))
	server.Register("db.redis.getValue", handleRedisGetValue(mgr))
	server.Register("db.redis.del", handleRedisDel(mgr))
	server.Register("db.redis.rename", handleRedisRename(mgr))
	server.Register("db.redis.set", handleRedisSet(mgr))
	server.Register("db.redis.execute", handleRedisExecute(mgr))
	server.Register("db.redis.info", handleRedisInfo(mgr))
	server.Register("db.redis.dbSize", handleRedisDBSize(mgr))
}

// ServerInterface 定义 server 需要的方法（避免循环导入）
type ServerInterface interface {
	Register(method string, handler rpc.Handler)
}

// ─── MySQL Handlers ───

func handleMySQLConnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info MySQLConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		adapter, err := NewMySQLAdapter(&info)
		if err != nil {
			return nil, err
		}

		connID := fmt.Sprintf("mysql_%s_%d_%d", info.Host, info.Port, time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{
			ID:       connID,
			Type:     pool.ConnMySQL,
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

func handleMySQLTest() Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info MySQLConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		start := time.Now()
		adapter, err := NewMySQLAdapter(&info)
		if err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}
		defer adapter.Close()

		if err := adapter.Ping(); err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}

		elapsed := time.Since(start).Milliseconds()
		return map[string]interface{}{
			"ok":         true,
			"message":    fmt.Sprintf("OK in %dms (%s@%s:%d)", elapsed, info.Username, info.Host, info.Port),
			"elapsed_ms": elapsed,
		}, nil
	}
}

func handleDisconnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		return nil, mgr.Remove(p.ConnID)
	}
}

func getMySQLAdapter(mgr *pool.Manager, connID string) (*MySQLAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnMySQL {
		return nil, fmt.Errorf("connection %s is not MySQL (type=%s)", connID, info.Type)
	}
	return adapter.(*MySQLAdapter), nil
}

func handleMySQLListDatabases(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListDatabases()
	}
}

func handleMySQLListTables(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListTables(p.Database)
	}
}

func handleMySQLListColumns(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListColumns(p.Database, p.Table)
	}
}

func handleMySQLListIndexes(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListIndexes(p.Database, p.Table)
	}
}

func handleMySQLExecute(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			SQL      string `json:"sql"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		sql := p.SQL
		dbName := p.Database
		if dbName == "" {
			dbName = adapter.conn.Database
		}
		if dbName != "" && !strings.HasPrefix(strings.ToUpper(strings.TrimSpace(sql)), "USE ") {
			sql = fmt.Sprintf("USE `%s`; %s", dbName, sql)
		}
		return adapter.Execute(sql)
	}
}

func handleMySQLExplain(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			SQL      string `json:"sql"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		sql := p.SQL
		dbName := p.Database
		if dbName == "" {
			dbName = adapter.conn.Database
		}
		if dbName != "" && !strings.HasPrefix(strings.ToUpper(strings.TrimSpace(sql)), "USE ") {
			sql = fmt.Sprintf("USE `%s`; %s", dbName, sql)
		}
		return adapter.Explain(sql)
	}
}

func handleMySQLGetTableDDL(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		ddl, err := adapter.GetTableDDL(p.Database, p.Table)
		if err != nil {
			return nil, err
		}
		return map[string]string{"ddl": ddl}, nil
	}
}

func handleMySQLGetTableData(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
			Limit    int    `json:"limit,omitempty"`
			Offset   int    `json:"offset,omitempty"`
			OrderBy  string `json:"orderBy,omitempty"`
			OrderDir string `json:"orderDir,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetTableData(p.Database, p.Table, p.Limit, p.Offset, p.OrderBy, p.OrderDir)
	}
}

func handleMySQLDropTable(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
			IfExists bool   `json:"ifExists,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.DropTable(p.Database, p.Table, p.IfExists)
	}
}

func handleMySQLTruncateTable(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.TruncateTable(p.Database, p.Table)
	}
}

func handleMySQLRenameTable(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			OldName  string `json:"oldName"`
			NewName  string `json:"newName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.RenameTable(p.Database, p.OldName, p.NewName)
	}
}

func handleMySQLInsertRow(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string                 `json:"connId"`
			Database string                 `json:"database,omitempty"`
			Table    string                 `json:"table"`
			Values   map[string]interface{} `json:"values"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		id, err := adapter.InsertRow(p.Database, p.Table, p.Values)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"lastInsertId": id}, nil
	}
}

func handleMySQLUpdateRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string                 `json:"connId"`
			Database string                 `json:"database,omitempty"`
			Table    string                 `json:"table"`
			Sets     map[string]interface{} `json:"sets"`
			Where    string                 `json:"where"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		affected, err := adapter.UpdateRows(p.Database, p.Table, p.Sets, p.Where)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"rowsAffected": affected}, nil
	}
}

func handleMySQLDeleteRows(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
			Where    string `json:"where"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		affected, err := adapter.DeleteRows(p.Database, p.Table, p.Where)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"rowsAffected": affected}, nil
	}
}

func handleMySQLExportData(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
			Format   string `json:"format"` // csv, json, sql
			Limit    int    `json:"limit,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}

		switch p.Format {
		case "json":
			data, err := adapter.ExportJSON(p.Database, p.Table, p.Limit)
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"data": data, "format": "json"}, nil
		default: // csv
			result, err := adapter.ExportCSV(p.Database, p.Table, p.Limit)
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"result": result, "format": "csv"}, nil
		}
	}
}

func handleMySQLGetRowCount(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string `json:"connId"`
			Database string `json:"database,omitempty"`
			Table    string `json:"table"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getMySQLAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		count, err := adapter.GetRowCount(p.Database, p.Table)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"count": count}, nil
	}
}

// ─── Redis Handlers ───

func handleRedisConnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info RedisConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		adapter, err := NewRedisAdapter(&info)
		if err != nil {
			return nil, err
		}

		connID := fmt.Sprintf("redis_%s_%d_%d", info.Host, info.Port, time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{
			ID:       connID,
			Type:     pool.ConnRedis,
			Host:     info.Host,
			Port:     info.Port,
			Database: fmt.Sprintf("db%d", info.DB),
		})

		return map[string]interface{}{
			"connId": connID,
			"host":   info.Host,
			"port":   info.Port,
			"db":     info.DB,
		}, nil
	}
}

func handleRedisTest() Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info RedisConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		start := time.Now()
		adapter, err := NewRedisAdapter(&info)
		if err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}
		defer adapter.Close()

		if err := adapter.Ping(); err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}

		elapsed := time.Since(start).Milliseconds()
		return map[string]interface{}{
			"ok":         true,
			"message":    fmt.Sprintf("OK in %dms (redis@%s:%d/%d)", elapsed, info.Host, info.Port, info.DB),
			"elapsed_ms": elapsed,
		}, nil
	}
}

func getRedisAdapter(mgr *pool.Manager, connID string) (*RedisAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnRedis {
		return nil, fmt.Errorf("connection %s is not Redis (type=%s)", connID, info.Type)
	}
	return adapter.(*RedisAdapter), nil
}

func handleRedisSelect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			DB     int    `json:"db"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.Select(p.DB)
	}
}

func handleRedisScan(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Cursor uint64 `json:"cursor"`
			Match  string `json:"match,omitempty"`
			Count  int64  `json:"count,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.Scan(p.Cursor, p.Match, p.Count)
	}
}

func handleRedisGetValue(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Key    string `json:"key"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetValue(p.Key)
	}
}

func handleRedisDel(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string   `json:"connId"`
			Keys   []string `json:"keys"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		n, err := adapter.Del(p.Keys...)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"deleted": n}, nil
	}
}

func handleRedisRename(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			OldKey string `json:"oldKey"`
			NewKey string `json:"newKey"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.Rename(p.OldKey, p.NewKey)
	}
}

func handleRedisSet(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID     string `json:"connId"`
			Key        string `json:"key"`
			Value      string `json:"value"`
			Expiration int64  `json:"expiration"` // seconds, 0 = no expire
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		var exp time.Duration
		if p.Expiration > 0 {
			exp = time.Duration(p.Expiration) * time.Second
		}
		return nil, adapter.Set(p.Key, p.Value, exp)
	}
}

func handleRedisExecute(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID  string `json:"connId"`
			Command string `json:"command"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.Execute(p.Command)
	}
}

func handleRedisInfo(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID  string `json:"connId"`
			Section string `json:"section,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.RedisInfo(p.Section)
	}
}

func handleRedisDBSize(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		size, err := adapter.DBSize()
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"size": size}, nil
	}
}

// ─── Docker Handlers ───

// RegisterDockerHandlers 注册所有 Docker 相关 RPC 方法
func RegisterDockerHandlers(server ServerInterface, mgr *pool.Manager) {
	server.Register("docker.connect", handleDockerConnect(mgr))
	server.Register("docker.test", handleDockerTest())
	server.Register("docker.disconnect", handleDisconnect(mgr))
	server.Register("docker.listContainers", handleDockerListContainers(mgr))
	server.Register("docker.inspectContainer", handleDockerInspectContainer(mgr))
	server.Register("docker.startContainer", handleDockerStartContainer(mgr))
	server.Register("docker.stopContainer", handleDockerStopContainer(mgr))
	server.Register("docker.restartContainer", handleDockerRestartContainer(mgr))
	server.Register("docker.removeContainer", handleDockerRemoveContainer(mgr))
	server.Register("docker.containerLogs", handleDockerContainerLogs(mgr))
	server.Register("docker.containerStats", handleDockerContainerStats(mgr))
	server.Register("docker.listImages", handleDockerListImages(mgr))
	server.Register("docker.pullImage", handleDockerPullImage(mgr))
	server.Register("docker.removeImage", handleDockerRemoveImage(mgr))
	server.Register("docker.pruneImages", handleDockerPruneImages(mgr))
}

func getDockerAdapter(mgr *pool.Manager, connID string) (*DockerAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnDocker {
		return nil, fmt.Errorf("connection %s is not Docker (type=%s)", connID, info.Type)
	}
	return adapter.(*DockerAdapter), nil
}

func handleDockerConnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info DockerConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		adapter, err := NewDockerAdapter(&info)
		if err != nil {
			return nil, err
		}

		connID := fmt.Sprintf("docker_%d", time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{
			ID:   connID,
			Type: pool.ConnDocker,
			Host: info.Host,
		})

		return map[string]interface{}{
			"connId": connID,
			"host":   info.Host,
		}, nil
	}
}

func handleDockerTest() Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info DockerConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}

		start := time.Now()
		adapter, err := NewDockerAdapter(&info)
		if err != nil {
			return map[string]interface{}{
				"ok":      false,
				"message": err.Error(),
			}, nil
		}
		defer adapter.Close()

		elapsed := time.Since(start).Milliseconds()
		return map[string]interface{}{
			"ok":         true,
			"message":    fmt.Sprintf("OK in %dms", elapsed),
			"elapsed_ms": elapsed,
		}, nil
	}
}

func handleDockerListContainers(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			All    bool   `json:"all,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListContainers(p.All)
	}
}

func handleDockerInspectContainer(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.InspectContainer(p.ContainerID)
	}
}

func handleDockerStartContainer(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.StartContainer(p.ContainerID)
	}
}

func handleDockerStopContainer(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
			Timeout     *int   `json:"timeout,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.StopContainer(p.ContainerID, p.Timeout)
	}
}

func handleDockerRestartContainer(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
			Timeout     *int   `json:"timeout,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.RestartContainer(p.ContainerID, p.Timeout)
	}
}

func handleDockerRemoveContainer(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
			Force       bool   `json:"force,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return nil, adapter.RemoveContainer(p.ContainerID, p.Force)
	}
}

func handleDockerContainerLogs(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
			Tail        string `json:"tail,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ContainerLogs(p.ContainerID, p.Tail, false)
	}
}

func handleDockerContainerStats(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID      string `json:"connId"`
			ContainerID string `json:"containerId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ContainerStats(p.ContainerID)
	}
}

func handleDockerListImages(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			All    bool   `json:"all,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListImages(p.All)
	}
}

func handleDockerPullImage(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string `json:"connId"`
			ImageName string `json:"imageName"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		result, err := adapter.PullImage(p.ImageName)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"result": result}, nil
	}
}

func handleDockerRemoveImage(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID  string `json:"connId"`
			ImageID string `json:"imageId"`
			Force   bool   `json:"force,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.RemoveImage(p.ImageID, p.Force)
	}
}

func handleDockerPruneImages(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getDockerAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.PruneImages()
	}
}
