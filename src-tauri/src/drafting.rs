use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

type AppResult<T> = Result<T, String>;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateVariable {
    pub placeholder: String,
    pub label: String,
    #[serde(rename = "type")]
    pub var_type: String, // "text" | "date" | "money" | "number" | "long_text"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateMetadata {
    pub id: String,
    pub title: String,
    pub description: String,
    pub variables: Vec<TemplateVariable>,
    pub original_filename: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>, // "诉讼" | "非诉" | "合同" | "其他"
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub supports_free_draft: bool,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateListItem {
    pub id: String,
    pub title: String,
    pub description: String,
    pub variable_count: usize,
    pub original_filename: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub docx_path: String,
    pub meta_path: String,
    pub status: String,
    pub supports_free_draft: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSyncResult {
    pub added: usize,
    pub updated: usize,
    pub incompatible: usize,
    pub template_dir: String,
    pub templates: Vec<TemplateListItem>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn default_templates_dir(root: &PathBuf) -> PathBuf {
    root.join(".legalbiz").join("templates").join("docx")
}

fn templates_dir(workspace_path: &str) -> AppResult<PathBuf> {
    let root = crate::normalize_workspace_path_public(workspace_path)?;
    let config = crate::workspace::read_or_create_config(&root)?;
    let dir = if config.drafting.template_dir.trim().is_empty() {
        default_templates_dir(&root)
    } else {
        let configured = PathBuf::from(config.drafting.template_dir.trim());
        if configured.is_absolute() {
            configured
        } else {
            root.join(configured)
        }
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn next_template_id(dir: &PathBuf) -> AppResult<String> {
    let mut max_id = 0u32;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(num_str) = name.strip_prefix("tpl-").and_then(|s| s.split('-').next()) {
                if let Ok(n) = num_str.parse::<u32>() {
                    max_id = max_id.max(n);
                }
            }
        }
    }
    Ok(format!("tpl-{:03}", max_id + 1))
}

fn now_label() -> String {
    chrono::Local::now().to_rfc3339()
}

fn supports_free_draft(variables: &[TemplateVariable]) -> bool {
    variables
        .iter()
        .any(|variable| variable.placeholder.trim() == "draft_body")
}

fn status_for_metadata(meta: &TemplateMetadata) -> String {
    if !meta.status.trim().is_empty() {
        return meta.status.clone();
    }
    if meta.variables.is_empty() {
        "needs_conversion".into()
    } else {
        "ready".into()
    }
}

fn template_item_from_meta(
    docx_path: PathBuf,
    meta_path: PathBuf,
    mut meta: TemplateMetadata,
) -> TemplateListItem {
    if meta.status.trim().is_empty() {
        meta.status = if meta.variables.is_empty() {
            "needs_conversion".into()
        } else {
            "ready".into()
        };
    }
    let free_ready = meta.supports_free_draft || supports_free_draft(&meta.variables);
    TemplateListItem {
        id: meta.id.clone(),
        title: meta.title.clone(),
        description: meta.description.clone(),
        variable_count: meta.variables.len(),
        original_filename: meta.original_filename.clone(),
        created_at: meta.created_at.clone(),
        category: meta.category.clone(),
        docx_path: docx_path.to_string_lossy().to_string(),
        meta_path: meta_path.to_string_lossy().to_string(),
        status: status_for_metadata(&meta),
        supports_free_draft: free_ready,
    }
}

fn strip_xml_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn is_placeholder_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.')
}

fn placeholders_from_text(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut placeholders = Vec::new();
    let mut idx = 0;
    while idx < chars.len() {
        if chars[idx] != '{' {
            idx += 1;
            continue;
        }
        let mut end = idx + 1;
        while end < chars.len() && chars[end] != '}' && end - idx <= 80 {
            end += 1;
        }
        if end < chars.len() && chars[end] == '}' {
            let value: String = chars[idx + 1..end].iter().collect();
            let trimmed = value.trim();
            if !trimmed.is_empty()
                && trimmed.chars().all(is_placeholder_char)
                && !placeholders.iter().any(|item| item == trimmed)
            {
                placeholders.push(trimmed.to_string());
            }
            idx = end + 1;
        } else {
            idx += 1;
        }
    }
    placeholders
}

fn variable_label(placeholder: &str) -> String {
    match placeholder {
        "draft_body" => "正文".into(),
        "draft_title" => "标题".into(),
        "document_type" => "文书类型".into(),
        "generated_date" => "生成日期".into(),
        "risk_notes" => "复核提示".into(),
        _ => placeholder.replace('_', " "),
    }
}

fn variable_type(placeholder: &str) -> String {
    if placeholder.contains("body")
        || placeholder.contains("content")
        || placeholder.contains("fact")
        || placeholder.contains("notes")
    {
        "long_text".into()
    } else if placeholder.contains("date") {
        "date".into()
    } else if placeholder.contains("amount") || placeholder.contains("money") {
        "money".into()
    } else {
        "text".into()
    }
}

fn placeholders_from_docx(path: &PathBuf) -> Vec<String> {
    let output = Command::new("unzip")
        .arg("-p")
        .arg(path)
        .arg("word/document.xml")
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let xml = String::from_utf8_lossy(&output.stdout);
    placeholders_from_text(&strip_xml_tags(&xml))
}

fn metadata_for_new_docx(path: &PathBuf, id: String) -> TemplateMetadata {
    let placeholders = placeholders_from_docx(path);
    let variables: Vec<TemplateVariable> = placeholders
        .iter()
        .map(|placeholder| TemplateVariable {
            placeholder: placeholder.clone(),
            label: variable_label(placeholder),
            var_type: variable_type(placeholder),
            example: None,
            description: None,
        })
        .collect();
    let supports_free = supports_free_draft(&variables);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("template.docx")
        .to_string();
    let title = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("未命名模板")
        .to_string();
    let now = now_label();
    TemplateMetadata {
        id,
        title,
        description: if variables.is_empty() {
            "自动扫描发现的普通 Word 文档，需转换或补充占位符后使用。".into()
        } else {
            "自动扫描发现的本地模板，请确认变量后使用。".into()
        },
        variables,
        original_filename: file_name,
        created_at: now.clone(),
        category: None,
        status: if supports_free {
            "new".into()
        } else if placeholders.is_empty() {
            "needs_conversion".into()
        } else {
            "new".into()
        },
        supports_free_draft: supports_free,
        updated_at: now,
    }
}

fn list_templates_in_dir(dir: &PathBuf) -> AppResult<Vec<TemplateListItem>> {
    let mut templates = Vec::new();

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") {
                continue;
            }
            let meta_path = dir.join(&name);
            let docx_name = name.replace(".json", ".docx");
            let docx_path = dir.join(&docx_name);

            if !docx_path.exists() {
                continue;
            }

            let raw = match fs::read_to_string(&meta_path) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let mut meta: TemplateMetadata = match serde_json::from_str(&raw) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.supports_free_draft != supports_free_draft(&meta.variables) {
                meta.supports_free_draft = supports_free_draft(&meta.variables);
            }

            templates.push(template_item_from_meta(docx_path, meta_path, meta));
        }
    }

    templates.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(templates)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Read a .docx file and return its base64-encoded content.
#[tauri::command]
pub fn drafting_read_docx(path: String) -> AppResult<String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{}", path));
    }
    if p.extension().and_then(|e| e.to_str()) != Some("docx") {
        return Err("仅支持 .docx 格式文件。".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("读取文件失败：{}", e))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Save a base64-encoded .docx file to the given path.
#[tauri::command]
pub fn drafting_save_docx(path: String, base64_data: String) -> AppResult<()> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("base64 解码失败：{}", e))?;

    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&p, bytes).map_err(|e| format!("写入文件失败：{}", e))?;
    Ok(())
}

/// List all templates in the workspace's template directory.
#[tauri::command]
pub fn drafting_list_templates(workspace_path: String) -> AppResult<Vec<TemplateListItem>> {
    let dir = templates_dir(&workspace_path)?;
    list_templates_in_dir(&dir)
}

/// Return the current local template directory for this workspace.
#[tauri::command]
pub fn drafting_get_template_dir(workspace_path: String) -> AppResult<String> {
    let dir = templates_dir(&workspace_path)?;
    Ok(dir.to_string_lossy().to_string())
}

/// Copy an external .docx into the local template directory.
#[tauri::command]
pub fn drafting_import_template_file(
    workspace_path: String,
    source_path: String,
) -> AppResult<String> {
    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("模板文件不存在：{}", source_path));
    }
    if source.extension().and_then(|ext| ext.to_str()) != Some("docx") {
        return Err("仅支持导入 .docx 模板。".into());
    }

    let dir = templates_dir(&workspace_path)?;
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("无法读取模板文件名：{}", source_path))?;
    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("template");
    let mut dest = dir.join(file_name);
    if dest.exists() {
        let mut idx = 1;
        loop {
            let candidate = dir.join(format!("{}-{}.docx", stem, idx));
            if !candidate.exists() {
                dest = candidate;
                break;
            }
            idx += 1;
            if idx > 999 {
                return Err("无法生成不重复的模板文件名。".into());
            }
        }
    }
    fs::copy(&source, &dest).map_err(|e| format!("导入模板失败：{}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Scan the template directory and create metadata for newly added .docx files.
#[tauri::command]
pub fn drafting_sync_templates(workspace_path: String) -> AppResult<TemplateSyncResult> {
    let dir = templates_dir(&workspace_path)?;
    let mut added = 0usize;
    let mut updated = 0usize;
    let mut incompatible = 0usize;

    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("docx") {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if file_name.starts_with("~$") {
            continue;
        }
        let stem = match path.file_stem().and_then(|name| name.to_str()) {
            Some(value) if !value.trim().is_empty() => value.to_string(),
            _ => continue,
        };
        let meta_path = dir.join(format!("{}.json", stem));
        if meta_path.exists() {
            let raw = match fs::read_to_string(&meta_path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let mut meta: TemplateMetadata = match serde_json::from_str(&raw) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let free_ready = supports_free_draft(&meta.variables);
            let status = status_for_metadata(&meta);
            if meta.supports_free_draft != free_ready || meta.status.trim().is_empty() {
                meta.supports_free_draft = free_ready;
                meta.status = status;
                meta.updated_at = now_label();
                let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
                fs::write(&meta_path, json).map_err(|e| e.to_string())?;
                updated += 1;
            }
            if meta.variables.is_empty() {
                incompatible += 1;
            }
            continue;
        }

        let meta = metadata_for_new_docx(&path, stem);
        if meta.variables.is_empty() {
            incompatible += 1;
        }
        let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
        fs::write(&meta_path, json).map_err(|e| e.to_string())?;
        added += 1;
    }

    Ok(TemplateSyncResult {
        added,
        updated,
        incompatible,
        template_dir: dir.to_string_lossy().to_string(),
        templates: list_templates_in_dir(&dir)?,
    })
}

/// Save a converted template: both the .docx and its metadata JSON.
#[tauri::command]
pub fn drafting_save_template(
    workspace_path: String,
    docx_base64: String,
    metadata: TemplateMetadata,
) -> AppResult<TemplateListItem> {
    let dir = templates_dir(&workspace_path)?;

    let id = if metadata.id.is_empty() {
        next_template_id(&dir)?
    } else {
        metadata.id.clone()
    };

    let mut meta = metadata.clone();
    meta.id = id.clone();
    if meta.status.trim().is_empty() {
        meta.status = "ready".into();
    }
    meta.supports_free_draft = supports_free_draft(&meta.variables);
    meta.updated_at = now_label();

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&docx_base64)
        .map_err(|e| format!("base64 解码失败：{}", e))?;
    let docx_path = dir.join(format!("{}.docx", id));
    fs::write(&docx_path, bytes).map_err(|e| e.to_string())?;

    let meta_path = dir.join(format!("{}.json", id));
    let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    fs::write(&meta_path, json).map_err(|e| e.to_string())?;

    Ok(TemplateListItem {
        id: meta.id.clone(),
        title: meta.title.clone(),
        description: meta.description.clone(),
        variable_count: meta.variables.len(),
        original_filename: meta.original_filename.clone(),
        created_at: meta.created_at.clone(),
        category: meta.category.clone(),
        docx_path: docx_path.to_string_lossy().to_string(),
        meta_path: meta_path.to_string_lossy().to_string(),
        status: status_for_metadata(&meta),
        supports_free_draft: supports_free_draft(&meta.variables),
    })
}

/// Delete a template (both .docx and .json).
#[tauri::command]
pub fn drafting_delete_template(workspace_path: String, template_id: String) -> AppResult<()> {
    let dir = templates_dir(&workspace_path)?;
    let docx_path = dir.join(format!("{}.docx", template_id));
    let meta_path = dir.join(format!("{}.json", template_id));

    if docx_path.exists() {
        fs::remove_file(&docx_path).map_err(|e| e.to_string())?;
    }
    if meta_path.exists() {
        fs::remove_file(&meta_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Update template metadata without re-converting the .docx.
#[tauri::command]
pub fn drafting_update_metadata(
    workspace_path: String,
    mut metadata: TemplateMetadata,
) -> AppResult<TemplateListItem> {
    let dir = templates_dir(&workspace_path)?;
    let meta_path = dir.join(format!("{}.json", metadata.id));
    let docx_path = dir.join(format!("{}.docx", metadata.id));

    if !docx_path.exists() {
        return Err(format!("模板 .docx 文件不存在：{}", metadata.id));
    }

    if metadata.status.trim().is_empty() {
        metadata.status = "ready".into();
    }
    metadata.supports_free_draft = supports_free_draft(&metadata.variables);
    metadata.updated_at = now_label();

    let json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    fs::write(&meta_path, json).map_err(|e| e.to_string())?;

    Ok(TemplateListItem {
        id: metadata.id.clone(),
        title: metadata.title.clone(),
        description: metadata.description.clone(),
        variable_count: metadata.variables.len(),
        original_filename: metadata.original_filename.clone(),
        created_at: metadata.created_at.clone(),
        category: metadata.category.clone(),
        docx_path: docx_path.to_string_lossy().to_string(),
        meta_path: meta_path.to_string_lossy().to_string(),
        status: status_for_metadata(&metadata),
        supports_free_draft: supports_free_draft(&metadata.variables),
    })
}

#[cfg(test)]
mod tests {
    use super::{placeholders_from_text, strip_xml_tags, variable_type};

    #[test]
    fn extracts_placeholders_after_stripping_docx_xml_runs() {
        let xml = r#"<w:p><w:r><w:t>{draft</w:t></w:r><w:r><w:t>_body}</w:t></w:r><w:r><w:t> 和 {client_name}</w:t></w:r></w:p>"#;
        let text = strip_xml_tags(xml);
        let placeholders = placeholders_from_text(&text);
        assert_eq!(placeholders, vec!["draft_body", "client_name"]);
    }

    #[test]
    fn infers_basic_variable_types() {
        assert_eq!(variable_type("draft_body"), "long_text");
        assert_eq!(variable_type("sign_date"), "date");
        assert_eq!(variable_type("claim_amount"), "money");
        assert_eq!(variable_type("client_name"), "text");
    }
}
