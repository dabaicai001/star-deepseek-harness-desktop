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

#[cfg(target_os = "linux")]
fn open_with_default_app(path: &Path) -> std::io::Result<std::process::ExitStatus> {
    let mut last_status = None;
    for mut command in linux_open_commands(path) {
        match command.status() {
            Ok(status) if status.success() => return Ok(status),
            Ok(status) => last_status = Some(status),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        }
    }

    last_status.map_or_else(
        || {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "neither xdg-open nor gio is available",
            ))
        },
        Ok,
    )
}

#[cfg(target_os = "linux")]
fn linux_open_commands(path: &Path) -> Vec<Command> {
    let mut xdg_open = Command::new("xdg-open");
    xdg_open.arg(path);

    let mut gio_open = Command::new("gio");
    gio_open.arg("open").arg(path);

    vec![xdg_open, gio_open]
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn open_with_default_app(path: &Path) -> std::io::Result<std::process::ExitStatus> {
    Command::new("xdg-open").arg(path).status()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::linux_open_commands;
    use std::ffi::OsStr;
    use std::path::Path;

    #[test]
    fn linux_openers_fall_back_from_xdg_to_gio() {
        let commands = linux_open_commands(Path::new("/tmp/file with spaces.txt"));

        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].get_program(), OsStr::new("xdg-open"));
        assert_eq!(
            commands[0].get_args().collect::<Vec<_>>(),
            vec![OsStr::new("/tmp/file with spaces.txt")]
        );
        assert_eq!(commands[1].get_program(), OsStr::new("gio"));
        assert_eq!(
            commands[1].get_args().collect::<Vec<_>>(),
            vec![OsStr::new("open"), OsStr::new("/tmp/file with spaces.txt")]
        );
    }
}
