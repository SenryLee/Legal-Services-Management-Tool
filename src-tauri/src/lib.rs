use chrono::{Datelike, Local};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;
use walkdir::WalkDir;

mod ai;
mod attachments;

/// 给子模块用的 path 规范化函数
pub(crate) fn normalize_workspace_path_public(workspace_path: &str) -> Result<PathBuf, String> {
    normalize_workspace_path(workspace_path)
}

type AppResult<T> = Result<T, String>;

// ---------------------------------------------------------------------------
// 应用级持久化：把"最近工作区"写进 ~/Library/Application Support/<bundle>/state.json
// 避免依赖 WebKit localStorage（macOS 沙箱偶尔会清掉它）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppState {
    #[serde(default)]
    last_workspace: Option<String>,
    #[serde(default)]
    recent_workspaces: Vec<String>,
}

#[tauri::command]
fn load_app_state(app: tauri::AppHandle) -> AppState {
    match app_state_path(&app).and_then(|path| {
        if !path.exists() {
            return Ok(AppState::default());
        }
        let raw = fs::read_to_string(&path).map_err(stringify)?;
        serde_json::from_str::<AppState>(&raw).map_err(stringify)
    }) {
        Ok(state) => state,
        Err(_) => AppState::default(),
    }
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

fn app_state_path(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_config_dir().map_err(stringify)?;
    Ok(dir.join("state.json"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FieldDefinition {
    key: String,
    label: String,
    #[serde(rename = "type")]
    field_type: String,
    required: bool,
    built_in: bool,
    ledger: bool,
    filterable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModuleDefinition {
    key: String,
    label: String,
    description: String,
    fields: Vec<FieldDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiPolicy {
    mode: String,
    require_confirmation_before_read: bool,
    require_confirmation_before_write: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceConfig {
    workspace_name: String,
    version: u32,
    modules: BTreeMap<String, ModuleDefinition>,
    ai_policy: AiPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordSummary {
    id: String,
    module: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    fields: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSnapshot {
    config: WorkspaceConfig,
    records: Vec<RecordSummary>,
    workspace_path: String,
    #[serde(default)]
    diagnostics: Vec<WorkspaceDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDiagnostic {
    severity: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

struct RecordReadResult {
    records: Vec<RecordSummary>,
    diagnostics: Vec<WorkspaceDiagnostic>,
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

#[tauri::command]
fn create_workspace(workspace_path: String) -> AppResult<WorkspaceSnapshot> {
    let root = normalize_workspace_path(&workspace_path)?;
    create_workspace_dirs(&root)?;

    let config_path = root.join(".legalbiz").join("config.json");
    if !config_path.exists() {
        write_json(&config_path, &default_config(&root))?;
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
    mut fields: Map<String, Value>,
    body: String,
) -> AppResult<WorkspaceSnapshot> {
    let root = normalize_workspace_path(&workspace_path)?;
    let year = record_year(&fields);
    let id = next_record_id(&root, &module_key, &year);
    let title = title_from_fields(&fields, &id);

    fields.insert("id".into(), Value::String(id.clone()));
    fields.insert("module".into(), Value::String(module_key.clone()));
    fields.insert("title".into(), Value::String(title));

    let target = record_path(&root, &module_key, &year, &id)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(stringify)?;
        if module_key == "litigation" || module_key == "non_litigation" {
            fs::create_dir_all(parent.join("notes")).map_err(stringify)?;
            fs::create_dir_all(parent.join("attachments")).map_err(stringify)?;
            fs::create_dir_all(parent.join("events")).map_err(stringify)?;
        }
    }

    let markdown = render_markdown(&fields, &body)?;
    fs::write(target, markdown).map_err(stringify)?;
    create_linked_litigation_calendar_events(&root, &module_key, &id, &fields)?;

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
                    reason: format!("字段“{}”包含“{}”", key, term),
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
    let _ = read_or_create_config(&root)?;

    for (module_key, fields, body) in demo_seed() {
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

fn demo_seed() -> Vec<(&'static str, Map<String, Value>, String)> {
    fn entry(
        module_key: &'static str,
        pairs: &[(&'static str, &str)],
        body: &str,
    ) -> (&'static str, Map<String, Value>, String) {
        let mut map = Map::new();
        for (key, value) in pairs {
            map.insert((*key).to_string(), Value::String((*value).to_string()));
        }
        (module_key, map, body.to_string())
    }

    vec![
        // ---------- 客户 ----------
        entry(
            "client",
            &[
                ("name", "上海岚山科技有限公司"),
                ("client_type", "公司"),
                ("contacts", "王宇 总经理 13800000001"),
                ("related_parties", "岚山控股有限公司、王宇"),
                ("opponents", "北辰贸易有限公司"),
                ("owner", "张律师"),
                ("created_at", "2026-03-12"),
                ("status", "在服"),
            ],
            "SaaS 服务商，主营企业协同办公；常年顾问 + 不定期合同审查。",
        ),
        entry(
            "client",
            &[
                ("name", "北京华诚医药股份有限公司"),
                ("client_type", "公司"),
                ("contacts", "李静 法务总监 010-65000000"),
                ("related_parties", "华诚医药控股集团、李静"),
                ("opponents", "前员工赵某"),
                ("owner", "陈律师"),
                ("created_at", "2026-02-08"),
                ("status", "在服"),
            ],
            "上市医药公司，处理合规、知识产权和劳动争议事务。",
        ),
        entry(
            "client",
            &[
                ("name", "王某（个人）"),
                ("client_type", "个人"),
                ("contacts", "13900000123"),
                ("related_parties", "配偶、未成年子女"),
                ("opponents", "北辰贸易有限公司"),
                ("owner", "张律师"),
                ("created_at", "2026-04-02"),
                ("status", "在服"),
            ],
            "个人家事 + 商事综合委托。",
        ),
        // ---------- 利冲检查 ----------
        entry(
            "conflict_check",
            &[
                ("title", "拟接案 利冲检查 - 北辰贸易咨询"),
                ("client_name", "北辰贸易有限公司"),
                ("opposing_parties", "上海岚山科技有限公司"),
                ("related_parties", "北辰控股"),
                ("check_date", "2026-04-18"),
                ("conclusion", "存在冲突"),
                (
                    "hits_summary",
                    "拟委托人为现有客户岚山科技的相对方，建议拒绝接案。",
                ),
            ],
            "客户拓展同事推送的咨询线索，命中现有客户相对方，已沟通拒绝。",
        ),
        entry(
            "conflict_check",
            &[
                ("title", "拟接案 利冲检查 - 远东供应链股份"),
                ("client_name", "远东供应链股份有限公司"),
                ("opposing_parties", "上海岚山科技有限公司"),
                ("related_parties", "—"),
                ("check_date", "2026-04-22"),
                ("conclusion", "需进一步核查"),
                (
                    "hits_summary",
                    "潜在相对方与现有客户岚山科技重名，待向客户确认。",
                ),
            ],
            "需要客户书面确认是否同意接案。",
        ),
        // ---------- 服务合同 ----------
        entry(
            "service_contract",
            &[
                ("title", "常年法律顾问合同"),
                ("client_name", "上海岚山科技有限公司"),
                ("contract_no", "LS-LEGAL-2026-001"),
                ("service_scope", "常年法律顾问、合同审查、日常咨询"),
                ("sign_date", "2026-04-01"),
                ("amount", "120000"),
                ("paid_amount", "60000"),
                ("invoice_status", "部分开票"),
                ("status", "履行中"),
            ],
            "按半年收款，2026 上半年款已收。",
        ),
        entry(
            "service_contract",
            &[
                ("title", "股权激励项目专项法律服务合同"),
                ("client_name", "北京华诚医药股份有限公司"),
                ("contract_no", "HC-EQUITY-2026-002"),
                ("service_scope", "股权激励方案设计、协议起草、税务衔接"),
                ("sign_date", "2026-03-20"),
                ("amount", "180000"),
                ("paid_amount", "60000"),
                ("invoice_status", "部分开票"),
                ("status", "履行中"),
            ],
            "按里程碑收款，已收首期 60000。",
        ),
        entry(
            "service_contract",
            &[
                ("title", "知识产权事务委托合同"),
                ("client_name", "王某（个人）"),
                ("contract_no", "WX-IP-2026-003"),
                ("service_scope", "商标维权、版权登记"),
                ("sign_date", "2026-04-05"),
                ("amount", "30000"),
                ("paid_amount", "30000"),
                ("invoice_status", "已开票"),
                ("status", "履行中"),
            ],
            "一次性收款，发票已开。",
        ),
        // ---------- 诉讼 ----------
        entry(
            "litigation",
            &[
                ("title", "岚山科技 v. 北辰贸易 服务合同纠纷"),
                ("client_name", "上海岚山科技有限公司"),
                ("opposing_parties", "北辰贸易有限公司"),
                ("case_number", "(2026)沪0105民初1234号"),
                ("court", "上海市长宁区人民法院"),
                ("cause_of_action", "服务合同纠纷"),
                ("procedure", "一审"),
                ("opened_at", "2026-03-15"),
                ("limitation_deadline", "2026-05-20"),
                ("status", "待开庭"),
            ],
            "需要在开庭前完成证据目录、代理意见初稿。",
        ),
        entry(
            "litigation",
            &[
                ("title", "华诚医药 v. 赵某 劳动争议二审"),
                ("client_name", "北京华诚医药股份有限公司"),
                ("opposing_parties", "赵某"),
                ("case_number", "(2026)京01民终567号"),
                ("court", "北京市第一中级人民法院"),
                ("cause_of_action", "劳动争议"),
                ("procedure", "二审"),
                ("opened_at", "2026-03-02"),
                ("limitation_deadline", "2026-05-12"),
                ("status", "待开庭"),
            ],
            "重点准备竞业限制条款合理性的论证。",
        ),
        entry(
            "litigation",
            &[
                ("title", "王某 v. 北辰贸易 民间借贷纠纷"),
                ("client_name", "王某（个人）"),
                ("opposing_parties", "北辰贸易有限公司"),
                ("case_number", "(2026)沪0104民初890号"),
                ("court", "上海市徐汇区人民法院"),
                ("cause_of_action", "民间借贷纠纷"),
                ("procedure", "一审"),
                ("opened_at", "2026-04-10"),
                ("limitation_deadline", "2026-06-01"),
                ("status", "进行中"),
            ],
            "对方已提出调解意向。",
        ),
        // ---------- 非诉 ----------
        entry(
            "non_litigation",
            &[
                ("title", "股权激励协议审查"),
                ("client_name", "上海岚山科技有限公司"),
                ("business_type", "合同审查"),
                ("subject", "股权激励协议、授予通知书、离职回购条款"),
                ("received_at", "2026-04-16"),
                ("delivery_deadline", "2026-04-29"),
                ("review_round", "1"),
                ("status", "办理中"),
            ],
            "重点关注回购价格、竞业限制和个人所得税安排。",
        ),
        entry(
            "non_litigation",
            &[
                ("title", "数据合规整改方案"),
                ("client_name", "北京华诚医药股份有限公司"),
                ("business_type", "专项服务"),
                ("subject", "出境数据合规、患者数据本地化整改"),
                ("received_at", "2026-04-08"),
                ("delivery_deadline", "2026-05-15"),
                ("review_round", "2"),
                ("status", "待反馈"),
            ],
            "已交付第一轮整改建议，等待客户内部讨论反馈。",
        ),
        entry(
            "non_litigation",
            &[
                ("title", "婚前财产协议起草"),
                ("client_name", "王某（个人）"),
                ("business_type", "法律咨询"),
                ("subject", "婚前财产范围、债务隔离、过户安排"),
                ("received_at", "2026-04-20"),
                ("delivery_deadline", "2026-04-30"),
                ("review_round", "1"),
                ("status", "办理中"),
            ],
            "需要在 4 月 30 日前提交协议初稿。",
        ),
        // ---------- 开票 ----------
        entry(
            "invoice",
            &[
                ("title", "岚山顾问费 - Q2 首款"),
                ("client_name", "上海岚山科技有限公司"),
                ("contract_title", "常年法律顾问合同"),
                ("receivable_amount", "60000"),
                ("paid_amount", "60000"),
                ("invoice_status", "已开票"),
                ("invoice_no", "20260401001"),
                ("invoice_date", "2026-04-01"),
            ],
            "顾问费已收已开。",
        ),
        entry(
            "invoice",
            &[
                ("title", "华诚股权激励 - 首期款"),
                ("client_name", "北京华诚医药股份有限公司"),
                ("contract_title", "股权激励项目专项法律服务合同"),
                ("receivable_amount", "60000"),
                ("paid_amount", "60000"),
                ("invoice_status", "未开票"),
                ("invoice_no", ""),
                ("invoice_date", ""),
            ],
            "客户已付款，等待开票指示。",
        ),
        entry(
            "invoice",
            &[
                ("title", "王某 IP 委托 - 一次性律师费"),
                ("client_name", "王某（个人）"),
                ("contract_title", "知识产权事务委托合同"),
                ("receivable_amount", "30000"),
                ("paid_amount", "30000"),
                ("invoice_status", "已开票"),
                ("invoice_no", "20260405002"),
                ("invoice_date", "2026-04-05"),
            ],
            "一次性收款，发票已开。",
        ),
        // ---------- 日历 ----------
        entry(
            "calendar_event",
            &[
                ("title", "岚山案开庭"),
                ("event_type", "开庭"),
                ("date", "2026-04-30"),
                ("time", "09:30"),
                ("related_matter", "岚山科技 v. 北辰贸易 服务合同纠纷"),
                ("status", "待处理"),
            ],
            "提前一日确认证据目录与出庭安排。",
        ),
        entry(
            "calendar_event",
            &[
                ("title", "华诚劳动争议二审 庭前会议"),
                ("event_type", "会议"),
                ("date", "2026-05-06"),
                ("time", "14:00"),
                ("related_matter", "华诚医药 v. 赵某 劳动争议二审"),
                ("status", "待处理"),
            ],
            "与客户对齐答辩思路。",
        ),
        entry(
            "calendar_event",
            &[
                ("title", "婚前财产协议交付截止"),
                ("event_type", "交付"),
                ("date", "2026-04-30"),
                ("time", "18:00"),
                ("related_matter", "婚前财产协议起草"),
                ("status", "待处理"),
            ],
            "提交前再做一轮交叉校对。",
        ),
    ]
}

#[tauri::command]
fn default_workspace_root() -> String {
    home_dir()
        .map(|home| home.join("LegalVault").to_string_lossy().to_string())
        .unwrap_or_default()
}

fn load_snapshot(root: &Path) -> AppResult<WorkspaceSnapshot> {
    let config = read_or_create_config(root)?;
    let read_result = read_records(root)?;
    Ok(WorkspaceSnapshot {
        config,
        records: read_result.records,
        workspace_path: root.to_string_lossy().to_string(),
        diagnostics: read_result.diagnostics,
    })
}

fn home_dir() -> Option<PathBuf> {
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

fn normalize_workspace_path(workspace_path: &str) -> AppResult<PathBuf> {
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

fn create_workspace_dirs(root: &Path) -> AppResult<()> {
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
    ];
    for dir in dirs {
        fs::create_dir_all(root.join(dir)).map_err(stringify)?;
    }
    Ok(())
}

fn is_initialized_workspace(root: &Path) -> bool {
    root.is_dir() && workspace_config_path(root).is_file()
}

fn workspace_config_path(root: &Path) -> PathBuf {
    root.join(".legalbiz").join("config.json")
}

fn read_or_create_config(root: &Path) -> AppResult<WorkspaceConfig> {
    let config_path = workspace_config_path(root);
    if !config_path.exists() {
        write_json(&config_path, &default_config(root))?;
    }
    let raw = fs::read_to_string(&config_path).map_err(stringify)?;
    match serde_json::from_str::<WorkspaceConfig>(&raw) {
        Ok(mut config) => {
            if migrate_config(&mut config) {
                let _ = write_json(&config_path, &config);
            }
            Ok(config)
        }
        Err(_) => {
            // 配置不兼容时回退到默认值，但保留原文件作为 .bak
            let backup = config_path.with_extension("json.bak");
            let _ = fs::rename(&config_path, &backup);
            let fresh = default_config(root);
            write_json(&config_path, &fresh)?;
            Ok(fresh)
        }
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
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
                    Some(".legalbiz") | Some("ledgers") | Some("templates")
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

fn split_frontmatter(raw: &str) -> Option<(&str, &str)> {
    // 兼容 LF 和 CRLF
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

fn render_markdown(fields: &Map<String, Value>, body: &str) -> AppResult<String> {
    let yaml = serde_yaml::to_string(fields).map_err(stringify)?;
    Ok(format!("---\n{}---\n\n{}\n", yaml, body.trim()))
}

fn record_path(root: &Path, module_key: &str, year: &str, id: &str) -> AppResult<PathBuf> {
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

fn record_year(fields: &Map<String, Value>) -> String {
    date_from_fields(fields)
        .split('-')
        .next()
        .map(String::from)
        .unwrap_or_else(|| Local::now().year().to_string())
}

fn next_record_id(root: &Path, module_key: &str, year: &str) -> String {
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

    // 仅扫描相关子目录而不是整个工作区，提高大量记录时的性能
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
            // 优先看 frontmatter id，否则用文件路径推断
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
    } else if segments.iter().any(|s| s == "matters") {
        "litigation"
    } else {
        "litigation"
    }
    .to_string()
}

fn title_from_fields(fields: &Map<String, Value>, fallback: &str) -> String {
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

fn date_from_fields(fields: &Map<String, Value>) -> String {
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

fn value_to_string(value: &Value) -> String {
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

fn escape_table(value: &str) -> String {
    value.replace('|', "\\|").replace('\n', " ")
}

fn stringify(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn default_config(root: &Path) -> WorkspaceConfig {
    let workspace_name = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("法律业务工作区")
        .to_string();

    let mut modules = BTreeMap::new();
    modules.insert(
        "client".into(),
        module(
            "client",
            "客户管理",
            "客户、联系人、关联方和历史业务入口。",
            vec![
                field("name", "客户名称", "text", true),
                field_options(
                    "client_type",
                    "客户类型",
                    "single_select",
                    false,
                    &["个人", "公司", "政府/事业单位", "其他组织"],
                ),
                field("contacts", "联系人", "long_text", false),
                field("related_parties", "关联方", "long_text", false),
                field("opponents", "历史相对方", "long_text", false),
                field("owner", "负责人", "text", false),
                field("created_at", "建档日期", "date", false),
                field_options(
                    "status",
                    "状态",
                    "single_select",
                    false,
                    &["潜在", "在服", "暂停", "终止服务", "归档"],
                ),
            ],
        ),
    );
    modules.insert(
        "conflict_check".into(),
        module(
            "conflict_check",
            "利冲检查",
            "利益冲突检查记录：检查拟委托人/相对方/关联方与历史客户的冲突。",
            vec![
                field("title", "检查主题", "text", true),
                field("client_name", "拟委托人", "party_ref", false),
                field("opposing_parties", "相对方", "long_text", false),
                field("related_parties", "关联方", "long_text", false),
                field("check_date", "检查日期", "date", false),
                field_options(
                    "conclusion",
                    "人工结论",
                    "single_select",
                    false,
                    &[
                        "未检查",
                        "无冲突",
                        "需进一步核查",
                        "存在冲突",
                        "已拒绝接案",
                        "已取得豁免/同意",
                    ],
                ),
                field("hits_summary", "疑似命中摘要", "long_text", false),
            ],
        ),
    );
    modules.insert(
        "service_contract".into(),
        module(
            "service_contract",
            "服务合同",
            "与客户签署的委托或法律服务合同。",
            vec![
                field("title", "合同名称", "text", true),
                field("client_name", "客户", "party_ref", false),
                field("contract_no", "合同编号", "text", false),
                field("service_scope", "服务范围", "long_text", false),
                field("sign_date", "签署日期", "date", false),
                field("amount", "合同金额", "money", false),
                field("paid_amount", "已收金额", "money", false),
                field_options(
                    "invoice_status",
                    "开票状态",
                    "single_select",
                    false,
                    &["未开票", "部分开票", "已开票", "无需开票"],
                ),
                field_options(
                    "status",
                    "合同状态",
                    "single_select",
                    false,
                    &["拟签", "履行中", "待续签", "已完成", "已终止", "归档"],
                ),
            ],
        ),
    );
    modules.insert(
        "litigation".into(),
        module(
            "litigation",
            "诉讼管理",
            "诉讼案件录入、期限、开庭和状态追踪。",
            vec![
                field("title", "案件名称", "text", true),
                field("client_name", "客户/委托人", "party_ref", false),
                field("our_parties", "我方当事人", "long_text", false),
                field_options(
                    "party_position",
                    "我方地位",
                    "single_select",
                    false,
                    &[
                        "原告",
                        "被告",
                        "上诉人",
                        "被上诉人",
                        "申请人",
                        "被申请人",
                        "第三人",
                        "执行申请人",
                        "被执行人",
                        "仲裁申请人",
                        "仲裁被申请人",
                        "其他",
                    ],
                ),
                field("opposing_parties", "对方当事人", "long_text", false),
                field("third_parties", "第三人/其他当事人", "long_text", false),
                field("case_number", "案号", "text", false),
                field("court", "法院/仲裁机构", "text", false),
                field("cause_of_action", "案由", "text", false),
                field_options(
                    "procedure",
                    "程序",
                    "single_select",
                    false,
                    &[
                        "诉前评估",
                        "诉前调解",
                        "一审",
                        "二审",
                        "再审审查",
                        "再审",
                        "执行",
                        "执行异议",
                        "执行异议之诉",
                        "仲裁",
                        "撤裁",
                        "不予执行仲裁裁决",
                        "保全",
                        "破产",
                        "行政复议",
                        "其他",
                    ],
                ),
                field("opened_at", "立案/建档日期", "date", false),
                field_options(
                    "hearing_status",
                    "开庭状态",
                    "single_select",
                    false,
                    &[
                        "未安排",
                        "已排期未开庭",
                        "已开庭",
                        "多次开庭",
                        "延期",
                        "取消",
                    ],
                ),
                field("hearing_date", "下次开庭日期", "date", false),
                field("limitation_deadline", "关键期限", "date", false),
                field("next_task", "下一步任务", "text", false),
                field("next_task_due", "任务截止日期", "date", false),
                field_with_flags(
                    "progress_log",
                    "进度记录",
                    "long_text",
                    false,
                    false,
                    false,
                    None,
                ),
                field_options(
                    "status",
                    "案件状态",
                    "single_select",
                    false,
                    &[
                        "评估中",
                        "待立案",
                        "已立案",
                        "未开庭",
                        "已排期开庭",
                        "已开庭",
                        "庭后待判",
                        "已判决/裁决",
                        "上诉期",
                        "二审中",
                        "执行中",
                        "和解/调解中",
                        "中止/暂停",
                        "已结案",
                        "归档",
                    ],
                ),
            ],
        ),
    );
    modules.insert(
        "non_litigation".into(),
        module(
            "non_litigation",
            "非诉管理",
            "合同审查、咨询、专项非诉业务和复盘。",
            vec![
                field("title", "业务名称", "text", true),
                field("client_name", "客户", "party_ref", false),
                field_options(
                    "business_type",
                    "业务类型",
                    "single_select",
                    false,
                    &[
                        "合同审查",
                        "法律咨询",
                        "专项服务",
                        "常年顾问",
                        "尽职调查",
                        "合规整改",
                        "法律培训",
                        "函件起草",
                        "其他",
                    ],
                ),
                field("subject", "审查对象/咨询内容", "long_text", false),
                field("received_at", "接收日期", "date", false),
                field("delivery_deadline", "交付期限", "date", false),
                field("review_round", "审查轮次", "number", false),
                field_options(
                    "status",
                    "办理状态",
                    "single_select",
                    false,
                    &[
                        "待处理",
                        "办理中",
                        "待客户反馈",
                        "待对方反馈",
                        "已交付",
                        "已复盘",
                        "暂停",
                        "归档",
                    ],
                ),
            ],
        ),
    );
    modules.insert(
        "invoice".into(),
        module(
            "invoice",
            "开票管理",
            "围绕服务合同记录应收、已收和开票信息。",
            vec![
                field("title", "开票事项", "text", true),
                field("client_name", "客户", "party_ref", false),
                field("contract_title", "关联服务合同", "matter_ref", false),
                field("receivable_amount", "应收金额", "money", false),
                field("paid_amount", "已收金额", "money", false),
                field_options(
                    "invoice_status",
                    "是否开票",
                    "single_select",
                    false,
                    &[
                        "未开票",
                        "部分开票",
                        "已开票",
                        "无需开票",
                        "待客户信息",
                        "已作废/红冲",
                    ],
                ),
                field("invoice_no", "发票号", "text", false),
                field("invoice_date", "开票日期", "date", false),
            ],
        ),
    );
    modules.insert(
        "calendar_event".into(),
        module(
            "calendar_event",
            "日历管理",
            "开庭、会议、期限、交付和跟进任务。",
            vec![
                field("title", "日程标题", "text", true),
                field_options(
                    "event_type",
                    "日程类型",
                    "single_select",
                    false,
                    &[
                        "开庭", "会议", "期限", "交付", "跟进", "任务", "电话", "出差", "其他",
                    ],
                ),
                field("date", "日期", "date", false),
                field("time", "时间", "text", false),
                field("related_matter", "关联事项", "matter_ref", false),
                field_options(
                    "status",
                    "状态",
                    "single_select",
                    false,
                    &["待处理", "进行中", "已完成", "已延期", "已取消"],
                ),
            ],
        ),
    );

    WorkspaceConfig {
        workspace_name,
        version: 3,
        modules,
        ai_policy: AiPolicy {
            mode: "local_first_optional_cloud".into(),
            require_confirmation_before_read: true,
            require_confirmation_before_write: true,
        },
    }
}

/// 轻量迁移：只补系统字段和下拉选项，不覆盖用户自定义字段。
fn migrate_config(config: &mut WorkspaceConfig) -> bool {
    let mut changed = false;
    if config.version < 3 {
        config.version = 3;
        changed = true;
    }
    if let Some(module) = config.modules.get_mut("conflict_check") {
        if module.label.contains("立冲") {
            module.label = module.label.replace("立冲", "利冲");
            changed = true;
        }
        if module.description.contains("立冲") {
            module.description = module.description.replace("立冲", "利冲");
            changed = true;
        }
    }
    let defaults = default_config(Path::new(""));
    for (module_key, default_module) in defaults.modules {
        let module = config.modules.entry(module_key).or_insert_with(|| {
            changed = true;
            default_module.clone()
        });

        for default_field in default_module.fields {
            match module
                .fields
                .iter_mut()
                .find(|field| field.key == default_field.key)
            {
                Some(field) => {
                    if field
                        .options
                        .as_ref()
                        .map(|items| items.is_empty())
                        .unwrap_or(true)
                        && default_field.options.is_some()
                    {
                        field.options = default_field.options.clone();
                        changed = true;
                    }
                    if field.key == "client_name"
                        && field.label == "客户"
                        && module.key == "litigation"
                    {
                        field.label = "客户/委托人".into();
                        changed = true;
                    }
                }
                None => {
                    module.fields.push(default_field);
                    changed = true;
                }
            }
        }
    }
    changed
}

fn module(
    key: &str,
    label: &str,
    description: &str,
    fields: Vec<FieldDefinition>,
) -> ModuleDefinition {
    ModuleDefinition {
        key: key.into(),
        label: label.into(),
        description: description.into(),
        fields,
    }
}

fn field(key: &str, label: &str, field_type: &str, required: bool) -> FieldDefinition {
    field_with_flags(key, label, field_type, required, true, true, None)
}

fn field_options(
    key: &str,
    label: &str,
    field_type: &str,
    required: bool,
    options: &[&str],
) -> FieldDefinition {
    field_with_flags(
        key,
        label,
        field_type,
        required,
        true,
        true,
        Some(options.iter().map(|item| (*item).to_string()).collect()),
    )
}

fn field_with_flags(
    key: &str,
    label: &str,
    field_type: &str,
    required: bool,
    ledger: bool,
    filterable: bool,
    options: Option<Vec<String>>,
) -> FieldDefinition {
    FieldDefinition {
        key: key.into(),
        label: label.into(),
        field_type: field_type.into(),
        required,
        built_in: true,
        ledger,
        filterable,
        options,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            create_workspace,
            open_workspace,
            save_config,
            create_record,
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
            attachments::record_attachments_dir,
            attachments::list_attachments,
            attachments::add_attachments,
            attachments::delete_attachment,
            attachments::open_path_in_finder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running legalbiz app");
}
