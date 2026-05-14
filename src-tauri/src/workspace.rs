use chrono::{Datelike, Local};
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

use crate::{
    config, AppResult, RecordReadResult, RecordSummary, WorkspaceConfig, WorkspaceDiagnostic,
    WorkspaceSnapshot,
};

pub fn load_snapshot(root: &Path) -> AppResult<WorkspaceSnapshot> {
    let config = read_or_create_config(root)?;
    let read_result = read_records(root)?;
    Ok(WorkspaceSnapshot {
        config,
        records: read_result.records,
        workspace_path: root.to_string_lossy().to_string(),
        diagnostics: read_result.diagnostics,
    })
}

pub fn home_dir() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("HOME") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    if let Ok(value) = std::env::var("USERPROFILE") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    None
}

pub fn normalize_workspace_path(workspace_path: &str) -> AppResult<PathBuf> {
    let trimmed = workspace_path.trim();
    if trimmed.is_empty() {
        return Err("请先选择本地工作区文件夹".into());
    }

    let expanded = if trimmed == "~" {
        home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        let home = home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
        home.join(rest)
    } else {
        PathBuf::from(trimmed)
    };

    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir().map_err(stringify)?.join(&expanded)
    };

    Ok(clean_path(&absolute))
}

fn clean_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn create_workspace_dirs(root: &Path) -> AppResult<()> {
    let dirs = [
        ".legalbiz",
        "clients",
        "contracts",
        "matters",
        "conflict-checks",
        "invoices",
        "calendar",
        "ledgers",
        "templates",
        "inbox",
        "inbox/pending",
        "inbox/sources",
        "inbox/processed",
        "notes",
    ];
    for dir in dirs {
        fs::create_dir_all(root.join(dir)).map_err(stringify)?;
    }
    Ok(())
}

pub fn is_initialized_workspace(root: &Path) -> bool {
    root.is_dir() && workspace_config_path(root).is_file()
}

pub fn workspace_config_path(root: &Path) -> PathBuf {
    root.join(".legalbiz").join("config.json")
}

pub fn read_or_create_config(root: &Path) -> AppResult<WorkspaceConfig> {
    let config_path = workspace_config_path(root);
    if !config_path.exists() {
        write_json(&config_path, &config::default_config(root))?;
    }
    let raw = fs::read_to_string(&config_path).map_err(stringify)?;
    match serde_json::from_str::<WorkspaceConfig>(&raw) {
        Ok(mut cfg) => {
            if config::migrate_config(&mut cfg) {
                let _ = write_json(&config_path, &cfg);
            }
            Ok(cfg)
        }
        Err(_) => {
            let backup = config_path.with_extension("json.bak");
            let _ = fs::rename(&config_path, &backup);
            let fresh = config::default_config(root);
            write_json(&config_path, &fresh)?;
            Ok(fresh)
        }
    }
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(stringify)?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(stringify)?;
    fs::write(path, raw).map_err(stringify)
}

fn read_records(root: &Path) -> AppResult<RecordReadResult> {
    let mut records = Vec::new();
    let mut diagnostics = Vec::new();
    for entry in WalkDir::new(root)
        .max_depth(6)
        .into_iter()
        .filter_entry(|entry| {
            !entry.path().components().any(|part| {
                matches!(
                    part.as_os_str().to_str(),
                    Some(".legalbiz") | Some("ledgers") | Some("templates") | Some("inbox") | Some("notes")
                )
            })
        })
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                if let Some(path) = error.path() {
                    if is_in_business_root(root, path) {
                        diagnostics.push(record_diagnostic(
                            root,
                            path,
                            format!("读取工作区文件失败：{}", error),
                        ));
                    }
                }
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        if entry.file_name() == "README.md" {
            continue;
        }
        match parse_markdown_record(root, entry.path()) {
            Ok(Some(record)) => records.push(record),
            Ok(None) => {}
            Err(message) => diagnostics.push(record_diagnostic(root, entry.path(), message)),
        }
    }

    records.sort_by(|left, right| {
        right
            .date
            .cmp(&left.date)
            .then(left.title.cmp(&right.title))
    });
    Ok(RecordReadResult {
        records,
        diagnostics,
    })
}

fn parse_markdown_record(root: &Path, path: &Path) -> AppResult<Option<RecordSummary>> {
    let raw = fs::read_to_string(path).map_err(stringify)?;
    let Some((frontmatter, body)) = split_frontmatter(&raw) else {
        if is_standard_record_path(root, path) {
            return Err("缺少或未闭合 YAML frontmatter，记录未被读取。".into());
        }
        return Ok(None);
    };
    let value: Value = match serde_yaml::from_str(frontmatter) {
        Ok(value) => value,
        Err(error) => {
            if is_standard_record_path(root, path) {
                return Err(format!("YAML frontmatter 解析失败：{}", error));
            }
            return Ok(None);
        }
    };
    let Some(map) = value.as_object() else {
        if is_standard_record_path(root, path) {
            return Err("YAML frontmatter 必须是键值对象，记录未被读取。".into());
        }
        return Ok(None);
    };
    let fields = map.clone();
    let module = fields
        .get("module")
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| infer_module_from_path(path));
    let id = fields
        .get("id")
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });
    let title = title_from_fields(&fields, &id);
    let status = status_from_fields(&fields);
    let date = date_from_fields(&fields);
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();

    Ok(Some(RecordSummary {
        id,
        module,
        title,
        status,
        date: Some(date),
        path: Some(relative),
        fields,
        body: Some(body.trim().to_string()),
    }))
}

fn record_diagnostic(root: &Path, path: &Path, message: impl Into<String>) -> WorkspaceDiagnostic {
    WorkspaceDiagnostic {
        severity: "warning".into(),
        message: message.into(),
        path: Some(relative_path(root, path)),
    }
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

fn relative_segments(root: &Path, path: &Path) -> Vec<String> {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|part| part.as_os_str().to_str().map(String::from))
        .collect()
}

fn is_in_business_root(root: &Path, path: &Path) -> bool {
    matches!(
        relative_segments(root, path).first().map(String::as_str),
        Some("clients")
            | Some("contracts")
            | Some("matters")
            | Some("conflict-checks")
            | Some("invoices")
            | Some("calendar")
    )
}

fn is_standard_record_path(root: &Path, path: &Path) -> bool {
    let segments = relative_segments(root, path);
    match segments.as_slice() {
        [root_dir, _, file] if root_dir == "clients" || root_dir == "contracts" => {
            file == "index.md"
        }
        [root_dir, _, _, file] if root_dir == "matters" => file == "index.md",
        [root_dir, _, file]
            if root_dir == "conflict-checks"
                || root_dir == "invoices"
                || root_dir == "calendar" =>
        {
            file.ends_with(".md")
        }
        _ => false,
    }
}

pub fn safe_join_relative(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err("只能访问工作区内的相对路径。".into());
    }
    Ok(root.join(path))
}

pub fn split_frontmatter(raw: &str) -> Option<(&str, &str)> {
    let normalized = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let trimmed = normalized
        .strip_prefix("---\r\n")
        .or_else(|| normalized.strip_prefix("---\n"))?;
    if let Some(end) = trimmed.find("\n---\n") {
        return Some((&trimmed[..end], &trimmed[end + 5..]));
    }
    if let Some(end) = trimmed.find("\r\n---\r\n") {
        return Some((&trimmed[..end], &trimmed[end + 7..]));
    }
    None
}

pub fn render_markdown(fields: &Map<String, Value>, body: &str) -> AppResult<String> {
    let yaml = serde_yaml::to_string(fields).map_err(stringify)?;
    Ok(format!("---\n{}---\n\n{}\n", yaml, body.trim()))
}

pub fn record_path(root: &Path, module_key: &str, year: &str, id: &str) -> AppResult<PathBuf> {
    let path = match module_key {
        "client" => root.join("clients").join(id).join("index.md"),
        "service_contract" => root.join("contracts").join(id).join("index.md"),
        "litigation" | "non_litigation" => {
            root.join("matters").join(year).join(id).join("index.md")
        }
        "conflict_check" => root
            .join("conflict-checks")
            .join(year)
            .join(format!("{}.md", id)),
        "invoice" => root.join("invoices").join(year).join(format!("{}.md", id)),
        "calendar_event" => root.join("calendar").join(year).join(format!("{}.md", id)),
        _ => return Err(format!("未知模块：{}", module_key)),
    };
    Ok(path)
}

pub fn record_year(fields: &Map<String, Value>) -> String {
    date_from_fields(fields)
        .split('-')
        .next()
        .map(String::from)
        .unwrap_or_else(|| Local::now().year().to_string())
}

pub fn next_record_id(root: &Path, module_key: &str, year: &str) -> String {
    let prefix = match module_key {
        "client" => "CLI",
        "service_contract" => "CON",
        "litigation" => "LIT",
        "non_litigation" => "NON",
        "invoice" => "INV",
        "conflict_check" => "CHK",
        "calendar_event" => "CAL",
        _ => "REC",
    };

    let scan_dirs = match module_key {
        "client" => vec![root.join("clients")],
        "service_contract" => vec![root.join("contracts")],
        "litigation" | "non_litigation" => vec![root.join("matters")],
        "conflict_check" => vec![root.join("conflict-checks")],
        "invoice" => vec![root.join("invoices")],
        "calendar_event" => vec![root.join("calendar")],
        _ => vec![root.to_path_buf()],
    };

    let mut highest = 0u32;
    let pattern_prefix = format!("{}-{}-", prefix, year);

    for dir in scan_dirs {
        if !dir.exists() {
            continue;
        }
        for entry in WalkDir::new(&dir)
            .max_depth(4)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
        {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(path) {
                if let Some((frontmatter, _)) = split_frontmatter(&raw) {
                    if let Ok(value) = serde_yaml::from_str::<Value>(frontmatter) {
                        if let Some(id) = value.get("id").and_then(Value::as_str) {
                            if let Some(suffix) = id.strip_prefix(&pattern_prefix) {
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

    format!("{}-{}-{:04}", prefix, year, highest + 1)
}

fn infer_module_from_path(path: &Path) -> String {
    let segments: Vec<String> = path
        .components()
        .filter_map(|part| part.as_os_str().to_str().map(String::from))
        .collect();
    if segments.iter().any(|s| s == "clients") {
        "client"
    } else if segments.iter().any(|s| s == "contracts") {
        "service_contract"
    } else if segments.iter().any(|s| s == "conflict-checks") {
        "conflict_check"
    } else if segments.iter().any(|s| s == "invoices") {
        "invoice"
    } else if segments.iter().any(|s| s == "calendar") {
        "calendar_event"
    } else {
        "litigation"
    }
    .to_string()
}

pub fn title_from_fields(fields: &Map<String, Value>, fallback: &str) -> String {
    ["title", "name", "contract_title", "client_name"]
        .iter()
        .find_map(|key| fields.get(*key).and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .map(String::from)
        .unwrap_or_else(|| fallback.to_string())
}

fn status_from_fields(fields: &Map<String, Value>) -> Option<String> {
    ["status", "invoice_status", "conclusion"]
        .iter()
        .find_map(|key| fields.get(*key).and_then(Value::as_str))
        .map(String::from)
}

pub fn date_from_fields(fields: &Map<String, Value>) -> String {
    [
        "date",
        "opened_at",
        "received_at",
        "sign_date",
        "check_date",
        "invoice_date",
        "created_at",
        "hearing_date",
        "next_task_due",
        "delivery_deadline",
        "limitation_deadline",
    ]
    .iter()
    .find_map(|key| fields.get(*key).and_then(Value::as_str))
    .filter(|value| value.len() >= 7)
    .map(|value| value.chars().take(10).collect())
    .unwrap_or_else(|| Local::now().date_naive().to_string())
}

pub fn value_to_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items
            .iter()
            .map(value_to_string)
            .collect::<Vec<_>>()
            .join("、"),
        Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

pub fn escape_table(value: &str) -> String {
    value.replace('|', "\\|").replace('\n', " ")
}

pub fn stringify(error: impl std::fmt::Display) -> String {
    error.to_string()
}
