use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

type AppResult<T> = Result<T, String>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentEntry {
    pub name: String,
    pub size: u64,
    pub modified: String,
    pub absolute_path: String,
    pub kind: String,
}

/// 计算给定记录的附件目录：
///   `<dir>/index.md`   →  `<dir>/attachments`
///   `<dir>/<id>.md`    →  `<dir>/<id>-attachments`
fn resolve_attachments_dir(workspace_root: &Path, record_path: &str) -> PathBuf {
    let rel = Path::new(record_path);
    let abs = workspace_root.join(rel);
    let parent = abs.parent().unwrap_or(workspace_root).to_path_buf();
    let file_name = abs.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let stem = abs.file_stem().and_then(|s| s.to_str()).unwrap_or("record");
    if file_name == "index.md" {
        parent.join("attachments")
    } else {
        parent.join(format!("{}-attachments", stem))
    }
}

#[tauri::command]
pub fn record_attachments_dir(workspace_path: String, record_path: String) -> AppResult<String> {
    let root = crate::normalize_workspace_path_public(&workspace_path)?;
    let dir = resolve_attachments_dir(&root, &record_path);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_attachments(
    workspace_path: String,
    record_path: String,
) -> AppResult<Vec<AttachmentEntry>> {
    let root = crate::normalize_workspace_path_public(&workspace_path)?;
    let dir = resolve_attachments_dir(&root, &record_path);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<AttachmentEntry> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_file() {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let modified = metadata
            .modified()
            .ok()
            .map(|t| {
                let dt: chrono::DateTime<chrono::Local> = t.into();
                dt.format("%Y-%m-%d %H:%M").to_string()
            })
            .unwrap_or_default();
        let path = entry.path();
        let kind = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        entries.push(AttachmentEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            size: metadata.len(),
            modified,
            absolute_path: path.to_string_lossy().to_string(),
            kind,
        });
    }
    entries.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
pub fn add_attachments(
    workspace_path: String,
    record_path: String,
    src_paths: Vec<String>,
) -> AppResult<Vec<String>> {
    let root = crate::normalize_workspace_path_public(&workspace_path)?;
    let dir = resolve_attachments_dir(&root, &record_path);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut copied = Vec::new();
    for src in src_paths {
        let src_path = PathBuf::from(&src);
        if !src_path.is_file() {
            continue;
        }
        let file_name = src_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| format!("无法读取文件名：{}", src))?;
        let mut dest = dir.join(file_name);
        if dest.exists() {
            let stem = dest
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("file")
                .to_string();
            let ext = dest
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| format!(".{}", s))
                .unwrap_or_default();
            let mut idx = 1;
            loop {
                let candidate = dir.join(format!("{}-{}{}", stem, idx, ext));
                if !candidate.exists() {
                    dest = candidate;
                    break;
                }
                idx += 1;
                if idx > 999 {
                    break;
                }
            }
        }
        fs::copy(&src_path, &dest).map_err(|e| e.to_string())?;
        copied.push(dest.to_string_lossy().to_string());
    }
    Ok(copied)
}

#[tauri::command]
pub fn delete_attachment(
    workspace_path: String,
    record_path: String,
    name: String,
) -> AppResult<()> {
    let root = crate::normalize_workspace_path_public(&workspace_path)?;
    let dir = resolve_attachments_dir(&root, &record_path);
    let target = dir.join(&name);
    if !target.exists() {
        return Err("附件不存在".into());
    }
    let canon_dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let canon_target = target.canonicalize().map_err(|e| e.to_string())?;
    if !canon_target.starts_with(&canon_dir) {
        return Err("路径不在附件目录内".into());
    }
    fs::remove_file(&canon_target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_path_in_finder(path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{}", path));
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
