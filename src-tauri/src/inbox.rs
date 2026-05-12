use chrono::{Datelike, Local};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use crate::{
    create_record_internal, load_snapshot, normalize_workspace_path_public, stringify, write_json,
    AppResult, WorkspaceSnapshot,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxSourceFile {
    pub original_name: String,
    pub stored_path: String,
    pub size_bytes: u64,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    pub id: String,
    pub created_at: String,
    pub source_file: InboxSourceFile,
    pub pipeline: Option<Value>,
    pub user_decision: String, // "pending" | "confirmed" | "skipped"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxImportResult {
    pub inbox_id: String,
    pub stored_path: String,
    pub original_name: String,
    pub size_bytes: u64,
    pub mime_type: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn inbox_root(root: &Path) -> PathBuf {
    root.join("inbox")
}

fn pending_dir(root: &Path) -> PathBuf {
    inbox_root(root).join("pending")
}

fn sources_dir(root: &Path) -> PathBuf {
    inbox_root(root).join("sources")
}

fn processed_dir(root: &Path) -> PathBuf {
    inbox_root(root).join("processed")
}

fn processed_entry_path(root: &Path, entry: &InboxEntry) -> PathBuf {
    let month = entry.created_at.chars().take(7).collect::<String>();
    processed_dir(root)
        .join(month)
        .join(format!("{}.json", entry.id))
}

fn next_inbox_id(root: &Path) -> String {
    let now = Local::now();
    let prefix = format!("INB-{}-{:02}-{:02}", now.year(), now.month(), now.day());

    let mut highest = 0u32;
    let dir = pending_dir(root);
    if dir.exists() {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(stripped) = name.strip_suffix(".json") {
                    if stripped.strip_prefix(&prefix).is_some() {
                        if let Some(num_str) = stripped.rsplit('-').next() {
                            if let Ok(num) = num_str.parse::<u32>() {
                                if num > highest {
                                    highest = num;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // Also scan processed dirs
    let proc_root = processed_dir(root);
    let month_dir = format!("{}-{:02}", now.year(), now.month());
    let proc_month = proc_root.join(&month_dir);
    if proc_month.exists() {
        if let Ok(entries) = fs::read_dir(&proc_month) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(stripped) = name.strip_suffix(".json") {
                    if let Some(num_str) = stripped.rsplit('-').next() {
                        if let Ok(num) = num_str.parse::<u32>() {
                            if num > highest {
                                highest = num;
                            }
                        }
                    }
                }
            }
        }
    }

    format!("{}-{:03}", prefix, highest + 1)
}

fn guess_mime_type(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "zip" => "application/zip",
        "rar" => "application/x-rar-compressed",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn save_entry_json(root: &Path, entry: &InboxEntry) -> AppResult<()> {
    let dir = if entry.user_decision == "pending" {
        pending_dir(root)
    } else {
        let month = entry.created_at.chars().take(7).collect::<String>();
        processed_dir(root).join(&month)
    };
    fs::create_dir_all(&dir).map_err(stringify)?;
    let path = dir.join(format!("{}.json", entry.id));
    write_json(&path, entry)
}

fn move_source_to_dir(source_path: &Path, dest_dir: &Path) -> AppResult<PathBuf> {
    fs::create_dir_all(dest_dir).map_err(stringify)?;
    let file_name = source_path
        .file_name()
        .ok_or_else(|| "无法读取源文件名".to_string())?;
    let mut dest = dest_dir.join(file_name);
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
        for idx in 1..=999 {
            let candidate = dest_dir.join(format!("{}-{}{}", stem, idx, ext));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
    }
    fs::rename(source_path, &dest).map_err(stringify)?;
    Ok(dest)
}

fn resolve_attachments_dir_for_record(root: &Path, record_path: &Path) -> PathBuf {
    let abs = if record_path.is_absolute() {
        record_path.to_path_buf()
    } else {
        root.join(record_path)
    };
    let parent = abs.parent().unwrap_or(root);
    let file_name = abs.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let stem = abs.file_stem().and_then(|s| s.to_str()).unwrap_or("record");
    if file_name == "index.md" {
        parent.join("attachments")
    } else {
        parent.join(format!("{}-attachments", stem))
    }
}

fn read_entries_from_dir(dir: &Path) -> Vec<InboxEntry> {
    if !dir.exists() {
        return Vec::new();
    }
    let mut entries = Vec::new();
    if let Ok(read_dir) = fs::read_dir(dir) {
        for item in read_dir.flatten() {
            let path = item.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(entry) = serde_json::from_str::<InboxEntry>(&raw) {
                    entries.push(entry);
                }
            }
        }
    }
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    entries
}

fn update_hash(mut hash: u64, bytes: &[u8]) -> u64 {
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn content_hash_bytes(bytes: &[u8]) -> String {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    format!("{:016x}", update_hash(FNV_OFFSET, bytes))
}

fn content_hash_file(path: &Path) -> AppResult<String> {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    let file = fs::File::open(path).map_err(stringify)?;
    let mut reader = BufReader::new(file);
    let mut buffer = [0u8; 8192];
    let mut hash = FNV_OFFSET;
    loop {
        let read = reader.read(&mut buffer).map_err(stringify)?;
        if read == 0 {
            break;
        }
        hash = update_hash(hash, &buffer[..read]);
    }
    Ok(format!("{:016x}", hash))
}

fn find_existing_pending_entry(
    root: &Path,
    original_name: &str,
    size_bytes: u64,
    content_hash: &str,
) -> Option<InboxEntry> {
    read_entries_from_dir(&pending_dir(root))
        .into_iter()
        .find(|entry| {
            if entry.user_decision != "pending" {
                return false;
            }
            let source_exists = PathBuf::from(&entry.source_file.stored_path).exists();
            if !source_exists {
                return false;
            }
            entry
                .source_file
                .content_hash
                .as_deref()
                .map(|stored_hash| stored_hash == content_hash)
                .unwrap_or_else(|| {
                    entry.source_file.original_name == original_name
                        && entry.source_file.size_bytes == size_bytes
                })
        })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn inbox_import_file(
    workspace_path: String,
    source_path: String,
) -> AppResult<InboxImportResult> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(format!("源文件不存在：{}", source_path));
    }

    let original_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let dest_dir = sources_dir(&root);
    fs::create_dir_all(&dest_dir).map_err(stringify)?;

    let mut dest = dest_dir.join(&original_name);
    if dest.exists() {
        let stem = Path::new(&original_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file")
            .to_string();
        let ext = Path::new(&original_name)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| format!(".{}", s))
            .unwrap_or_default();
        for idx in 1..=999 {
            let candidate = dest_dir.join(format!("{}-{}{}", stem, idx, ext));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
    }

    fs::copy(&src, &dest).map_err(stringify)?;
    let metadata = fs::metadata(&dest).map_err(stringify)?;
    let mime_type = guess_mime_type(&original_name);
    let inbox_id = next_inbox_id(&root);

    Ok(InboxImportResult {
        inbox_id,
        stored_path: dest.to_string_lossy().to_string(),
        original_name,
        size_bytes: metadata.len(),
        mime_type,
    })
}

#[tauri::command]
pub fn inbox_list_pending(workspace_path: String) -> AppResult<Vec<InboxEntry>> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let pending_root = pending_dir(&root);
    let mut pending = Vec::new();
    for entry in read_entries_from_dir(&pending_root) {
        let pending_path = pending_root.join(format!("{}.json", entry.id));
        if entry.user_decision != "pending" || processed_entry_path(&root, &entry).exists() {
            let _ = fs::remove_file(pending_path);
            continue;
        }
        pending.push(entry);
    }
    Ok(pending)
}

#[tauri::command]
pub fn inbox_save_analysis(workspace_path: String, entry: InboxEntry) -> AppResult<()> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    save_entry_json(&root, &entry)
}

#[tauri::command]
pub fn inbox_confirm_create(
    workspace_path: String,
    inbox_id: String,
    module_key: String,
    fields: Map<String, Value>,
    body: String,
) -> AppResult<WorkspaceSnapshot> {
    let root = normalize_workspace_path_public(&workspace_path)?;

    // 1. Load inbox entry
    let pending_path = pending_dir(&root).join(format!("{}.json", inbox_id));
    if !pending_path.exists() {
        return Err(format!("收件箱条目不存在：{}", inbox_id));
    }
    let raw = fs::read_to_string(&pending_path).map_err(stringify)?;
    let mut entry: InboxEntry = serde_json::from_str(&raw).map_err(stringify)?;

    // 2. Create the record using the same path and ID logic as normal form saves.
    let (target, _) = create_record_internal(&root, &module_key, fields, body)?;

    // 3. Move source file to record's attachments
    let source_file_path = PathBuf::from(&entry.source_file.stored_path);
    if source_file_path.exists() {
        let attachments_dir = resolve_attachments_dir_for_record(&root, &target);
        let moved = move_source_to_dir(&source_file_path, &attachments_dir)?;
        entry.source_file.stored_path = moved.to_string_lossy().to_string();
    }

    // 4. Mark as confirmed and move to processed
    entry.user_decision = "confirmed".to_string();
    let processed_month_dir =
        processed_dir(&root).join(entry.created_at.chars().take(7).collect::<String>());
    fs::create_dir_all(&processed_month_dir).map_err(stringify)?;
    let processed_path = processed_month_dir.join(format!("{}.json", entry.id));
    write_json(&processed_path, &entry)?;

    // Remove from pending
    let _ = fs::remove_file(&pending_path);

    load_snapshot(&root)
}

#[tauri::command]
pub fn inbox_confirm_attach(
    workspace_path: String,
    inbox_id: String,
    target_record_id: String,
    target_module: String,
) -> AppResult<WorkspaceSnapshot> {
    let root = normalize_workspace_path_public(&workspace_path)?;

    // 1. Load inbox entry
    let pending_path = pending_dir(&root).join(format!("{}.json", inbox_id));
    if !pending_path.exists() {
        return Err(format!("收件箱条目不存在：{}", inbox_id));
    }
    let raw = fs::read_to_string(&pending_path).map_err(stringify)?;
    let mut entry: InboxEntry = serde_json::from_str(&raw).map_err(stringify)?;

    // 2. Find target record by ID — scan existing records
    let snapshot = load_snapshot(&root)?;
    let target_record = snapshot
        .records
        .iter()
        .find(|r| r.id == target_record_id && r.module == target_module);
    let record_path_str = match target_record {
        Some(record) => record
            .path
            .as_ref()
            .ok_or_else(|| format!("目标记录无路径：{}", target_record_id))?,
        None => return Err(format!("未找到目标记录：{}", target_record_id)),
    };
    let record_abs = root.join(record_path_str);
    if !record_abs.exists() {
        return Err(format!("目标记录文件不存在：{}", record_path_str));
    }

    // 3. Move source file to target record's attachments
    let source_file_path = PathBuf::from(&entry.source_file.stored_path);
    if source_file_path.exists() {
        let attachments_dir = resolve_attachments_dir_for_record(&root, &record_abs);
        let moved = move_source_to_dir(&source_file_path, &attachments_dir)?;
        entry.source_file.stored_path = moved.to_string_lossy().to_string();
    }

    // 4. Mark as confirmed and move to processed
    entry.user_decision = "confirmed".to_string();
    let processed_month_dir =
        processed_dir(&root).join(entry.created_at.chars().take(7).collect::<String>());
    fs::create_dir_all(&processed_month_dir).map_err(stringify)?;
    let processed_path = processed_month_dir.join(format!("{}.json", entry.id));
    write_json(&processed_path, &entry)?;

    // Remove from pending
    let _ = fs::remove_file(&pending_path);

    load_snapshot(&root)
}

#[tauri::command]
pub fn inbox_skip(workspace_path: String, inbox_id: String) -> AppResult<()> {
    let root = normalize_workspace_path_public(&workspace_path)?;

    let pending_path = pending_dir(&root).join(format!("{}.json", inbox_id));
    if !pending_path.exists() {
        return Err(format!("收件箱条目不存在：{}", inbox_id));
    }
    let raw = fs::read_to_string(&pending_path).map_err(stringify)?;
    let mut entry: InboxEntry = serde_json::from_str(&raw).map_err(stringify)?;

    entry.user_decision = "skipped".to_string();

    let processed_month_dir =
        processed_dir(&root).join(entry.created_at.chars().take(7).collect::<String>());
    fs::create_dir_all(&processed_month_dir).map_err(stringify)?;
    let processed_path = processed_month_dir.join(format!("{}.json", entry.id));
    write_json(&processed_path, &entry)?;

    let _ = fs::remove_file(&pending_path);

    Ok(())
}

#[tauri::command]
pub fn inbox_list_processed(workspace_path: String, month: String) -> AppResult<Vec<InboxEntry>> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let dir = processed_dir(&root).join(&month);
    Ok(read_entries_from_dir(&dir))
}

/// 读取收件箱中已存储文件的文本内容（供纯文本文件使用）
#[tauri::command]
pub fn inbox_read_file_text(stored_path: String) -> AppResult<String> {
    let path = PathBuf::from(&stored_path);
    if !path.is_file() {
        return Err(format!("文件不存在：{}", stored_path));
    }
    fs::read_to_string(&path).map_err(stringify)
}

/// 读取文件的 base64 编码字节（供前端处理 PDF/DOCX 等二进制格式）
#[tauri::command]
pub fn inbox_read_file_base64(stored_path: String) -> AppResult<String> {
    use base64::Engine;
    let path = PathBuf::from(&stored_path);
    if !path.is_file() {
        return Err(format!("文件不存在：{}", stored_path));
    }
    let bytes = fs::read(&path).map_err(stringify)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// 清空所有待处理的收件箱条目
#[tauri::command]
pub fn inbox_clear_all(workspace_path: String) -> AppResult<()> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let pending = pending_dir(&root);
    if pending.exists() {
        // 删除所有 pending JSON 和对应的源文件
        if let Ok(entries) = fs::read_dir(&pending) {
            for item in entries.flatten() {
                let json_path = item.path();
                if json_path.extension().and_then(|e| e.to_str()) == Some("json") {
                    // 尝试读取条目以获取源文件路径
                    if let Ok(raw) = fs::read_to_string(&json_path) {
                        if let Ok(entry) = serde_json::from_str::<InboxEntry>(&raw) {
                            let src = PathBuf::from(&entry.source_file.stored_path);
                            if src.exists() {
                                let _ = fs::remove_file(&src);
                            }
                        }
                    }
                    let _ = fs::remove_file(&json_path);
                }
            }
        }
    }
    // 清空 sources 目录
    let sources = sources_dir(&root);
    if sources.exists() {
        let _ = fs::remove_dir_all(&sources);
        let _ = fs::create_dir_all(&sources);
    }
    Ok(())
}

/// 从收件箱导入文件（通过文件路径，用于 Tauri 拖拽场景）
#[tauri::command]
pub fn inbox_import_file_by_path(
    workspace_path: String,
    source_path: String,
) -> AppResult<InboxEntry> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(format!("源文件不存在：{}", source_path));
    }

    let original_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
    let metadata = fs::metadata(&src).map_err(stringify)?;
    let content_hash = content_hash_file(&src)?;

    if let Some(existing) =
        find_existing_pending_entry(&root, &original_name, metadata.len(), &content_hash)
    {
        return Ok(existing);
    }

    let dest_dir = sources_dir(&root);
    fs::create_dir_all(&dest_dir).map_err(stringify)?;

    let mut dest = dest_dir.join(&original_name);
    if dest.exists() {
        let stem = Path::new(&original_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file")
            .to_string();
        let ext = Path::new(&original_name)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| format!(".{}", s))
            .unwrap_or_default();
        for idx in 1..=999 {
            let candidate = dest_dir.join(format!("{}-{}{}", stem, idx, ext));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
    }

    fs::copy(&src, &dest).map_err(stringify)?;
    let mime_type = guess_mime_type(&original_name);
    let inbox_id = next_inbox_id(&root);
    let now = Local::now();

    let entry = InboxEntry {
        id: inbox_id,
        created_at: now.format("%Y-%m-%dT%H:%M:%S").to_string(),
        source_file: InboxSourceFile {
            original_name,
            stored_path: dest.to_string_lossy().to_string(),
            size_bytes: metadata.len(),
            mime_type,
            content_hash: Some(content_hash),
        },
        pipeline: None,
        user_decision: "pending".to_string(),
    };

    save_entry_json(&root, &entry)?;
    Ok(entry)
}

/// 从字节数据导入文件（用于 webview 文件选择器，无法获取文件路径的场景）
#[tauri::command]
pub fn inbox_import_from_bytes(
    workspace_path: String,
    file_name: String,
    mime_type: String,
    file_bytes_base64: String,
) -> AppResult<InboxEntry> {
    use base64::Engine;
    let root = normalize_workspace_path_public(&workspace_path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&file_bytes_base64)
        .map_err(|e| format!("base64 解码失败：{}", e))?;
    let content_hash = content_hash_bytes(&bytes);

    if let Some(existing) =
        find_existing_pending_entry(&root, &file_name, bytes.len() as u64, &content_hash)
    {
        return Ok(existing);
    }

    let dest_dir = sources_dir(&root);
    fs::create_dir_all(&dest_dir).map_err(stringify)?;

    let mut dest = dest_dir.join(&file_name);
    if dest.exists() {
        let stem = Path::new(&file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file")
            .to_string();
        let ext = Path::new(&file_name)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| format!(".{}", s))
            .unwrap_or_default();
        for idx in 1..=999 {
            let candidate = dest_dir.join(format!("{}-{}{}", stem, idx, ext));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
    }

    fs::write(&dest, &bytes).map_err(stringify)?;
    let inbox_id = next_inbox_id(&root);
    let now = Local::now();

    let entry = InboxEntry {
        id: inbox_id,
        created_at: now.format("%Y-%m-%dT%H:%M:%S").to_string(),
        source_file: InboxSourceFile {
            original_name: file_name,
            stored_path: dest.to_string_lossy().to_string(),
            size_bytes: bytes.len() as u64,
            mime_type,
            content_hash: Some(content_hash),
        },
        pipeline: None,
        user_decision: "pending".to_string(),
    };

    save_entry_json(&root, &entry)?;
    Ok(entry)
}

/// 更新收件箱条目的 pipeline 结果
#[tauri::command]
pub fn inbox_update_pipeline(
    workspace_path: String,
    inbox_id: String,
    pipeline: Value,
) -> AppResult<()> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let pending_path = pending_dir(&root).join(format!("{}.json", inbox_id));
    if !pending_path.exists() {
        return Err(format!("收件箱条目不存在：{}", inbox_id));
    }
    let raw = fs::read_to_string(&pending_path).map_err(stringify)?;
    let mut entry: InboxEntry = serde_json::from_str(&raw).map_err(stringify)?;
    entry.pipeline = Some(pipeline);
    save_entry_json(&root, &entry)
}

/// 更新收件箱条目状态
#[tauri::command]
pub fn inbox_update_status(
    workspace_path: String,
    inbox_id: String,
    status: String,
) -> AppResult<()> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let pending_path = pending_dir(&root).join(format!("{}.json", inbox_id));
    if !pending_path.exists() {
        return Err(format!("收件箱条目不存在：{}", inbox_id));
    }
    let raw = fs::read_to_string(&pending_path).map_err(stringify)?;
    let mut entry: InboxEntry = serde_json::from_str(&raw).map_err(stringify)?;
    entry.user_decision = status;
    let is_pending = entry.user_decision == "pending";
    save_entry_json(&root, &entry)?;
    if !is_pending {
        let _ = fs::remove_file(&pending_path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "legalbiz-inbox-test-{}-{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn confirm_create_writes_record_to_target_module_and_processes_entry() {
        let root = temp_workspace();
        crate::workspace::create_workspace_dirs(&root).expect("create workspace dirs");
        let workspace_path = root.to_string_lossy().to_string();
        let file_bytes = "案号：(2026)沪0105民初1234号\n法院：上海市长宁区人民法院".as_bytes();
        let entry = inbox_import_from_bytes(
            workspace_path.clone(),
            "起诉状.txt".into(),
            "text/plain".into(),
            base64::engine::general_purpose::STANDARD.encode(file_bytes),
        )
        .expect("import inbox file");
        let processed_month = entry.created_at.chars().take(7).collect::<String>();
        let mut fields = Map::new();
        fields.insert("title".into(), json!("岚山科技诉北辰贸易服务合同纠纷"));
        fields.insert("case_number".into(), json!("(2026)沪0105民初1234号"));
        fields.insert("opened_at".into(), json!("2026-05-12"));

        let snapshot = inbox_confirm_create(
            workspace_path,
            entry.id.clone(),
            "litigation".into(),
            fields,
            "由智能收件箱确认创建。".into(),
        )
        .expect("confirm create");

        let record = snapshot
            .records
            .iter()
            .find(|record| {
                record.module == "litigation" && record.title == "岚山科技诉北辰贸易服务合同纠纷"
            })
            .expect("created litigation record appears in snapshot");
        let record_path = root.join(record.path.as_ref().expect("record path"));
        assert!(record_path.is_file());
        assert!(record_path
            .parent()
            .unwrap()
            .join("06待办与期限")
            .join("待整理清单.md")
            .is_file());
        assert!(record_path
            .parent()
            .unwrap()
            .join("attachments")
            .join("起诉状.txt")
            .is_file());
        assert!(!root
            .join("inbox/pending")
            .join(format!("{}.json", entry.id))
            .exists());
        assert!(root
            .join("inbox/processed")
            .join(processed_month)
            .join(format!("{}.json", entry.id))
            .is_file());

        let _ = fs::remove_dir_all(root);
    }
}
