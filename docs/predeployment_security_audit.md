# 《日本生活文书助手》v0.11 部署前安全审查与集中审批申请

日期：2026-11-11（JST）。本文件对应 **代码安全审查及 Mock 验收**，不是 Cloudflare 生产环境通过验收的声明，也不是用户的生产部署授权。

## 1. 基准、完整性与来源

- 最新规范：Google Docs《日本生活文书助手 详细设计书》，截至本次读取的版本，第 24～33 章优先；需求规定完整 v0.11 的实际身份、备份、OCR、三端联动及双 iPhone 验收不可省略。
- GitHub：主项目 `PTamako/jp-document-assistant` PR #1 / `feature/v011-implementation`；HomeFlow #296、家計簿 #294、知学 #162 三个 Draft 接收端 PR。四个 PR 均未合并。此次未更改三个目标仓库。
- 安全代码截至 `0d7bbf01a94451618b6dd11b96b2fd46e168fa91` 已通过 [CI #43045926313](https://github.com/PTamako/jp-document-assistant/actions/runs/43045926313)：**88/88 Node、11/11 SQLite/API、Vue 生产构建**。本次文档提交自己的 CI 必须再检查。完整成功 CI 仅证明列出的自动测试通过。
- 审查使用 GitHub 源码/PR 补丁、最新 Cloudflare 只读 API 和官方 Cloudflare 定价/限制文档。未使用真实个人工资、卡号、邮箱或家庭业务数据做写入试验。

## 2. 安全结论分级

| 维度 | 结论 | 实际证据 / 尚缺条件 |
| --- | --- | --- |
| 登录/会话 | **代码/Mock 通过，真实设备待验证** | HttpOnly+Secure+SameSite=Strict、14 天过期、PBKDF2 密码、CSRF+Origin、按账号撤销设备、改密码撤销旧会话、邀请并发及双人限额 |
| 资源权限 | **代码/Mock 通过，真实 D1 待验证** | 服务端检查 owner/household/visibility；非本人不可读取私有附件、备份、回收站、候选；敏感文书默认 private，替换为工资等内容撤销旧共享 |
| 前端私密内存 | **已修复，Mock/静态检查通过** | 切账号清空回收站、备份 ZIP、密码、Gmail Token、会话、原图 URL、使用量；旧 API/R2 请求 Abort + epoch 拒绝延迟响应/下载 |
| R2 一致性与永久删除 | **故障模拟通过，真实 R2 待验** | 原件恢复/重复导入/追加扫描页均校验 D1 ready 不代表物理 R2 存在；R2 失败不建立假成功引用；DELETE 成功/D1 失败补偿、最后引用检查及无 R2 LIST |
| 备份/灾难恢复 | **本地通过，跨版本和真机待验** | ZIP/AES-GCM+PBKDF2、SHA-256、错误口令/损坏/缺原件拒绝、元数据+原件恢复、跳过重复；不自动重发目标 App。只支持当前 `schema_version=1.0`，不宣称任意旧版恢复 |
| Gmail / Drive | **Mock 验收，正式 OAuth 未配置** | Google Picker 按文件读取、Gmail 仅主动授权/逐封文字，Token 不持久化；Google 受限权限审核和 iPhone 实测仍待完成 |
| OCR | **生产禁用** | 官方模型输入/输出 Schema 核对，空返回后受控重试、UTC 双人预算、人工确认；真实脱敏日文准确率、Neurons/张未知 |
| 三 App 写入 | **生产禁用** | 目标 Draft 接口采用 HMAC、时间戳、白名单、幂等；目标未合并/配置，不做真实财务、任务、积分写入；知学双人私密句卡未完成 |
| CI/发布安全 | **自动门禁通过** | `.github/workflows/ci.yml` 只读 GitHub Token、本地 SQLite/构建，无 Cloudflare 生产 Secret、无自动 Preview、部署或远端迁移。新增 `tests/release-preflight.test.js` 防误配置 |

## 3. 本轮实际修复和提交

1. [`7b3c83e5`](https://github.com/PTamako/jp-document-assistant/commit/7b3c83e5951ee5ab10386d3e9a0fd0bb6c990a8b)：追加扫描页相同附件复用或复用已有对象时先校验 R2 缺失并安全补传；restore-upload 增加单文书 30 附件限制。补齐跨账号对象复用、失败注入 Mock。
2. [`0a00aae5`](https://github.com/PTamako/jp-document-assistant/commit/0a00aae5f372af5617521804d71e17611e8a1ce6)：旧账号延迟响应 epoch 丢弃、双人私人 UI 状态统一清除、原图与多步备份恢复切号保护。
3. [`55b2eee6`](https://github.com/PTamako/jp-document-assistant/commit/55b2eee6edf3a1865ca1ec8effd88e61456cc692)：旧账号 API/R2 请求主动 Abort，私有 ZIP 生成下载前再次确认所属账号，Drive 异步文件解析禁止跨号污染。
4. [`0d7bbf01`](https://github.com/PTamako/jp-document-assistant/commit/0d7bbf01a94451618b6dd11b96b2fd46e168fa91)：增添不可绕开的 CI 静态部署门禁，确保未获批准前只有一个 Worker/D1/R2 绑定定义、零预览/定时/附加计费资源，禁止 CI 使用生产权限。

## 4. Cloudflare 真实只读资源审查

- 当前账号已有 **6 个 Worker、6 个 D1、2 个 R2 Bucket**；文书助手专用 Worker/D1 仍不存在。两个现有 R2：`homeflow-family-media`、`kakeibo-receipts`；此前读取显示二者的 r2.dev 公开访问关闭，未见自定义公共域名。
- **Cloudflare Zones 返回空列表、Workers Custom Domains 返回空列表**，已有 workers.dev 账号子域名为 `yupan6706`。当前 `wrangler.jsonc` 写的是 `workers_dev:false`、`preview_urls:false`、没有 routes。原样部署不会自动获得可供 iPhone 访问的网址。
- Cloudflare Billing Usage/Profile 均返回 **403（Billing Read 权限不足）**。全账号当前 Workers 请求、D1 读写/存储、R2 GB-month 和 Class A/B、Workers AI Neurons、实际费用/超额均为 **未知**，不得作为 0 或可用余额。
- 官方 Free 额度参考：Workers 100,000 请求/日；D1 5M 行读/日、100k 行写/日及总 5 GB；R2 Standard 10 GB-month、1M Class A、10M Class B/月；Workers AI 10k Neurons/UTC 日。上述是账号共享**套餐参考额**，不是已确认账号剩余额度。R2 超量可能计费；免费使用不等于自动硬断费。
- R2 官方定价将前 100,000 Bucket 纳入桶数包含量；已有 2 Bucket，拟创建一个**独立私有新 Bucket**不会因为桶数本身带来固定月费，但仍产生按账号聚合的存储/操作消耗。独立 Bucket 比复用 HomeFlow/家計簿 Bucket 更符合工资、证件的最小访问权限（既有两个 Worker 无法再访问新应用 R2）。
- 官方核对：https://developers.cloudflare.com/workers/platform/limits/ 、https://developers.cloudflare.com/d1/platform/pricing/ 、https://developers.cloudflare.com/r2/pricing/ 、https://developers.cloudflare.com/workers-ai/platform/pricing/ 、https://developers.cloudflare.com/d1/reference/time-travel/ 。

## 5. 发布判定与不能跳过的缺口

**完整 v0.11 正式上线：NO-GO。** 缺少知学私人句卡双人身份、三端签名映射真实端到端、获授权日本原件的 OCR 真值与费用、Google 正式受限 OAuth 验证、成员退出/忘记密码全流程、Cloudflare D1/R2 真环境恢复及两位成员 iPhone 验收。这些不得通过 Mock 或绿色 CI 替代。

**受限核心功能首次云端验收：在用户集中授权后可作为下一阶段，而非宣称全功能上线。** 仅用合成非敏感测试数据验证两个独立账号、私密/共享、上传/删除/恢复、备份和权限；默认关闭 Workers AI/OCR、所有目标 App 写入、Google OAuth/Gmail 正式连接。没有通过云端实测前不得上传真实敏感材料。

## 6. 集中申请的生产变更范围（本文件尚不是授权）

建议一次审批以下**受限首次部署**，审批后才执行：

1. 新建**一个** `jp-document-assistant` 正式 Worker（同一 Worker 承载 SPA+API），新建**一个**专用 D1 `jp-document-assistant`，新建**一个**私有 R2 Standard Bucket（拟名 `jp-document-assistant-private`）；不连接已有 HomeFlow/家計簿 R2。
2. 因账号暂无 Cloudflare Zone，需**明确允许**仅对这一个正式 Worker 启用 `workers_dev:true` 以获得 `jp-document-assistant.yupan6706.workers.dev` 形式 HTTPS 访问地址（部署后以真实返回地址为准）；仍强制 `preview_urls:false`，不建 Preview Worker/DB/R2/Pages/Cron/Queue/KV/DO。
3. 仅通过 Cloudflare 受保护配置注入新的 `SESSION_HMAC_KEY` 与 `BOOTSTRAP_ADMIN_TOKEN`；不使用三个旧 App 的密钥；首次初始化后禁用/轮换 Bootstrap Token。正式 D1 迁移 0001～0010 只针对经过 ID 核对的**新空库**。
4. 部署 core-only Worker，先做只读健康检查，再经用户批准范围内以**合成非敏感数据**做小规模 D1/R2 写入、恢复与精确 DELETE 回归。测试完核对账单/错误与资源用量；如未知，明确限制上传与 AI，不宣称零费用。
5. **本次审批明确不包含**：合并或关闭四个 Draft PR、修改 HomeFlow/家計簿/知学生产设置、读取/上传真实私人文书、启用收费 OCR/AI、Google OAuth/Gmail 正式授权、自动产生真实记账/任务/积分或删除任何现有生产资源。
6. 如上线出现越权、R2/D1 一致性故障，停止写入并回滚 Worker 版本；D1 Time Travel 的真实回滚属于另一次破坏性操作，需再明确批准；R2 不与 D1 事务原子回滚。不得为了回滚自动删除旧 App 资源。

## 7. 审批和真实验收的检查项

- [ ] 用户批准上述精确资源、workers.dev 可访问入口、一次新 D1 迁移和受限合成数据写入；明确接受当前 Billing Read 缺失与 R2 超额风险或先补齐账单只读权限。
- [ ] 执行前复查四个 PR SHA、最新 CI、Cloudflare 资源/计划、真实 Bucket 隐私、域名及新 D1 UUID；无变更冲突。
- [ ] 首次部署只打开核心功能，Google/Gmail/Workers AI/三端桥全关；生产 Secret 不回显或存储在 GitHub。
- [ ] 两账号真机验收分开登录、共享确认、私密文件、回收站、附件、加密备份/恢复、R2 操作次数、存储与费用。
- [ ] 真实核查完毕且满足 v0.11 必选功能后，另行将 Draft PR 提交代码审查与最终全功能上线批准；不可把本次核心验收部署冒充完整正式发布。

**最终状态：安全代码与自动测试已达到申请受限首次部署的阶段；完整 v0.11 的正式上线条件仍未满足。**
