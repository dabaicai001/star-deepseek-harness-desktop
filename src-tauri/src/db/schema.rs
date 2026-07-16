pub const CREATE_TABLES: &str = "
-- 资产分组
CREATE TABLE IF NOT EXISTS asset_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (parent_id) REFERENCES asset_groups(id) ON DELETE SET NULL
);

-- 资产（连接）
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('ssh', 'db', 'docker', 'excel')),
  name TEXT NOT NULL,
  group_id INTEGER,
  config_json TEXT NOT NULL DEFAULT '{}',
  key_id TEXT,
  tags TEXT DEFAULT '[]',
  favorite INTEGER DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (group_id) REFERENCES asset_groups(id) ON DELETE SET NULL
);

-- 密钥
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('password', 'private_key')),
  encrypted_data BLOB,
  keyring_ref TEXT,
  fingerprint TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 快捷指令
CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id INTEGER,
  command TEXT NOT NULL,
  description TEXT,
  variables TEXT DEFAULT '{}',
  scope TEXT CHECK(scope IN ('ssh', 'db', 'global')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- SQL 历史
CREATE TABLE IF NOT EXISTS sql_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conn_id TEXT,
  sql TEXT NOT NULL,
  executed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  duration_ms INTEGER,
  rows_affected INTEGER,
  success INTEGER DEFAULT 1
);

-- 设置
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 已知主机密钥 (TOFU)
CREATE TABLE IF NOT EXISTS known_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_key TEXT NOT NULL UNIQUE,
  key_type TEXT NOT NULL,
  sha256_fingerprint TEXT NOT NULL,
  public_key BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  session_id TEXT,
  asset_id TEXT,
  success INTEGER NOT NULL DEFAULT 1
);

-- 告警规则
CREATE TABLE IF NOT EXISTS alert_rule (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  category TEXT NOT NULL,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL,
  threshold REAL NOT NULL,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  webhook_url TEXT,
  cooldown_sec INTEGER NOT NULL DEFAULT 300,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
CREATE INDEX IF NOT EXISTS idx_assets_group_id ON assets(group_id);
CREATE INDEX IF NOT EXISTS idx_assets_favorite ON assets(favorite);
CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
CREATE INDEX IF NOT EXISTS idx_sql_history_conn_id ON sql_history(conn_id);
CREATE INDEX IF NOT EXISTS idx_sql_history_executed_at ON sql_history(executed_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_category ON audit_log(category);
CREATE INDEX IF NOT EXISTS idx_audit_log_asset_id ON audit_log(asset_id);
CREATE INDEX IF NOT EXISTS idx_alert_rule_enabled ON alert_rule(enabled);
CREATE INDEX IF NOT EXISTS idx_alert_rule_category ON alert_rule(category);
";
