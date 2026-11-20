# 日本生活文书助手 — 2026-11-20 安全与可靠性审查整改

## 范围

本次在独立 Git 分支上修改代码，通过 PR 检查后合入 `main`，使用既有单一正式 Worker 的发布流程。**禁止创建 Preview Worker/D1/R2、重置生产数据库、重放历史财务或任务、修改真实用户的文书。**

## 代码整改

1. **共享文书外部翻译权限。** `GET /api/documents/:id/translation` 依旧执行现有的家庭可见范围查询，允许共享成员读取当前文本 SHA 对应的已有译文；`POST` 改用 `ownedDocument(...,'active')`，必须有原文书所有权。拒绝时在调用知学/Google 前返回 404，不会占翻译预算；即使客户端绕过隐藏按钮，也不能发送原文。
2. **前端共享态。** 共享成员点击翻译按钮先读取缓存；若未命中，只显示“请由原所有者翻译”提示，不再出现 Google 发送许可对话框；提交路径重复检查 `can_manage`。
3. **安全错误响应。** 原先正常响应已通过 `protectedResponse`，但是异常分支绕过 CSP、X-Frame-Options、Referrer-Policy。现将 401/403/5xx 等异常统一通过相同的响应头包装。
4. **低成本安全可观测性。** 保留现有 15 分钟 Cron，Worker 仅启用 1% 的日志采样；关闭自动 invocation logs，避免将 ICS 订阅 URL 的 bearer token、文书 ID 和查询参数写入持久日志。仅在 5xx 时打印受限的状态码和不包含个人资料的机器错误码，禁止打印原文、邮件、Cookie、OAuth 凭证、账号标识或异常消息。
5. **回归测试。** 使用内存 SQLite + Mock 家庭成员和外部翻译 Service Binding，覆盖共享成员首次翻译拒绝、零外部调用/零预算、所有者翻译后家人读取缓存、重复 POST 再拒绝、401/403/500 响应头一致以及 UI 权限一致。原有用电期间、账单金额、OCR、谷歌授权和财务联动测试继续在 CI 中运行。

## 安全边界与剩余真实验收

- 生产中记录的 1 条 `integration_links.state=synced` 只说明本地存过成功回执，不能证明家計簿/HomeFlow/知学的目标记录当前存在；真实端到端写入需要用户本人签名确认，并且不得擅自重建远端回收站记录。
- 当前 R2 无原件、D1 无 OCR 记录；没有合法脱敏图像的标注真值，不能声称 PaddleOCR / OCR.space / Moondream 日语金额日期识别精度通过。只保留人工核对、明确外部发送同意、调用限额和无结果失败策略。
- 双人 iPhone PWA 的真实设备 OAuth 回跳、共享权限变化、PDF 识别、ZIP 往返、原件恢复尚需本人设备验收，不可用 Mock/线上无登录烟测代替。
- Cloudflare 跨产品账单及账户级 Neurons 剩余额度必须从真实使用数据确认，不能只凭应用 D1 预算估计，也不应自动升级付费服务。
- 本次变更不修改 `migrations/` 或生产表数据、不新建资源、不把共享文书发往外部翻译。当前发布结果应以 PR CI 和 Cloudflare 版本/公开健康接口的实测记录为准，不能只凭文档宣布上线。

## 配置

- **唯一生产 Worker**：`jp-document-assistant`
- **D1**：`jp-document-assistant`（现有 28 条迁移）
- **R2**：`jp-document-assistant-private`（私有）
- **Cron**：`*/15 * * * *`（UTC，每 15 分钟）
- **日志**：`observability.enabled=true`, `head_sampling_rate=0.01`, `logs.invocation_logs=false`。

> 安全优先于发布速度；生产验证若未覆盖所有条件，应明确标注剩余验收项，而不是模拟测试或写入实际财务数据。
