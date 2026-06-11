use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

mod ai;
mod attachments;
mod config;
mod demo;
mod drafting;
mod inbox;
mod litigation_organizer;
mod notes;
mod workspace;

use workspace::{
    create_workspace_dirs, escape_table, is_initialized_workspace, load_snapshot, next_record_id,
    normalize_workspace_path, record_path, record_year, render_markdown, safe_join_relative,
    split_frontmatter, stringify, title_from_fields, value_to_string, workspace_config_path,
    write_json,
};

/// 给子模块用的 path 规范化函数
pub(crate) fn normalize_workspace_path_public(
    workspace_path: &str,
) -> Result<std::path::PathBuf, String> {
    normalize_workspace_path(workspace_path)
}

pub(crate) type AppResult<T> = Result<T, String>;

// ---------------------------------------------------------------------------
// Struct definitions (shared across modules)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppState {
    #[serde(default)]
    last_workspace: Option<String>,
    #[serde(default)]
    recent_workspaces: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FieldDefinition {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub required: bool,
    pub built_in: bool,
    pub ledger: bool,
    pub filterable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ModuleDefinition {
    pub key: String,
    pub label: String,
    pub description: String,
    pub fields: Vec<FieldDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiPolicy {
    pub mode: String,
    pub require_confirmation_before_read: bool,
    pub require_confirmation_before_write: bool,
}

fn default_auto_scan_templates() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftingConfig {
    #[serde(default)]
    pub default_free_template_id: String,
    #[serde(default)]
    pub template_dir: String,
    #[serde(default = "default_auto_scan_templates")]
    pub auto_scan_templates: bool,
}

impl Default for DraftingConfig {
    fn default() -> Self {
        Self {
            default_free_template_id: String::new(),
            template_dir: String::new(),
            auto_scan_templates: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceConfig {
    pub workspace_name: String,
    pub version: u32,
    pub modules: BTreeMap<String, ModuleDefinition>,
    pub ai_policy: AiPolicy,
    #[serde(default)]
    pub drafting: DraftingConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordSummary {
    pub id: String,
    pub module: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub fields: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSnapshot {
    pub config: WorkspaceConfig,
    pub records: Vec<RecordSummary>,
    pub workspace_path: String,
    #[serde(default)]
    pub diagnostics: Vec<WorkspaceDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDiagnostic {
    pub severity: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

pub(crate) struct RecordReadResult {
    pub records: Vec<RecordSummary>,
    pub diagnostics: Vec<WorkspaceDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictHit {
    id: String,
    module: String,
    title: String,
    matched_field: String,
    matched_value: String,
    reason: String,
}

// ---------------------------------------------------------------------------
// 应用级持久化
// ---------------------------------------------------------------------------

#[tauri::command]
fn load_app_state(app: tauri::AppHandle) -> AppState {
    app_state_path(&app)
        .and_then(|path| {
            if !path.exists() {
                return Ok(AppState::default());
            }
            let raw = fs::read_to_string(&path).map_err(stringify)?;
            serde_json::from_str::<AppState>(&raw).map_err(stringify)
        })
        .unwrap_or_default()
}

#[tauri::command]
fn save_app_state(app: tauri::AppHandle, state: AppState) -> AppResult<()> {
    let path = app_state_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(stringify)?;
    }
    let raw = serde_json::to_string_pretty(&state).map_err(stringify)?;
    fs::write(&path, raw).map_err(stringify)
}

fn app_state_path(app: &tauri::AppHandle) -> AppResult<std::path::PathBuf> {
    let dir = app.path().app_config_dir().map_err(stringify)?;
    Ok(dir.join("state.json"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn create_workspace(workspace_path: String) -> AppResult<WorkspaceSnapshot> {
    let root = normalize_workspace_path(&workspace_path)?;
    create_workspace_dirs(&root)?;

    let config_path = root.join(".legalbiz").join("config.json");
    if !config_path.exists() {
        write_json(&config_path, &config::default_config(&root))?;
    }

    load_snapshot(&root)
}

#[tauri::command]
fn open_workspace(workspace_path: String) -> AppResult<WorkspaceSnapshot> {
    let root = normalize_workspace_path(&workspace_path)?;
    if !root.exists() {
        return Err(format!("文件夹不存在：{}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("不是文件夹：{}", root.display()));
    }
    if !is_initialized_workspace(&root) {
        return Err(format!(
            "这不是已初始化的 LegalBiz 工作区：缺少 {}",
            workspace_config_path(&root).display()
        ));
    }
    load_snapshot(&root)
}

#[tauri::command]
fn save_config(workspace_path: String, config: WorkspaceConfig) -> AppResult<WorkspaceConfig> {
    let root = normalize_workspace_path(&workspace_path)?;
    let config_path = root.join(".legalbiz").join("config.json");
    write_json(&config_path, &config)?;
    Ok(config)
}

#[tauri::command]
fn create_record(
    workspace_path: String,
    module_key: String,
    fields: Map<String, Value>,
    body: String,
) -> AppResult<WorkspaceSnapshot> {
    let root = normalize_workspace_path(&workspace_path)?;
    create_record_internal(&root, &module_key, fields, body)?;
    load_snapshot(&root)
}

pub(crate) fn create_record_internal(
    root: &Path,
    module_key: &str,
    mut fields: Map<String, Value>,
    body: String,
) -> AppResult<(PathBuf, String)> {
    let year = record_year(&fields);
    let id = next_record_id(root, module_key, &year);
    let title = title_from_fields(&fields, &id);

    fields.insert("id".into(), Value::String(id.clone()));
    fields.insert("module".into(), Value::String(module_key.to_string()));
    fields.insert("title".into(), Value::String(title));

    let target = record_path(root, module_key, &year, &id)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(stringify)?;
        if module_key == "litigation" {
            litigation_organizer::ensure_litigation_case_skeleton(parent, &fields)?;
        }
        if module_key == "litigation" || module_key == "non_litigation" {
            fs::create_dir_all(parent.join("notes")).map_err(stringify)?;
            fs::create_dir_all(parent.join("attachments")).map_err(stringify)?;
            fs::create_dir_all(parent.join("events")).map_err(stringify)?;
        }
    }

    let markdown_body = if module_key == "litigation" {
        litigation_organizer::render_litigation_index_body(&fields, &body)
    } else {
        body
    };
    let markdown = render_markdown(&fields, &markdown_body)?;
    fs::write(&target, markdown).map_err(stringify)?;
    create_linked_litigation_calendar_events(root, module_key, &id, &fields)?;
    Ok((target, id))
}

#[tauri::command]
fn update_record(
    workspace_path: String,
    record_path: String,
    module_key: String,
    mut fields: Map<String, Value>,
    body: String,
) -> AppResult<WorkspaceSnapshot> {
    let root = normalize_workspace_path(&workspace_path)?;
    let target = safe_join_relative(&root, record_path.trim())?;
    if !target.exists() {
        return Err(format!("记录文件不存在：{}", record_path));
    }
    if target.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return Err("只能修改 Markdown 记录文件。".into());
    }

    let raw = fs::read_to_string(&target).map_err(stringify)?;
    let Some((frontmatter, _)) = split_frontmatter(&raw) else {
        return Err("记录缺少 YAML frontmatter，无法安全修改。".into());
    };
    let existing_value: Value = serde_yaml::from_str(frontmatter).map_err(stringify)?;
    let existing_fields = existing_value
        .as_object()
        .ok_or_else(|| "记录 frontmatter 必须是键值对象。".to_string())?;

    let id = existing_fields
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| fields.get("id").and_then(Value::as_str))
        .ok_or_else(|| "记录缺少 id，无法安全修改。".to_string())?
        .to_string();
    let module = existing_fields
        .get("module")
        .and_then(Value::as_str)
        .unwrap_or(&module_key)
        .to_string();
    let title = title_from_fields(&fields, &id);

    fields.insert("id".into(), Value::String(id));
    fields.insert("module".into(), Value::String(module));
    fields.insert("title".into(), Value::String(title));

    let markdown = render_markdown(&fields, &body)?;
    fs::write(target, markdown).map_err(stringify)?;
    load_snapshot(&root)
}

fn create_linked_litigation_calendar_events(
    root: &Path,
    module_key: &str,
    source_id: &str,
    fields: &Map<String, Value>,
) -> AppResult<()> {
    if module_key != "litigation" {
        return Ok(());
    }

    let matter_title = title_from_fields(fields, source_id);
    let events = [
        (
            format!("{} · 开庭", matter_title),
            "开庭".to_string(),
            value_to_string(fields.get("hearing_date").unwrap_or(&Value::Null)),
            "由诉讼案件自动生成的开庭日程。".to_string(),
        ),
        (
            format!("{} · 关键期限", matter_title),
            "期限".to_string(),
            value_to_string(fields.get("limitation_deadline").unwrap_or(&Value::Null)),
            "由诉讼案件自动生成的关键期限。".to_string(),
        ),
        (
            fields
                .get("next_task")
                .map(value_to_string)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| format!("{} · 下一步任务", matter_title)),
            "任务".to_string(),
            value_to_string(fields.get("next_task_due").unwrap_or(&Value::Null)),
            "由诉讼案件自动生成的任务安排。".to_string(),
        ),
    ];

    for (title, event_type, date, body) in events {
        if date.trim().chars().count() < 7 {
            continue;
        }
        let mut event_fields = Map::new();
        let year = date.chars().take(4).collect::<String>();
        let id = next_record_id(root, "calendar_event", &year);
        event_fields.insert("id".into(), Value::String(id.clone()));
        event_fields.insert("module".into(), Value::String("calendar_event".into()));
        event_fields.insert("title".into(), Value::String(title.clone()));
        event_fields.insert("event_type".into(), Value::String(event_type));
        event_fields.insert("date".into(), Value::String(date));
        event_fields.insert("time".into(), Value::String(String::new()));
        event_fields.insert("related_matter".into(), Value::String(matter_title.clone()));
        event_fields.insert(
            "source_record_id".into(),
            Value::String(source_id.to_string()),
        );
        event_fields.insert("status".into(), Value::String("待处理".into()));

        let target = record_path(root, "calendar_event", &year, &id)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(stringify)?;
        }
        fs::write(target, render_markdown(&event_fields, &body)?).map_err(stringify)?;
    }

    Ok(())
}

#[tauri::command]
fn delete_record(workspace_path: String, record_path: String) -> AppResult<WorkspaceSnapshot> {
    let root = normalize_workspace_path(&workspace_path)?;
    let target = safe_join_relative(&root, record_path.trim())?;
    if !target.exists() {
        return Err(format!("记录文件不存在：{}", record_path));
    }
    if target.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return Err("只能删除 Markdown 记录文件。".into());
    }
    // For index.md inside a folder (clients, contracts, matters) — delete the whole folder
    if target.file_name().and_then(|n| n.to_str()) == Some("index.md") {
        if let Some(parent) = target.parent() {
            fs::remove_dir_all(parent).map_err(stringify)?;
        }
    } else {
        fs::remove_file(&target).map_err(stringify)?;
    }
    load_snapshot(&root)
}

#[tauri::command]
fn run_conflict_check(records: Vec<RecordSummary>, terms: Vec<String>) -> Vec<ConflictHit> {
    let normalized: Vec<String> = terms
        .into_iter()
        .map(|term| term.trim().to_lowercase())
        .filter(|term| term.chars().count() >= 2)
        .collect();

    let mut hits = Vec::new();
    for record in records {
        for (key, value) in &record.fields {
            let text = value_to_string(value).to_lowercase();
            if let Some(term) = normalized.iter().find(|term| text.contains(term.as_str())) {
                hits.push(ConflictHit {
                    id: record.id.clone(),
                    module: record.module.clone(),
                    title: record.title.clone(),
                    matched_field: key.clone(),
                    matched_value: value_to_string(value),
                    reason: format!("字段\u{201c}{}\u{201d}包含\u{201c}{}\u{201d}", key, term),
                });
                break;
            }
        }
    }

    hits
}

#[tauri::command]
fn generate_ledger_snapshot(
    workspace_path: String,
    month: String,
    ledger_type: String,
) -> AppResult<String> {
    let root = normalize_workspace_path(&workspace_path)?;
    let snapshot = load_snapshot(&root)?;
    let module = snapshot
        .config
        .modules
        .get(&ledger_type)
        .ok_or_else(|| format!("未知台账类型：{}", ledger_type))?;
    let fields: Vec<&FieldDefinition> = module
        .fields
        .iter()
        .filter(|field| field.ledger)
        .take(10)
        .collect();
    let records: Vec<RecordSummary> = snapshot
        .records
        .into_iter()
        .filter(|record| record.module == ledger_type)
        .filter(|record| record.date.as_deref().unwrap_or("").starts_with(&month))
        .collect();

    let year = month.split('-').next().unwrap_or("unknown");
    let ledgers_dir = root.join("ledgers").join(year);
    fs::create_dir_all(&ledgers_dir).map_err(stringify)?;
    let output_path = ledgers_dir.join(format!("{}-{}.md", month, ledger_type));

    let mut md = String::new();
    md.push_str("---\n");
    md.push_str(&format!(
        "module: ledger\nledger_type: {}\nmonth: {}\n",
        ledger_type, month
    ));
    md.push_str("source: generated_from_single_record_markdown\n---\n\n");
    md.push_str(&format!("# {} {}\n\n", month, module.label));

    md.push_str("| 编号 | 标题 |");
    for field in &fields {
        md.push_str(&format!(" {} |", field.label));
    }
    md.push('\n');

    md.push_str("| --- | --- |");
    for _ in &fields {
        md.push_str(" --- |");
    }
    md.push('\n');

    for record in &records {
        md.push_str(&format!(
            "| {} | {} |",
            escape_table(&record.id),
            escape_table(&record.title)
        ));
        for field in &fields {
            md.push_str(&format!(
                " {} |",
                escape_table(
                    &record
                        .fields
                        .get(&field.key)
                        .map(value_to_string)
                        .unwrap_or_default(),
                )
            ));
        }
        md.push('\n');
    }

    fs::write(&output_path, md).map_err(stringify)?;
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
fn workspace_exists(workspace_path: String) -> bool {
    match normalize_workspace_path(&workspace_path) {
        Ok(root) => is_initialized_workspace(&root),
        Err(_) => false,
    }
}

#[tauri::command]
fn seed_demo_records(workspace_path: String) -> AppResult<WorkspaceSnapshot> {
    let root = normalize_workspace_path(&workspace_path)?;
    create_workspace_dirs(&root)?;
    let _ = workspace::read_or_create_config(&root)?;

    for (module_key, fields, body) in demo::demo_seed() {
        let mut filled = fields;
        let year = record_year(&filled);
        let id = next_record_id(&root, module_key, &year);
        let title = title_from_fields(&filled, &id);
        filled.insert("id".into(), Value::String(id.clone()));
        filled.insert("module".into(), Value::String(module_key.into()));
        filled.insert("title".into(), Value::String(title));
        let target = record_path(&root, module_key, &year, &id)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(stringify)?;
            if module_key == "litigation" || module_key == "non_litigation" {
                fs::create_dir_all(parent.join("notes")).map_err(stringify)?;
                fs::create_dir_all(parent.join("attachments")).map_err(stringify)?;
                fs::create_dir_all(parent.join("events")).map_err(stringify)?;
            }
        }
        let md = render_markdown(&filled, &body)?;
        fs::write(&target, md).map_err(stringify)?;
    }

    load_snapshot(&root)
}

#[tauri::command]
fn default_workspace_root() -> String {
    workspace::home_dir()
        .map(|home| home.join("LegalVault").to_string_lossy().to_string())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            create_workspace,
            open_workspace,
            save_config,
            create_record,
            update_record,
            delete_record,
            litigation_organizer::scan_litigation_case,
            litigation_organizer::read_litigation_case_file,
            litigation_organizer::propose_litigation_case_plan,
            litigation_organizer::execute_litigation_case_actions,
            run_conflict_check,
            generate_ledger_snapshot,
            workspace_exists,
            default_workspace_root,
            seed_demo_records,
            load_app_state,
            save_app_state,
            ai::load_ai_settings,
            ai::save_ai_settings,
            ai::ai_default_system_prompt,
            ai::ai_chat,
            ai::ai_test,
            inbox::inbox_import_file,
            inbox::inbox_import_file_by_path,
            inbox::inbox_import_from_bytes,
            inbox::inbox_list_pending,
            inbox::inbox_save_analysis,
            inbox::inbox_confirm_create,
            inbox::inbox_confirm_attach,
            inbox::inbox_skip,
            inbox::inbox_list_processed,
            inbox::inbox_read_file_text,
            inbox::inbox_read_file_base64,
            inbox::inbox_clear_all,
            inbox::inbox_update_pipeline,
            inbox::inbox_update_status,
            notes::note_save,
            notes::note_update,
            notes::note_delete,
            notes::note_list,
            notes::note_read_body,
            notes::note_search,
            attachments::record_attachments_dir,
            attachments::list_attachments,
            attachments::add_attachments,
            attachments::delete_attachment,
            attachments::open_path_in_finder,
            drafting::drafting_read_docx,
            drafting::drafting_save_docx,
            drafting::drafting_list_templates,
            drafting::drafting_get_template_dir,
            drafting::drafting_import_template_file,
            drafting::drafting_sync_templates,
            drafting::drafting_save_template,
            drafting::drafting_delete_template,
            drafting::drafting_update_metadata,
        ])
        .run(tauri::generate_context!())
        .expect("error while running legalbiz app");
}
