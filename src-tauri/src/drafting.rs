use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn templates_dir(workspace_path: &str) -> AppResult<PathBuf> {
    let root = crate::normalize_workspace_path_public(workspace_path)?;
    let dir = root.join(".legalbiz").join("templates").join("docx");
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
    let mut templates = Vec::new();

    if let Ok(entries) = fs::read_dir(&dir) {
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
            let meta: TemplateMetadata = match serde_json::from_str(&raw) {
                Ok(m) => m,
                Err(_) => continue,
            };

            templates.push(TemplateListItem {
                id: meta.id.clone(),
                title: meta.title.clone(),
                description: meta.description.clone(),
                variable_count: meta.variables.len(),
                original_filename: meta.original_filename.clone(),
                created_at: meta.created_at.clone(),
                category: meta.category.clone(),
                docx_path: docx_path.to_string_lossy().to_string(),
                meta_path: meta_path.to_string_lossy().to_string(),
            });
        }
    }

    templates.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(templates)
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
    })
}

/// Delete a template (both .docx and .json).
#[tauri::command]
pub fn drafting_delete_template(
    workspace_path: String,
    template_id: String,
) -> AppResult<()> {
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
    metadata: TemplateMetadata,
) -> AppResult<TemplateListItem> {
    let dir = templates_dir(&workspace_path)?;
    let meta_path = dir.join(format!("{}.json", metadata.id));
    let docx_path = dir.join(format!("{}.docx", metadata.id));

    if !docx_path.exists() {
        return Err(format!("模板 .docx 文件不存在：{}", metadata.id));
    }

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
    })
}
