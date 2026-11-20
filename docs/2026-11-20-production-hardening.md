# 2026-11-20 第二轮只读验收与服务端安全收口

## 原则
- 生产数据绝不重置，不自动发起财务、提醒或学习联动；禁止 Preview。
- 用户承担真实 iPhone/PWA 操作、真实脱敏扫描件识别和端到端个人授权验证。
- 服务端只执行代码、内存测试、安全配置和云端只读巡检；每项部署必须核对版本。

## 只读生产快照
- 唯一 Worker `jp-document-assistant`，2026-11-20 17:14 JST 时正式版 147（此前已部署）。
- D1 28 条迁移、2 用户、1 家庭、1 条 trashed 文书、0 活跃文书、0 附件、0 OCR、0 AI 任务、1 翻译缓存。
- R2 对象 0；`integration_links` 现有 0 条，旧审查中的 1 条 synced 是历史快照，不能作为当前目标端存在证明。
- HomeFlow 身份 active 2 条，Google Gmail connected 2 条、Drive connected 1 条。
- Cron 为 15 分钟；1% 采样、关闭 invocation logs。
- Cloudflare Builds 没有配置本项目 trigger/build config；GitHub merge 后不能直接视为线上发布。
- 无实际个人文书操作、跨应用写入或清理行为。

## 此次代码收口
- 统一对财务普通收支、定期账单日期、Suica 充值与 HomeFlow 待办日期执行真实公历日期校验，防止例如 2026-02-31 通过仅正则校验进入跨应用边界。
- Wrangler 显式启用 `observability.redact_query_string=true`，防止未来日志/追踪恢复时查询参数进入记录；继续保留 1% 采样与关闭 invocation logs。
- 增加严格日期和安全配置的独立自动化回归，PR CI 必须通过。

## 尚由用户负责的实机验收
- 两位家庭成员真实 iPhone PWA／Google OAuth 的登录跳转与权限变化。
- 真实脱敏票据 OCR、AI 提示正确性、服务端用量与费用核对。
- 本人确认的 HomeFlow、家計簿、知学端到端同步；不通过仿造生产账务完成测试。
- ZIP 往返、R2 原件恢复、弱网和 Safari 日期控件实机试用。
