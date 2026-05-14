use chrono::Local;
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

use crate::workspace::{render_markdown, safe_join_relative, split_frontmatter, stringify};
use crate::{normalize_workspace_path_public, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    pub related_records: Vec<String>,
    pub path: String,
    pub body_preview: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn now_iso() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn next_note_id(root: &Path) -> String {
    let year = Local::now().format("%Y").to_string();
    let prefix = format!("NOTE-{}-", year);
    let mut highest = 0u32;

    let scan_dirs = vec![root.join("notes"), root.join("matters")];
    for dir in scan_dirs {
        if !dir.exists() {
            continue;
        }
        for entry in WalkDir::new(&dir)
            .max_depth(6)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                if let Some(suffix) = stem.strip_prefix(&prefix) {
                    if let Ok(num) = suffix.parse::<u32>() {
                        if num > highest {
                            highest = num;
                        }
                    }
                }
            }
            // Also check inside frontmatter
            if let Ok(raw) = fs::read_to_string(path) {
                if let Some((fm, _)) = split_frontmatter(&raw) {
                    if let Ok(val) = serde_yaml::from_str::<Value>(fm) {
                        if let Some(id) = val.get("id").and_then(Value::as_str) {
                            if let Some(suffix) = id.strip_prefix(&prefix) {
                                if let Ok(num) = suffix.parse::<u32>() {
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
    }

    format!("NOTE-{}-{:04}", year, highest + 1)
}

fn parse_note(root: &Path, path: &Path) -> Option<NoteSummary> {
    let raw = fs::read_to_string(path).ok()?;
    let (fm, body) = split_frontmatter(&raw)?;
    let val: Value = serde_yaml::from_str(fm).ok()?;
    let map = val.as_object()?;

    let id = map
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let title = map
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let created_at = map
        .get("created_at")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let updated_at = map
        .get("updated_at")
        .and_then(Value::as_str)
        .unwrap_or(&created_at)
        .to_string();
    let tags = map
        .get("tags")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let related_records = map
        .get("related_records")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    let trimmed_body = body.trim();
    let preview: String = trimmed_body.chars().take(200).collect();

    Some(NoteSummary {
        id,
        title,
        created_at,
        updated_at,
        tags,
        related_records,
        path: relative,
        body_preview: preview,
    })
}

fn collect_notes(root: &Path) -> Vec<NoteSummary> {
    let mut notes = Vec::new();
    let scan_dirs: Vec<std::path::PathBuf> = vec![root.join("notes"), root.join("matters")];
    for dir in scan_dirs {
        if !dir.exists() {
            continue;
        }
        for entry in WalkDir::new(&dir)
            .max_depth(6)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            // Only collect files inside a "notes" directory
            let in_notes_dir = path.components().any(|c| {
                c.as_os_str()
                    .to_str()
                    .map(|s| s == "notes")
                    .unwrap_or(false)
            });
            if !in_notes_dir {
                continue;
            }
            if let Some(note) = parse_note(root, path) {
                if !note.id.is_empty() {
                    notes.push(note);
                }
            }
        }
    }
    notes.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    notes
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn note_save(
    workspace_path: String,
    title: String,
    body: String,
    tags: Vec<String>,
    related_record_id: Option<String>,
    related_module: Option<String>,
) -> AppResult<String> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let id = next_note_id(&root);
    let now = now_iso();
    let year = &now[..4];

    // Determine save path
    let save_dir =
        if let (Some(ref record_id), Some(ref module)) = (&related_record_id, &related_module) {
            if module == "litigation" || module == "non_litigation" {
                // Find the matter directory
                let matter_dir = root.join("matters").join(year).join(record_id);
                if matter_dir.exists() {
                    matter_dir.join("notes")
                } else {
                    root.join("notes").join(year)
                }
            } else {
                root.join("notes").join(year)
            }
        } else {
            root.join("notes").join(year)
        };

    fs::create_dir_all(&save_dir).map_err(stringify)?;
    let target = save_dir.join(format!("{}.md", id));

    let mut fields = Map::new();
    fields.insert("id".into(), Value::String(id.clone()));
    fields.insert(
        "title".into(),
        Value::String(if title.is_empty() {
            format!("笔记 {}", now)
        } else {
            title
        }),
    );
    fields.insert("created_at".into(), Value::String(now.clone()));
    fields.insert("updated_at".into(), Value::String(now));
    fields.insert(
        "tags".into(),
        Value::Array(tags.into_iter().map(Value::String).collect()),
    );
    let related: Vec<Value> = related_record_id
        .iter()
        .map(|r| Value::String(r.clone()))
        .collect();
    fields.insert("related_records".into(), Value::Array(related));
    fields.insert("source".into(), Value::String("quick_note".into()));

    let md = render_markdown(&fields, &body)?;
    fs::write(&target, md).map_err(stringify)?;

    let relative = target
        .strip_prefix(&root)
        .unwrap_or(&target)
        .to_string_lossy()
        .to_string();
    Ok(relative)
}

#[tauri::command]
pub fn note_update(
    workspace_path: String,
    note_path: String,
    title: String,
    body: String,
    tags: Vec<String>,
    related_record_id: Option<String>,
    related_module: Option<String>,
) -> AppResult<String> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let target = safe_join_relative(&root, note_path.trim())?;
    if !target.exists() {
        return Err(format!("笔记文件不存在：{}", note_path));
    }

    // Read existing to preserve id and created_at
    let raw = fs::read_to_string(&target).map_err(stringify)?;
    let (fm, _) = split_frontmatter(&raw).ok_or("笔记缺少 frontmatter".to_string())?;
    let existing: Value = serde_yaml::from_str(fm).map_err(stringify)?;
    let existing_map = existing.as_object().ok_or("frontmatter 格式异常")?;

    let id = existing_map
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let created_at = existing_map
        .get("created_at")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let mut fields = Map::new();
    fields.insert("id".into(), Value::String(id));
    fields.insert(
        "title".into(),
        Value::String(if title.is_empty() {
            existing_map
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("无标题")
                .to_string()
        } else {
            title
        }),
    );
    fields.insert("created_at".into(), Value::String(created_at));
    fields.insert("updated_at".into(), Value::String(now_iso()));
    fields.insert(
        "tags".into(),
        Value::Array(tags.into_iter().map(Value::String).collect()),
    );

    let mut related: Vec<Value> = existing_map
        .get("related_records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(ref rid) = related_record_id {
        if !related.iter().any(|v| v.as_str() == Some(rid)) {
            related.push(Value::String(rid.clone()));
        }
    }
    let _ = related_module; // used for future path relocation
    fields.insert("related_records".into(), Value::Array(related));
    fields.insert("source".into(), Value::String("quick_note".into()));

    let md = render_markdown(&fields, &body)?;
    fs::write(&target, md).map_err(stringify)?;
    Ok(note_path)
}

#[tauri::command]
pub fn note_delete(workspace_path: String, note_path: String) -> AppResult<()> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let target = safe_join_relative(&root, note_path.trim())?;
    if target.exists() {
        fs::remove_file(&target).map_err(stringify)?;
    }
    Ok(())
}

#[tauri::command]
pub fn note_list(workspace_path: String) -> AppResult<Vec<NoteSummary>> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    Ok(collect_notes(&root))
}

#[tauri::command]
pub fn note_read_body(workspace_path: String, note_path: String) -> AppResult<String> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let target = safe_join_relative(&root, note_path.trim())?;
    if !target.exists() {
        return Err("笔记文件不存在".into());
    }
    let raw = fs::read_to_string(&target).map_err(stringify)?;
    match split_frontmatter(&raw) {
        Some((_, body)) => Ok(body.trim().to_string()),
        None => Ok(raw),
    }
}

#[tauri::command]
pub fn note_search(workspace_path: String, query: String) -> AppResult<Vec<NoteSummary>> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let q = query.to_lowercase();
    let all = collect_notes(&root);
    let filtered = all
        .into_iter()
        .filter(|n| {
            n.title.to_lowercase().contains(&q)
                || n.body_preview.to_lowercase().contains(&q)
                || n.tags.iter().any(|t| t.to_lowercase().contains(&q))
        })
        .collect();
    Ok(filtered)
}
