use std::collections::BTreeMap;
use std::path::Path;

use crate::{AiPolicy, DraftingConfig, FieldDefinition, ModuleDefinition, WorkspaceConfig};

pub fn default_config(root: &Path) -> WorkspaceConfig {
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
        drafting: DraftingConfig::default(),
    }
}

/// 轻量迁移：只补系统字段和下拉选项，不覆盖用户自定义字段。
pub fn migrate_config(config: &mut WorkspaceConfig) -> bool {
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

pub fn field_with_flags(
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
