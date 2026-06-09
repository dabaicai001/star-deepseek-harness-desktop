pub mod ops;
pub mod session;
pub mod transfer;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: u32,
    pub modified: i64,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpSessionInfo {
    pub session_id: String,
    pub remote_root: String,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferFile {
    pub name: String,
    pub size: u64,
    pub transferred: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTask {
    pub id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub files: Vec<TransferFile>,
    pub status: TransferStatus,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub speed_limit: u64,
    pub error: Option<String>,
    pub upload_local_paths: Option<Vec<String>>,
    pub upload_remote_dir: Option<String>,
    pub download_remote_paths: Option<Vec<String>>,
    pub download_local_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub file_name: String,
    pub transferred: u64,
    pub total: u64,
    pub direction: TransferDirection,
}
