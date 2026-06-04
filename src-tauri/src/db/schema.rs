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
  type TEXT NOT NULL CHECK(type IN ('ssh', 'db', 'docker')),
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

-- 索引
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
CREATE INDEX IF NOT EXISTS idx_assets_group_id ON assets(group_id);
CREATE INDEX IF NOT EXISTS idx_assets_favorite ON assets(favorite);
CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
CREATE INDEX IF NOT EXISTS idx_sql_history_conn_id ON sql_history(conn_id);
CREATE INDEX IF NOT EXISTS idx_sql_history_executed_at ON sql_history(executed_at);
";
