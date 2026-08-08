pub mod ops;
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Queued,
    Running,
    /// 已暂停:worker 已退出但任务与断点偏移保留,可 resume 继续
    Paused,
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
    /// 上传任务的完整文件清单(本地路径, 远程相对路径, 大小),暂停后恢复用;
    /// 不序列化到前端(list_tasks 事件不携带)
    #[serde(skip)]
    pub upload_all_files: Option<Vec<(String, String, u64)>>,
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
