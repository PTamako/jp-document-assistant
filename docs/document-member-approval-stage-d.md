# 文书助手 → HomeFlow 成员审批申请（B/D/E Draft，尚未上线）

本模块只实现**受签名的成员申请及私有申请快照**，不是“管理员批准后已同步”。与原 [文书助手 PR #97](https://github.com/PTamako/jp-document-assistant/pull/97)、[HomeFlow 审批 PR #306](https://github.com/PTamako/homeflow/pull/306) 配套。四应用唯一交接文件仍为 HomeFlow main 的 `docs/four-app-development-handoff.md`。

## 流程与安全边界

1. 文书助手通过现有 HomeFlow SSO HttpOnly Session + 后端 session introspection 确认成员真实 `homeflow_user_id/household_id/role`。旧文书密码会话、管理员、共享文书协作者不能代替成员提交私人的候选同步申请。
2. 成员确认自己的原始候选、必要的已核验金额/日期、去敏词句和目标字段。与旧管理员直接同步复用同一套 `validatedPayload` 校验，但**不调用目标 App**。共享文书的协作者仍看不到来源 owner 的私人 `action_candidates/integration_links`。
3. 新增 **未执行** `0023_document_member_sync_intents.sql`，以 `candidate_id` 为不可变主键，保留来源 `document_id`、原始 `document_version/candidate_updated_at`、真实 local 和 HomeFlow actor、目标、SHA-256 与经过验证的私有快照。SQL trigger 禁止修改审批基础数据、撤回已存凭据或静默删除审计。原始文书与 R2 对象不被改写。
4. 文书后端仅用现有 `HOMEFLOW_BRIDGE_SERVICE` Service Binding 发送 `POST /api/internal/approvals/document-submit`。专用服务端 Secret 是 **64 个十六进制字符表示的原始 32 bytes**，HMAC-SHA256 的真实签名消息为 `jp-document-assistant\n{13位毫秒时间戳}\n{完整JSON body}`；不要误用普通文书旧桥接的 UTF-8 secret HMAC。请求绝不携带 Cookie/Origin/Bearer、原文、金额、银行号或远端 URL。
5. HomeFlow 只有 `APP_ENV=production`、`APPROVALS_ENABLED=true`、`DOCUMENT_APPROVAL_SUBMISSION_ENABLED=true`、`DOCUMENT_APPROVAL_SUBMISSION_SECRET` 已在安全 Secret 配置、并且 0053–0055 迁移就绪时才接受。必须在 HomeFlow DB 再检查成员活跃身份和真实 household；由后端按目标自动决定 `document.sync.finance/homeflow/study`，从稳定候选 ID 派生唯一 `jpda:sync:<candidate_id>` 幂等键。
6. 审批仅建立 HomeFlow `pending` 并有 member actor 不可变审计；即使 owner `approved`，本阶段也没有文书 `document.sync.*` 的目标执行器，绝不能通过旧 `/api/candidates/:id/commit` 让 member 绕过。这三种已批准工单在 HomeFlow PWA **不显示“执行入账”**，显示目标未更改。
7. HomeFlow 签名回执校验 `approval_id/target_app/household_id/requester_user_id/resource_id/digest/status/applied=false/target_changed=false` 后才将本地 `prepared→submitted` 并写一次真实 member audit。响应丢失/不确定只显示未确认，不假称已提交。可用 `resume_existing:true` 明确重试本地原始快照（仍校验用户、来源版本及哈希），HomeFlow 返回原审批 ID，不生成新业务。
8. PWA 仅在后台同时开放时显示“提交 HomeFlow 审批”或“重试原申请”；member 财务分类/支付来源只是**申请草稿**，尚待未来目标 App 按本人账户归属及版本再次确认。旧管理员同步路径保持原来的目标配置、二次确认、幂等键与完成回执语义。

## 尚未实现 / 不得上线代替

- HomeFlow 审核后安全执行 `document.sync.*` 的专用目标执行器、HomeFlow/家計簿/知学严格 actor 映射、目标独立授权与版本检查、远端幂等回执、丢包反查、失败状态反馈/提醒、撤回或拒绝后的来源候选处理。
- 个人金融账户的受签名目标选择器（目前成员只能填写待审批字段）、更改原文或永久删除时完整审批撤销/清理流程；因为申请快照不可变，**有审批意图的文书候选不能强制删除**，须先设计安全的结束/归档策略。
- 两位真实 iPhone 的独立 PWA 冷启动/退出/换号/被禁用、两服务端真实 Service Binding 签名/重放测试、生产迁移和回滚演练。

## 部署禁令（本 PR 均维持 Draft）

用户已经完成 A 阶段四 D1 加密备份、Mac 隔离 SQLite 恢复和六个 R2 对象校验，**不需要重新备份 A**。但用户**尚未授权**生产 SQL 迁移、新开关、合并会部署的功能 PR、新建 Preview 或 Cloudflare 正式部署。本模块仅在 GitHub Draft 内以本地 SQLite 和 mock Service Binding 测试。

本项目所有新旗标默认 **OFF**。文书助手端需要 `HOMEFLOW_SSO_ENABLED`、`DOCUMENT_APPROVAL_SUBMISSION_ENABLED`、私密 `DOCUMENT_APPROVAL_SUBMISSION_SECRET`、已有的 HomeFlow binding；HomeFlow 端需相同的专用密钥和 `APPROVALS_ENABLED` 等后台必要开关。**只在实际获得上线许可并完成迁移/隔离恢复、版本校验和人工跨 App 验收后才允许同时启用**。Secret 永远不写进 GitHub、Google Drive 备份目录或聊天记录。
