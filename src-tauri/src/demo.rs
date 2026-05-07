use serde_json::{Map, Value};

pub fn demo_seed() -> Vec<(&'static str, Map<String, Value>, String)> {
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
