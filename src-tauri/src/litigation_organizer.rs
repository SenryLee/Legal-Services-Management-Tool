use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

use crate::workspace::{
    safe_join_relative, split_frontmatter, stringify, title_from_fields, value_to_string,
    write_json,
};
use crate::{normalize_workspace_path_public, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseFileSnapshot {
    path: String,
    size: u64,
    modified: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CasePendingFile {
    relative_path: String,
    current_name: String,
    extension: String,
    size: u64,
    modified: i64,
    status: String,
    suspected_wrong_case: bool,
    reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseFileContent {
    name: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LitigationCaseScan {
    case_root: String,
    case_root_relative: String,
    pending_files: Vec<CasePendingFile>,
    last_scanned_at: String,
    has_pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseIndexUpdate {
    field_key: String,
    label: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseDeadlineSuggestion {
    title: String,
    date: String,
    basis: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseAnalysisReport {
    file_path: String,
    current_name: String,
    document_type: String,
    stage: String,
    suggested_directory: String,
    suggested_filename: String,
    suggested_tags: Vec<String>,
    suggested_index_updates: Vec<CaseIndexUpdate>,
    suggested_todos: Vec<String>,
    suggested_deadlines: Vec<CaseDeadlineSuggestion>,
    wrong_case_suspected: bool,
    reasoning_excerpt: String,
    deep_analyzed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseAction {
    id: String,
    kind: String,
    title: String,
    description: String,
    source_path: Option<String>,
    target_path: Option<String>,
    content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LitigationCasePlan {
    case_root: String,
    case_root_relative: String,
    reports: Vec<CaseAnalysisReport>,
    actions: Vec<CaseAction>,
    notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseActionResult {
    action_id: String,
    ok: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LitigationCaseExecutionResult {
    case_root: String,
    results: Vec<CaseActionResult>,
    log_path: String,
    snapshot: Vec<CaseFileSnapshot>,
}

pub(crate) fn ensure_litigation_case_skeleton(
    case_root: &Path,
    fields: &Map<String, Value>,
) -> AppResult<()> {
    for dir in litigation_case_primary_dirs() {
        fs::create_dir_all(case_root.join(dir)).map_err(stringify)?;
    }
    fs::create_dir_all(case_root.join(".case-meta")).map_err(stringify)?;

    let procedure = value_to_string(fields.get("procedure").unwrap_or(&Value::Null));
    let stage = if procedure.trim().is_empty() {
        "一审".to_string()
    } else {
        sanitize_path_segment(&procedure)
    };
    let stage_dir = case_root.join("02程序进展").join(stage);
    fs::create_dir_all(&stage_dir).map_err(stringify)?;
    write_if_missing(
        &stage_dir.join("阶段进展.md"),
        "# 阶段进展\n\n- 暂无记录。\n",
    )?;
    write_if_missing(
        &stage_dir.join("阶段待办.md"),
        "# 阶段待办\n\n- 暂无记录。\n",
    )?;
    write_if_missing(
        &case_root.join("06待办与期限").join("待整理清单.md"),
        "# 待整理清单\n\n暂无待整理文件。\n",
    )?;
    write_if_missing(
        &case_root.join("06待办与期限").join("AI整理建议.md"),
        "# AI整理建议\n\n暂无建议。\n",
    )?;
    write_if_missing(
        &case_root.join("06待办与期限").join("期限清单.md"),
        "# 期限清单\n\n暂无期限。\n",
    )?;
    write_if_missing(
        &case_root.join("06待办与期限").join("当前待办.md"),
        "# 当前待办\n\n暂无待办。\n",
    )?;
    write_if_missing(
        &case_root.join("07归档区").join("整理日志.md"),
        "# 整理日志\n\n暂无整理记录。\n",
    )?;
    ensure_case_meta_files(case_root)
}

pub(crate) fn render_litigation_index_body(fields: &Map<String, Value>, body: &str) -> String {
    let title = title_from_fields(fields, "未命名诉讼案件");
    let mut md = String::new();
    md.push_str(&format!("# {}\n\n", title));
    md.push_str("## 案件摘要\n\n");
    if body.trim().is_empty() {
        md.push_str("暂无补充说明。\n\n");
    } else {
        md.push_str(body.trim());
        md.push_str("\n\n");
    }
    md.push_str("## 重要文件索引\n\n- 暂无。\n\n");
    md.push_str("## 重要工作产出索引\n\n- 暂无。\n\n");
    md.push_str("## AI 最近一次建议摘要\n\n暂无。\n\n");
    md.push_str("## 待确认事项\n\n- 暂无。\n");
    md
}

#[tauri::command]
pub fn scan_litigation_case(
    workspace_path: String,
    record_path: String,
) -> AppResult<LitigationCaseScan> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let case_root = resolve_litigation_case_root(&root, &record_path)?;
    ensure_litigation_case_skeleton(&case_root, &Map::new())?;

    let previous = read_json_or_default::<Vec<CaseFileSnapshot>>(
        &case_root.join(".case-meta").join("last-scan.json"),
    );
    let existing_pending = read_json_or_default::<Vec<CasePendingFile>>(
        &case_root.join(".case-meta").join("pending-intake.json"),
    );
    let current = case_file_snapshot(&case_root)?;
    let previous_map: BTreeMap<String, CaseFileSnapshot> = previous
        .into_iter()
        .map(|item| (item.path.clone(), item))
        .collect();
    let current_paths: BTreeSet<String> = current.iter().map(|item| item.path.clone()).collect();
    let mut pending: BTreeMap<String, CasePendingFile> = existing_pending
        .into_iter()
        .filter(|item| current_paths.contains(&item.relative_path))
        .map(|item| (item.relative_path.clone(), item))
        .collect();

    for item in &current {
        let status = match previous_map.get(&item.path) {
            None => "new",
            Some(prev) if prev.size != item.size || prev.modified != item.modified => "changed",
            Some(_) => continue,
        };
        pending.insert(
            item.path.clone(),
            pending_file_from_snapshot(item, status, &case_root),
        );
    }

    let pending_files = pending.values().cloned().collect::<Vec<_>>();
    write_json(
        &case_root.join(".case-meta").join("last-scan.json"),
        &current,
    )?;
    write_json(
        &case_root.join(".case-meta").join("pending-intake.json"),
        &pending_files,
    )?;
    write_pending_markdown(&case_root, &pending_files)?;

    Ok(LitigationCaseScan {
        case_root: case_root.to_string_lossy().to_string(),
        case_root_relative: relative_path(&root, &case_root),
        has_pending: !pending_files.is_empty(),
        pending_files,
        last_scanned_at: Local::now().to_rfc3339(),
    })
}

#[tauri::command]
pub fn read_litigation_case_file(
    workspace_path: String,
    record_path: String,
    file_path: String,
) -> AppResult<CaseFileContent> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let case_root = resolve_litigation_case_root(&root, &record_path)?;
    let target = safe_join_case(&case_root, &file_path)?;
    if !target.is_file() {
        return Err(format!("文件不存在：{}", file_path));
    }
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("case-file")
        .to_string();
    let bytes = fs::read(&target).map_err(stringify)?;
    Ok(CaseFileContent { name, bytes })
}

#[tauri::command]
pub fn propose_litigation_case_plan(
    workspace_path: String,
    record_path: String,
    files: Vec<String>,
    deep_analysis: bool,
    deep_texts: BTreeMap<String, String>,
) -> AppResult<LitigationCasePlan> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let case_root = resolve_litigation_case_root(&root, &record_path)?;
    ensure_litigation_case_skeleton(&case_root, &Map::new())?;

    let pending = read_json_or_default::<Vec<CasePendingFile>>(
        &case_root.join(".case-meta").join("pending-intake.json"),
    );
    let selected_paths = files.into_iter().collect::<BTreeSet<_>>();
    let selected = pending
        .into_iter()
        .filter(|item| selected_paths.is_empty() || selected_paths.contains(&item.relative_path))
        .collect::<Vec<_>>();
    let index_text = fs::read_to_string(case_root.join("index.md")).unwrap_or_default();
    let mut reports = Vec::new();
    let mut actions = Vec::new();
    let mut notes = vec![
        "初筛只依据文件名、扩展名和当前位置；深入分析只读取用户确认的文件正文，PDF/docx 文本由前端提取后传入，图片 OCR 暂不在第一版内。".into(),
    ];

    for file in selected {
        let report = analyze_case_file(
            &case_root,
            &file,
            &index_text,
            deep_analysis,
            deep_texts.get(&file.relative_path).map(String::as_str),
        )?;
        append_actions_for_report(&mut actions, &report);
        reports.push(report);
    }

    if deep_analysis {
        notes.push("已对可提取文字层的文件执行深入分析；无法提取正文的文件仍基于文件名和路径给出保守建议。".into());
    }
    write_json(
        &case_root.join(".case-meta").join("analysis-report.json"),
        &reports,
    )?;
    write_ai_suggestion_markdown(&case_root, &reports, &actions)?;

    Ok(LitigationCasePlan {
        case_root: case_root.to_string_lossy().to_string(),
        case_root_relative: relative_path(&root, &case_root),
        reports,
        actions,
        notes,
    })
}

#[tauri::command]
pub fn execute_litigation_case_actions(
    workspace_path: String,
    record_path: String,
    actions: Vec<CaseAction>,
) -> AppResult<LitigationCaseExecutionResult> {
    let root = normalize_workspace_path_public(&workspace_path)?;
    let case_root = resolve_litigation_case_root(&root, &record_path)?;
    ensure_litigation_case_skeleton(&case_root, &Map::new())?;
    write_json(
        &case_root.join(".case-meta").join("confirmed-actions.json"),
        &actions,
    )?;

    let mut results = Vec::new();
    let mut success_sources = Vec::new();
    for action in &actions {
        let result = execute_case_action(&case_root, action);
        if result.is_ok() {
            if let Some(source) = &action.source_path {
                success_sources.push(source.clone());
            }
        }
        results.push(CaseActionResult {
            action_id: action.id.clone(),
            ok: result.is_ok(),
            message: result.unwrap_or_else(|message| message),
        });
    }

    if !success_sources.is_empty() {
        let mut pending = read_json_or_default::<Vec<CasePendingFile>>(
            &case_root.join(".case-meta").join("pending-intake.json"),
        );
        pending.retain(|item| !success_sources.contains(&item.relative_path));
        write_json(
            &case_root.join(".case-meta").join("pending-intake.json"),
            &pending,
        )?;
        write_pending_markdown(&case_root, &pending)?;
    }

    append_execution_log(&case_root, &actions, &results)?;
    let snapshot = case_file_snapshot(&case_root)?;
    write_json(
        &case_root.join(".case-meta").join("last-scan.json"),
        &snapshot,
    )?;

    Ok(LitigationCaseExecutionResult {
        case_root: case_root.to_string_lossy().to_string(),
        results,
        log_path: relative_path(&case_root, &case_root.join("07归档区").join("整理日志.md")),
        snapshot,
    })
}

fn resolve_litigation_case_root(root: &Path, record_path: &str) -> AppResult<PathBuf> {
    let index_path = safe_join_relative(root, record_path.trim())?;
    if !index_path.exists() {
        return Err(format!("诉讼记录不存在：{}", record_path));
    }
    if index_path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        == Some("01案件总表")
    {
        return index_path
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .ok_or_else(|| "无法识别诉讼案件主目录。".to_string());
    }
    index_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法识别诉讼案件主目录。".to_string())
}

fn litigation_case_primary_dirs() -> [&'static str; 7] {
    [
        "01案件总表",
        "02程序进展",
        "03案件材料",
        "04工作产出",
        "05沟通记录",
        "06待办与期限",
        "07归档区",
    ]
}

fn ensure_case_meta_files(case_root: &Path) -> AppResult<()> {
    fs::create_dir_all(case_root.join(".case-meta")).map_err(stringify)?;
    write_if_missing(
        &case_root.join(".case-meta").join("pending-intake.json"),
        "[]\n",
    )?;
    write_if_missing(
        &case_root.join(".case-meta").join("analysis-report.json"),
        "[]\n",
    )?;
    write_if_missing(
        &case_root.join(".case-meta").join("confirmed-actions.json"),
        "[]\n",
    )?;
    write_if_missing(&case_root.join(".case-meta").join("last-scan.json"), "[]\n")?;
    Ok(())
}

fn write_if_missing(path: &Path, content: &str) -> AppResult<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(stringify)?;
    }
    fs::write(path, content).map_err(stringify)
}

fn read_json_or_default<T>(path: &Path) -> T
where
    T: for<'de> Deserialize<'de> + Default,
{
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<T>(&raw).ok())
        .unwrap_or_default()
}

fn case_file_snapshot(case_root: &Path) -> AppResult<Vec<CaseFileSnapshot>> {
    let mut files = Vec::new();
    for entry in WalkDir::new(case_root).max_depth(8).into_iter() {
        let entry = entry.map_err(stringify)?;
        if !entry.file_type().is_file() || should_ignore_case_file(case_root, entry.path()) {
            continue;
        }
        let metadata = entry.metadata().map_err(stringify)?;
        files.push(CaseFileSnapshot {
            path: relative_path(case_root, entry.path()),
            size: metadata.len(),
            modified: modified_secs(&metadata),
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn modified_secs(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn should_ignore_case_file(case_root: &Path, path: &Path) -> bool {
    let segments = relative_segments(case_root, path);
    if segments.is_empty() || segments.iter().any(|part| part.starts_with('.')) {
        return true;
    }
    let parts = segments.iter().map(String::as_str).collect::<Vec<_>>();
    matches!(
        parts.as_slice(),
        ["index.md"]
            | ["01案件总表", "index.md"]
            | ["06待办与期限", "待整理清单.md"]
            | ["06待办与期限", "AI整理建议.md"]
            | ["06待办与期限", "期限清单.md"]
            | ["06待办与期限", "当前待办.md"]
            | ["07归档区", "整理日志.md"]
            | ["02程序进展", _, "阶段进展.md"]
            | ["02程序进展", _, "阶段待办.md"]
    )
}

fn pending_file_from_snapshot(
    item: &CaseFileSnapshot,
    status: &str,
    case_root: &Path,
) -> CasePendingFile {
    let path = case_root.join(&item.path);
    let current_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_string();
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();
    let classification = classify_case_filename(&item.path, "", false);
    CasePendingFile {
        relative_path: item.path.clone(),
        current_name,
        extension,
        size: item.size,
        modified: item.modified,
        status: status.into(),
        suspected_wrong_case: classification.wrong_case_suspected,
        reason: classification.reasoning_excerpt,
    }
}

fn write_pending_markdown(case_root: &Path, pending: &[CasePendingFile]) -> AppResult<()> {
    let mut md = String::from("# 待整理清单\n\n");
    if pending.is_empty() {
        md.push_str("暂无待整理文件。\n");
    } else {
        for file in pending {
            let status = if file.status == "changed" {
                "变更"
            } else {
                "新增"
            };
            md.push_str(&format!(
                "- [{}] `{}` · {} bytes · {}\n",
                status, file.relative_path, file.size, file.reason
            ));
        }
    }
    fs::write(case_root.join("06待办与期限").join("待整理清单.md"), md).map_err(stringify)
}

fn analyze_case_file(
    case_root: &Path,
    file: &CasePendingFile,
    index_text: &str,
    deep_analysis: bool,
    provided_text: Option<&str>,
) -> AppResult<CaseAnalysisReport> {
    let path = safe_join_case(case_root, &file.relative_path)?;
    let can_read_text = matches!(
        file.extension.as_str(),
        "md" | "markdown" | "txt" | "text" | "csv"
    );
    let readable_text = if deep_analysis {
        provided_text
            .map(String::from)
            .filter(|text| !text.trim().is_empty())
            .or_else(|| can_read_text.then(|| fs::read_to_string(&path).unwrap_or_default()))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let source_text = if readable_text.trim().is_empty() {
        file.relative_path.clone()
    } else {
        format!("{}\n{}", file.relative_path, readable_text)
    };
    let mut report = classify_case_filename(&file.relative_path, &source_text, deep_analysis);
    report.file_path = file.relative_path.clone();
    report.current_name = file.current_name.clone();

    let case_tokens = important_case_tokens(index_text);
    if deep_analysis && !case_tokens.is_empty() {
        let haystack = source_text.to_lowercase();
        let matched = case_tokens.iter().any(|token| haystack.contains(token));
        if !matched && !report.wrong_case_suspected {
            report.wrong_case_suspected = true;
            report.reasoning_excerpt.push_str(
                "；深入分析未发现与本案客户、案号或相对方匹配的关键词，需人工核查是否错放。",
            );
        }
    }
    if report.suggested_filename.trim().is_empty() {
        report.suggested_filename = standard_case_filename(&report, &file.extension);
    }
    Ok(report)
}

fn classify_case_filename(path: &str, text: &str, deep_analyzed: bool) -> CaseAnalysisReport {
    let lower = format!("{} {}", path, text).to_lowercase();
    let name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string();
    let ext = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();
    let (document_type, directory, tags) =
        if contains_any(&lower, &["判决", "裁定", "调解书", "裁判"]) {
            ("裁判文书", "03案件材料/裁判文书", vec!["裁判文书"])
        } else if contains_any(&lower, &["开庭", "传票", "举证通知", "应诉通知", "通知书"])
        {
            ("法院通知", "03案件材料/法院通知", vec!["法院通知"])
        } else if contains_any(&lower, &["起诉状", "起诉书", "立案"]) {
            ("起诉材料", "03案件材料/起诉材料", vec!["起诉材料"])
        } else if contains_any(&lower, &["答辩", "反诉"]) {
            ("答辩材料", "03案件材料/答辩材料", vec!["答辩材料"])
        } else if contains_any(&lower, &["证据", "举证", "目录"]) {
            ("证据材料", "03案件材料/证据材料", vec!["证据"])
        } else if contains_any(&lower, &["代理意见", "代理词"]) {
            ("代理意见", "04工作产出/代理意见", vec!["工作产出"])
        } else if contains_any(&lower, &["庭审提纲", "发问提纲", "质证意见"]) {
            ("庭审材料", "04工作产出/庭审提纲", vec!["庭审"])
        } else if contains_any(&lower, &["聊天", "微信", "邮件", "沟通", "纪要"]) {
            ("沟通记录", "05沟通记录/客户沟通", vec!["沟通"])
        } else {
            ("待人工确认材料", "03案件材料/待人工确认", vec!["待确认"])
        };
    let stage = if contains_any(&lower, &["二审", "终审", "民终"]) {
        "二审"
    } else if contains_any(&lower, &["执行", "执恢", "执异"]) {
        "执行"
    } else if contains_any(&lower, &["再审"]) {
        "再审"
    } else if contains_any(&lower, &["仲裁"]) {
        "仲裁"
    } else if contains_any(&lower, &["保全"]) {
        "保全"
    } else if contains_any(&lower, &["调解"]) {
        "调解"
    } else {
        "一审"
    };
    let date = extract_date_like(text).unwrap_or_else(|| Local::now().date_naive().to_string());
    let mut todos = Vec::new();
    let mut deadlines = Vec::new();
    let mut index_updates = Vec::new();
    if document_type == "裁判文书" {
        todos.push("评估是否上诉/申请再审，并核算相应期限。".into());
        index_updates.push(CaseIndexUpdate {
            field_key: "status".into(),
            label: "案件状态".into(),
            value: "已判决/裁决（待人工确认）".into(),
        });
    }
    if document_type == "法院通知" {
        todos.push("核对通知载明的开庭、举证或提交材料期限。".into());
        if let Some(deadline) = extract_date_like(text) {
            deadlines.push(CaseDeadlineSuggestion {
                title: "根据法院通知核对关键期限".into(),
                date: deadline,
                basis: "从文件名或可读正文中识别到日期。".into(),
            });
        }
    }
    CaseAnalysisReport {
        file_path: path.into(),
        current_name: name,
        document_type: document_type.into(),
        stage: stage.into(),
        suggested_directory: directory.into(),
        suggested_filename: format!("{}-{}-{}.{}", date, stage, document_type, ext)
            .trim_end_matches('.')
            .to_string(),
        suggested_tags: tags.into_iter().map(String::from).collect(),
        suggested_index_updates: index_updates,
        suggested_todos: todos,
        suggested_deadlines: deadlines,
        wrong_case_suspected: contains_any(&lower, &["另案", "其他案件", "非本案", "错放"]),
        reasoning_excerpt: format!(
            "依据文件名/路径「{}」{}判断为{}，建议放入{}。",
            path,
            if deep_analyzed { "及可读正文" } else { "" },
            document_type,
            directory
        ),
        deep_analyzed,
    }
}

fn append_actions_for_report(actions: &mut Vec<CaseAction>, report: &CaseAnalysisReport) {
    let target_dir = sanitize_relative_case_path(&report.suggested_directory);
    let target_path = format!(
        "{}/{}",
        target_dir,
        sanitize_path_segment(&report.suggested_filename)
    );
    let base_id = sanitize_path_segment(&report.file_path)
        .chars()
        .take(32)
        .collect::<String>();
    actions.push(CaseAction {
        id: format!("mkdir-{}", base_id),
        kind: "create_directory".into(),
        title: format!("创建目录：{}", target_dir),
        description: "在固定一级目录下创建 AI 建议的二级目录。".into(),
        source_path: None,
        target_path: Some(target_dir),
        content: None,
    });
    actions.push(CaseAction {
        id: format!("move-{}", base_id),
        kind: "move_file".into(),
        title: format!("移动并命名：{}", report.current_name),
        description: format!("移动到 `{}`。", target_path),
        source_path: Some(report.file_path.clone()),
        target_path: Some(target_path),
        content: None,
    });
    if !report.suggested_index_updates.is_empty() || report.wrong_case_suspected {
        actions.push(CaseAction {
            id: format!("index-{}", base_id),
            kind: "update_index".into(),
            title: "更新案件总表建议摘要".into(),
            description: "只追加 AI 建议摘要，不直接覆盖已有 frontmatter。".into(),
            source_path: None,
            target_path: Some("index.md".into()),
            content: Some(index_update_content(report)),
        });
    }
    if !report.suggested_todos.is_empty() {
        actions.push(CaseAction {
            id: format!("todo-{}", base_id),
            kind: "update_todo".into(),
            title: "写入当前待办".into(),
            description: "把识别出的待办追加到 06待办与期限/当前待办.md。".into(),
            source_path: None,
            target_path: Some("06待办与期限/当前待办.md".into()),
            content: Some(report.suggested_todos.join("\n")),
        });
    }
    if !report.suggested_deadlines.is_empty() {
        actions.push(CaseAction {
            id: format!("deadline-{}", base_id),
            kind: "update_deadline".into(),
            title: "写入期限清单".into(),
            description: "把识别出的期限追加到 06待办与期限/期限清单.md。".into(),
            source_path: None,
            target_path: Some("06待办与期限/期限清单.md".into()),
            content: Some(
                report
                    .suggested_deadlines
                    .iter()
                    .map(|item| format!("{}：{}（{}）", item.date, item.title, item.basis))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
        });
    }
    actions.push(CaseAction {
        id: format!("summary-{}", base_id),
        kind: "write_ai_summary".into(),
        title: "写入 AI 整理建议摘要".into(),
        description: "把本次识别依据写入 06待办与期限/AI整理建议.md。".into(),
        source_path: None,
        target_path: Some("06待办与期限/AI整理建议.md".into()),
        content: Some(format!(
            "- `{}`：{}{}",
            report.file_path,
            report.reasoning_excerpt,
            if report.wrong_case_suspected {
                "（疑似放错案件，禁止自动跨案件移动）"
            } else {
                ""
            }
        )),
    });
}

fn execute_case_action(case_root: &Path, action: &CaseAction) -> Result<String, String> {
    match action.kind.as_str() {
        "create_directory" => {
            let target = action
                .target_path
                .as_deref()
                .ok_or_else(|| "缺少目标目录。".to_string())?;
            let target = safe_join_case(case_root, target)?;
            fs::create_dir_all(&target).map_err(stringify)?;
            Ok(format!("已创建目录 {}", relative_path(case_root, &target)))
        }
        "move_file" | "rename_file" => {
            let source = action
                .source_path
                .as_deref()
                .ok_or_else(|| "缺少来源文件。".to_string())?;
            let target = action
                .target_path
                .as_deref()
                .ok_or_else(|| "缺少目标文件。".to_string())?;
            let source = safe_join_case(case_root, source)?;
            let mut target = safe_join_case(case_root, target)?;
            if target.exists() {
                target = dedupe_path(&target);
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(stringify)?;
            }
            fs::rename(&source, &target).map_err(stringify)?;
            Ok(format!(
                "已移动 {} -> {}",
                relative_path(case_root, &source),
                relative_path(case_root, &target)
            ))
        }
        "update_index" | "update_todo" | "update_deadline" | "write_ai_summary" => {
            let target = action
                .target_path
                .as_deref()
                .ok_or_else(|| "缺少目标 Markdown。".to_string())?;
            let target = safe_join_case(case_root, target)?;
            append_markdown_section(
                &target,
                &format!(
                    "{} · {}",
                    Local::now().format("%Y-%m-%d %H:%M"),
                    action.title
                ),
                action.content.as_deref().unwrap_or(""),
            )?;
            Ok(format!("已更新 {}", relative_path(case_root, &target)))
        }
        _ => Err(format!("未知操作类型：{}", action.kind)),
    }
}

fn write_ai_suggestion_markdown(
    case_root: &Path,
    reports: &[CaseAnalysisReport],
    actions: &[CaseAction],
) -> AppResult<()> {
    let mut md = String::from("# AI整理建议\n\n");
    if reports.is_empty() {
        md.push_str("暂无建议。\n");
    }
    for report in reports {
        md.push_str(&format!(
            "## {}\n\n- 当前路径：`{}`\n- 文件类型：{}\n- 程序阶段：{}\n- 建议目录：`{}`\n- 建议命名：`{}`\n- 判断依据：{}\n\n",
            report.current_name,
            report.file_path,
            report.document_type,
            report.stage,
            report.suggested_directory,
            report.suggested_filename,
            report.reasoning_excerpt
        ));
    }
    if !actions.is_empty() {
        md.push_str("## 待确认操作\n\n");
        for action in actions {
            md.push_str(&format!("- [{}] {}\n", action.kind, action.title));
        }
    }
    fs::write(case_root.join("06待办与期限").join("AI整理建议.md"), md).map_err(stringify)
}

fn append_execution_log(
    case_root: &Path,
    actions: &[CaseAction],
    results: &[CaseActionResult],
) -> AppResult<()> {
    let mut content = String::new();
    content.push_str(&format!(
        "本次确认执行 {} 项操作，成功 {} 项。\n\n",
        actions.len(),
        results.iter().filter(|item| item.ok).count()
    ));
    for result in results {
        content.push_str(&format!(
            "- {}：{}\n",
            if result.ok { "成功" } else { "失败" },
            result.message
        ));
    }
    append_markdown_section(
        &case_root.join("07归档区").join("整理日志.md"),
        &format!("整理执行 {}", Local::now().format("%Y-%m-%d %H:%M")),
        &content,
    )
}

fn append_markdown_section(path: &Path, title: &str, content: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(stringify)?;
    }
    let mut current = fs::read_to_string(path).unwrap_or_default();
    if !current.ends_with('\n') {
        current.push('\n');
    }
    current.push_str(&format!("\n## {}\n\n{}\n", title, content.trim()));
    fs::write(path, current).map_err(stringify)
}

fn important_case_tokens(index_text: &str) -> Vec<String> {
    serde_yaml::from_str::<Value>(
        split_frontmatter(index_text)
            .map(|(frontmatter, _)| frontmatter)
            .unwrap_or(""),
    )
    .ok()
    .and_then(|value| value.as_object().cloned())
    .map(|fields| {
        [
            "client_name",
            "opposing_parties",
            "case_number",
            "court",
            "cause_of_action",
        ]
        .iter()
        .flat_map(|key| {
            value_to_string(fields.get(*key).unwrap_or(&Value::Null))
                .split(['、', '，', ',', ';', '；', '\n'])
                .map(|item| item.trim().to_lowercase())
                .filter(|item| item.chars().count() >= 2)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
    })
    .unwrap_or_default()
}

fn index_update_content(report: &CaseAnalysisReport) -> String {
    let mut lines = vec![format!(
        "- `{}`：{}",
        report.file_path, report.reasoning_excerpt
    )];
    for update in &report.suggested_index_updates {
        lines.push(format!("  - 建议更新 {}：{}", update.label, update.value));
    }
    if report.wrong_case_suspected {
        lines.push("  - 疑似放错案件：请人工核查，不自动跨案件移动。".into());
    }
    lines.join("\n")
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn extract_date_like(text: &str) -> Option<String> {
    let chars = text.chars().collect::<Vec<_>>();
    for index in 0..chars.len() {
        if index + 10 > chars.len() {
            break;
        }
        let slice = chars[index..usize::min(index + 12, chars.len())]
            .iter()
            .collect::<String>();
        if let Some(date) = parse_date_like(&slice) {
            return Some(date);
        }
    }
    None
}

fn parse_date_like(value: &str) -> Option<String> {
    let normalized = value
        .replace(['年', '月'], "-")
        .replace('日', "")
        .replace(['/', '.'], "-");
    let parts = normalized
        .split('-')
        .take(3)
        .map(|part| {
            part.chars()
                .filter(|ch| ch.is_ascii_digit())
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    if parts.len() < 3 || parts[0].len() != 4 {
        return None;
    }
    let year = parts[0].parse::<u32>().ok()?;
    let month = parts[1].parse::<u32>().ok()?;
    let day = parts[2].parse::<u32>().ok()?;
    if !(2000..=2099).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(format!("{}-{:02}-{:02}", year, month, day))
}

fn standard_case_filename(report: &CaseAnalysisReport, extension: &str) -> String {
    let ext = extension.trim_start_matches('.');
    let name = sanitize_path_segment(&format!("{}-{}", report.stage, report.document_type));
    if ext.is_empty() {
        name
    } else {
        format!("{}.{}", name, ext)
    }
}

fn sanitize_relative_case_path(relative: &str) -> String {
    relative
        .split('/')
        .filter(|part| !part.trim().is_empty())
        .map(sanitize_path_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn sanitize_path_segment(value: &str) -> String {
    let mut text = value
        .trim()
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => ' ',
            _ => ch,
        })
        .collect::<String>();
    text = text.split_whitespace().collect::<Vec<_>>().join("");
    if text.is_empty() {
        "未命名".into()
    } else {
        text
    }
}

fn dedupe_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("文件");
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    for index in 1..1000 {
        let name = if ext.is_empty() {
            format!("{}-{}", stem, index)
        } else {
            format!("{}-{}.{}", stem, index, ext)
        };
        let next = parent.join(name);
        if !next.exists() {
            return next;
        }
    }
    path.to_path_buf()
}

fn safe_join_case(case_root: &Path, relative: &str) -> AppResult<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err("只能访问案件目录内的相对路径。".into());
    }
    Ok(case_root.join(path))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_case_root() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "legalbiz-case-organizer-test-{}-{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn scan_plan_and_execute_moves_case_file_after_confirmation() {
        let case_root = temp_case_root();
        fs::create_dir_all(&case_root).expect("create case root");
        fs::write(
            case_root.join("index.md"),
            "---\nid: LIT-2026-0001\nmodule: litigation\ntitle: 测试案件\ncase_number: (2026)沪0105民初1234号\n---\n\n测试案件\n",
        )
        .expect("write index");
        ensure_litigation_case_skeleton(&case_root, &Map::new()).expect("skeleton");
        fs::write(
            case_root.join("开庭传票-2026-05-12.txt"),
            "开庭日期：2026年5月12日",
        )
        .expect("write file");

        let scan = scan_from_case_root_for_test(&case_root).expect("scan");
        assert_eq!(scan.pending_files.len(), 1);
        let plan = plan_from_case_root_for_test(
            &case_root,
            vec!["开庭传票-2026-05-12.txt".into()],
            false,
            BTreeMap::new(),
        )
        .expect("plan");
        assert!(plan.actions.iter().any(|action| action.kind == "move_file"));
        let result = execute_in_case_root_for_test(&case_root, plan.actions).expect("execute");
        assert!(result.results.iter().all(|item| item.ok));
        assert!(case_root
            .join("03案件材料/法院通知/2026-05-12-一审-法院通知.txt")
            .is_file());

        let _ = fs::remove_dir_all(case_root);
    }

    fn scan_from_case_root_for_test(case_root: &Path) -> AppResult<LitigationCaseScan> {
        let current = case_file_snapshot(case_root)?;
        let pending_files = current
            .iter()
            .map(|item| pending_file_from_snapshot(item, "new", case_root))
            .collect::<Vec<_>>();
        write_json(
            &case_root.join(".case-meta").join("pending-intake.json"),
            &pending_files,
        )?;
        Ok(LitigationCaseScan {
            case_root: case_root.to_string_lossy().to_string(),
            case_root_relative: ".".into(),
            has_pending: !pending_files.is_empty(),
            pending_files,
            last_scanned_at: Local::now().to_rfc3339(),
        })
    }

    fn plan_from_case_root_for_test(
        case_root: &Path,
        files: Vec<String>,
        deep_analysis: bool,
        deep_texts: BTreeMap<String, String>,
    ) -> AppResult<LitigationCasePlan> {
        let pending = read_json_or_default::<Vec<CasePendingFile>>(
            &case_root.join(".case-meta").join("pending-intake.json"),
        );
        let selected = pending
            .into_iter()
            .filter(|item| files.contains(&item.relative_path))
            .collect::<Vec<_>>();
        let index_text = fs::read_to_string(case_root.join("index.md")).unwrap_or_default();
        let mut reports = Vec::new();
        let mut actions = Vec::new();
        for file in selected {
            let report = analyze_case_file(
                case_root,
                &file,
                &index_text,
                deep_analysis,
                deep_texts.get(&file.relative_path).map(String::as_str),
            )?;
            append_actions_for_report(&mut actions, &report);
            reports.push(report);
        }
        Ok(LitigationCasePlan {
            case_root: case_root.to_string_lossy().to_string(),
            case_root_relative: ".".into(),
            reports,
            actions,
            notes: Vec::new(),
        })
    }

    fn execute_in_case_root_for_test(
        case_root: &Path,
        actions: Vec<CaseAction>,
    ) -> AppResult<LitigationCaseExecutionResult> {
        let results = actions
            .iter()
            .map(|action| {
                let result = execute_case_action(case_root, action);
                CaseActionResult {
                    action_id: action.id.clone(),
                    ok: result.is_ok(),
                    message: result.unwrap_or_else(|message| message),
                }
            })
            .collect::<Vec<_>>();
        Ok(LitigationCaseExecutionResult {
            case_root: case_root.to_string_lossy().to_string(),
            results,
            log_path: String::new(),
            snapshot: case_file_snapshot(case_root)?,
        })
    }
}
