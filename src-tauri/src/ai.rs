use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::Manager;

type AppResult<T> = Result<T, String>;

pub const DEFAULT_SYSTEM_PROMPT: &str = r#"你是法律业务管理系统的字段抽取助手。用户会给你一段中文文本（合同、邮件、起诉状、咨询记录、备忘等）。请按照下方"字段定义"，从原文中精确抽取每个字段的值。

规则：
1) 严格输出 JSON：键为字段 key，值为字符串。
2) 没有抽取到的字段，请直接省略不要包含；不要写空字符串、不要写"未提供"。
3) 日期统一为 YYYY-MM-DD（不补全为不准确的日期）。
4) 金额输出纯数字，不带千分位逗号、不带"元"。
5) 不要捏造任何数据；若不确定，请省略。
6) 只输出 JSON，不要 markdown 代码块包裹，不要任何解释或说明文字。"#;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    #[serde(default)]
    pub provider: String, // "openai" | "deepseek" | "anthropic" | "doubao" | "custom"
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub timeout_seconds: Option<u32>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResult {
    pub content: String,
    pub provider: String,
    pub model: String,
    pub latency_ms: u64,
}

fn ai_settings_path(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("ai.json"))
}

#[tauri::command]
pub fn load_ai_settings(app: tauri::AppHandle) -> AiSettings {
    let path = match ai_settings_path(&app) {
        Ok(p) => p,
        Err(_) => return AiSettings::default(),
    };
    if !path.exists() {
        return AiSettings::default();
    }
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => AiSettings::default(),
    }
}

#[tauri::command]
pub fn save_ai_settings(app: tauri::AppHandle, settings: AiSettings) -> AppResult<()> {
    let path = ai_settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_default_system_prompt() -> &'static str {
    DEFAULT_SYSTEM_PROMPT
}

#[tauri::command]
pub async fn ai_chat(settings: AiSettings, messages: Vec<ChatMessage>) -> AppResult<ChatResult> {
    let provider = if settings.provider.is_empty() {
        "openai".to_string()
    } else {
        settings.provider.clone()
    };
    let base_url = if settings.base_url.trim().is_empty() {
        default_base_url(&provider).to_string()
    } else {
        settings.base_url.trim().trim_end_matches('/').to_string()
    };
    let model = if settings.model.trim().is_empty() {
        default_model(&provider).to_string()
    } else {
        settings.model.trim().to_string()
    };
    let api_key = settings.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("尚未配置 API Key（去设置 → AI 配置）".into());
    }

    let timeout = settings.timeout_seconds.unwrap_or(60).clamp(5, 600) as u64;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{}", e))?;

    let started = Instant::now();
    let content = match provider.as_str() {
        "anthropic" | "claude" => {
            call_anthropic(
                &client,
                &base_url,
                &api_key,
                &model,
                &messages,
                settings.temperature,
                settings.max_tokens,
            )
            .await?
        }
        _ => {
            call_openai_compatible(
                &client,
                &base_url,
                &api_key,
                &model,
                &messages,
                settings.temperature,
                settings.max_tokens,
            )
            .await?
        }
    };
    let latency_ms = started.elapsed().as_millis() as u64;
    Ok(ChatResult {
        content,
        provider,
        model,
        latency_ms,
    })
}

#[tauri::command]
pub async fn ai_test(settings: AiSettings) -> AppResult<ChatResult> {
    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: "你是连通性测试助手，只能回复要求的内容。".into(),
        },
        ChatMessage {
            role: "user".into(),
            content: "请只回复两个汉字：连通".into(),
        },
    ];
    ai_chat(settings, messages).await
}

fn default_base_url(provider: &str) -> &'static str {
    match provider {
        "deepseek" => "https://api.deepseek.com/v1",
        "anthropic" | "claude" => "https://api.anthropic.com",
        "doubao" | "ark" | "volces" => "https://ark.cn-beijing.volces.com/api/v3",
        _ => "https://api.openai.com/v1",
    }
}

fn default_model(provider: &str) -> &'static str {
    match provider {
        "deepseek" => "deepseek-chat",
        "anthropic" | "claude" => "claude-sonnet-4-5",
        "doubao" | "ark" | "volces" => "doubao-1-5-pro-32k-250115",
        _ => "gpt-4o-mini",
    }
}

async fn call_openai_compatible(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    temperature: Option<f32>,
    max_tokens: Option<u32>,
) -> AppResult<String> {
    #[derive(Serialize)]
    struct Body<'a> {
        model: &'a str,
        messages: &'a [ChatMessage],
        #[serde(skip_serializing_if = "Option::is_none")]
        temperature: Option<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_tokens: Option<u32>,
        stream: bool,
    }
    let url = format!("{}/chat/completions", base_url);
    let body = Body {
        model,
        messages,
        temperature,
        max_tokens,
        stream: false,
    };
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{}", e))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("响应读取失败：{}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {} - {}", status, truncate(&text, 600)));
    }
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "响应不是合法 JSON：{}\n原始响应：{}",
            e,
            truncate(&text, 400)
        )
    })?;
    if let Some(err) = value.get("error") {
        return Err(format!("接口错误：{}", err));
    }
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|s| s.as_str())
        .ok_or_else(|| {
            format!(
                "响应缺少 choices[0].message.content：{}",
                truncate(&text, 600)
            )
        })?;
    Ok(content.to_string())
}

async fn call_anthropic(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    temperature: Option<f32>,
    max_tokens: Option<u32>,
) -> AppResult<String> {
    let mut system_text: Option<String> = None;
    let mut user_messages: Vec<serde_json::Value> = Vec::new();
    for m in messages {
        if m.role == "system" {
            system_text = Some(match system_text {
                Some(prev) => format!("{}\n\n{}", prev, m.content),
                None => m.content.clone(),
            });
        } else {
            user_messages.push(serde_json::json!({
                "role": m.role,
                "content": m.content,
            }));
        }
    }

    #[derive(Serialize)]
    struct Body<'a> {
        model: &'a str,
        max_tokens: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        system: Option<String>,
        messages: Vec<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        temperature: Option<f32>,
    }
    let body = Body {
        model,
        max_tokens: max_tokens.unwrap_or(2048),
        system: system_text,
        messages: user_messages,
        temperature,
    };
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{}", e))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("响应读取失败：{}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {} - {}", status, truncate(&text, 600)));
    }
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "响应不是合法 JSON：{}\n原始响应：{}",
            e,
            truncate(&text, 400)
        )
    })?;
    if let Some(err) = value.get("error") {
        return Err(format!("接口错误：{}", err));
    }
    if let Some(arr) = value.get("content").and_then(|c| c.as_array()) {
        let mut out = String::new();
        for item in arr {
            if let Some(t) = item.get("text").and_then(|s| s.as_str()) {
                out.push_str(t);
            }
        }
        if !out.is_empty() {
            return Ok(out);
        }
    }
    if let Some(s) = value.get("content").and_then(|s| s.as_str()) {
        return Ok(s.to_string());
    }
    Err(format!("响应缺少 content[].text：{}", truncate(&text, 600)))
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut s: String = text.chars().take(max).collect();
    s.push('…');
    s
}
