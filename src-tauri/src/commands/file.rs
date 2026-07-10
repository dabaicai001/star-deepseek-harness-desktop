use std::path::{Path, PathBuf};
use std::process::Command;

#[tauri::command]
pub fn open_file_external(path: String) -> Result<(), String> {
    let file_path = PathBuf::from(path);
    if !file_path.exists() {
        return Err("file does not exist".to_string());
    }
    if !file_path.is_file() {
        return Err("path is not a file".to_string());
    }

    let status =
        open_with_default_app(&file_path).map_err(|e| format!("open external file failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open external file exited with status: {status}"))
    }
}

#[cfg(target_os = "windows")]
fn open_with_default_app(path: &Path) -> std::io::Result<std::process::ExitStatus> {
    // explorer.exe is a GUI app that returns exit code 1 even on success.
    // Use `cmd /c start` instead which returns 0 on success.
    Command::new("cmd")
        .args(["/c", "start", "", &path.to_string_lossy()])
        .status()
}

#[cfg(target_os = "macos")]
fn open_with_default_app(path: &Path) -> std::io::Result<std::process::ExitStatus> {
    Command::new("open").arg(path).status()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_default_app(path: &Path) -> std::io::Result<std::process::ExitStatus> {
    Command::new("xdg-open").arg(path).status()
}
