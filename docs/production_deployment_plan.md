# 日本生活文书助手 v0.11 — 正式部署、验证和回滚审批计划

**生成日期**：2026-11-11；**状态**：仅供集中审批。未创建文书助手生产资源、未执行生产迁移、未部署、未合并四个 Draft PR。所有命令仅为审批后操作说明，切勿在当前状态执行。

## 1. 已核实的保存点与四类验收

- 设计依据：Google Docs 最新 v0.11，第 24～32 章优先于历史示例；主仓库 PTamako/jp-document-assistant，原开发分支 feature/v011-implementation，PR #1。HomeFlow #296、家計簿 #294、知学 #162 均为 Draft。
- **代码已提交**：双人密码登录/邀请、私人共享权限、CSRF、D1/R2 上传与回收站、ZIP+AES-GCM 恢复、PDF/Office/EML 文字层、Google Picker 前端、只读候选与受保护联动、实验 OCR 预算、ICS。
- **自动测试**：最新 SHA 与 GitHub Actions 为唯一有效基线。现有测试为本地 SQLite/Mock R2/Mock 服务桥，并非 Cloudflare 真实服务联调。检查 CI 中语法、Node、SQLite/OpenAPI、Vue Build 四部分。
- **真实环境验证**：Cloudflare 已只读核查账号资源清单及两个 R2 Bucket 的公共域名状态；没有新应用的生产端到端测试。
- **未完成或阻塞**：真实脱敏日文 OCR 基准、Google 正式 OAuth、Gmail 只读增量、知学双人私人句卡、三端安全映射/联调、密码恢复及成员退出完整流程、双 iPhone 验收与最终独立安全审查。

## 2. Cloudflare 账号只读盘点（截至 2026-11-11）

- 现有 Worker 六个：homeflow、homeflow-preview、it-study-platform、kakeibo-homeflow-bridge、kakeibo-nav-sync、milkssales-jp；无 jp-document-assistant Worker。
- 现有 D1 六个：homeflow、homeflow-preview、kakebo_preview、kakebo、it-study-platform、milkssales-jp；**不存在文书助手专用 D1**，不能把它的迁移运行到以上任何库。
- 现有 R2 两个：homeflow-family-media、kakeibo-receipts。两者 r2.dev 公开访问均为 disabled，且未发现自定义 R2 公共域名。两者仍承载既有应用，复用前必须审核对象键前缀与访问权限，不得改变它们的原有生命周期、公开策略和业务数据。
- 账号计费用量 / 费用接口返回 HTTP 403，缺少 Billing Read 权限。因此存储使用 GB-month、R2 Class A/B、Workers AI Neurons、D1 实际读写、账号剩余额度、是否产生费用均为 **未知**；无权读到的指标不能写成 0 或充足。此次没有创建、修改或删除任何资源。
- 正式目标：一个 Worker（兼任 Static Assets 与 API）、一个**新建且经用户批准**的专用 D1、一个经审查的私有 R2 Bucket 绑定；不建 Preview Worker/DB/Bucket，不新增 Cron、Queue、KV、Durable Object，也不升级付费服务。

## 3. 生产配置与密钥清单

| 配置 | 类型 | 用途 / 审批前状态 |
| --- | --- | --- |
| DB | D1 Binding | 仅指向新应用唯一正式数据库；当前尚不存在 |
| DOCUMENTS | R2 Binding | 只指向审核后的私有 Bucket；按 owner ID + 随机键隔离；不开放直链 |
| ASSETS | Workers Static Assets Binding | Vue dist；与 API 在同一个正式 Worker |
| R2_BUCKET_NAME | 普通变量 | 与 DOCUMENTS 实际桶名匹配，不在代码中猜测 |
| SESSION_HMAC_KEY | Worker Secret | 独立高熵随机密钥，保护 CSRF；禁止入库/GitHub |
| BOOTSTRAP_ADMIN_TOKEN | Worker Secret | 仅供首次初始化；初始化成功后需按审批的安全方式停用/轮换 |
| BRIDGE_USER_MAP | Worker Secret | 经双端实名/映射核验的两个用户到三个目标服务各自身份；绝不从浏览器信任身份 |
| KAKEBO_BRIDGE_SECRET / HOMEFLOW_BRIDGE_SECRET / ZHIXUE_BRIDGE_SECRET | 各独立 Worker Secret | 对应受保护接收端 HMAC，不得复用同一个秘密 |
| KAKEBO_BRIDGE_SERVICE / HOMEFLOW_BRIDGE_SERVICE / ZHIXUE_BRIDGE_SERVICE | Service Binding | 需先审核目标 PR 和目标 Worker 正确入口；缺失时 fail-closed |
| ENABLE_EXPERIMENTAL_OCR | 普通变量 | 默认为 false；实测合格且另行授权才打开 |
| AI | Workers AI Binding | 仅在启用并明确验收免费模型前配置 |
| OCR_CALLS_PER_USER_DAY / OCR_APP_UTC_DAILY_LIMIT | 普通变量 | 独立用户与两人共享 UTC 日硬预算，默认低限额；不是 Cloudflare 全账号余额 |
| VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_API_KEY / VITE_GOOGLE_APP_ID | 非秘密构建变量 | 正式 Google OAuth/Picker 项目公开 ID 与已限制来源/API 的浏览器 Key；不存 Client Secret |

Cloudflare 生产 Secret 必须由用户在获批部署流程输入，不能写在 PR、文档、前端环境变量或 GitHub Actions 明文中。请注意当前 Wrangler 中 secret put 可能立即部署 Worker 新版本，**不允许提前执行**。签名密钥须在两个接收端独立配置并核对授权，不能以仅配置文书助手一侧为完成。

## 4. 执行顺序（全部是未来获批后的操作，不是本次执行记录）

1. **集中审批与冻结**：审核四份 PR 的最新 SHA、真实 CI、OpenAPI 端点与路由、迁移 0001～0010、Secrets/身份映射、OCR 和费用风险；获得明确生产变更批准。未完成的 P0 不得豁免。
2. **核对独立资源**：只读检查现有账号预算；确认正式域名、Worker 名、单独 D1 名称/UUID、R2 复用桶与私有前缀。若专用 D1 尚不存在，取得创建资源的单独批准后才创建。再审查托管 r2.dev/custom domains 始终关闭。
3. **灾难备份与本地演练**：归档当前三 App 既有生产配置、部署版本和 D1 可恢复备份；文书助手是新库则记录其空库状态。校验可读备份与 D1 Time Travel 可用性，不把备份留在仓库或新 R2 的公用前缀。使用本地 SQLite 和 Wrangler 本地模拟验证全部 10 份迁移的顺序、外键和回滚。所有真实生产数据操作前再次核对数据库 ID。
4. **三端桥接上线准备**：先合并经过安全审查且 CI 通过的目标端 PR（需要用户独立批准），配置目标端 Secret/用户白名单，保持桥默认 disabled，完成 Mock 及只读授权探测；不能直接跨写其生产 D1。知学私人句卡未完成前继续 fail-closed。
5. **替换占位符**：仅在经批准的部署版本中把 wrangler.jsonc 里的 REPLACE_WITH_EXISTING_OR_NEW_PRODUCTION_D1_ID、REPLACE_WITH_PRIVATE_PRODUCTION_R2_BUCKET 两处及桶变量填写为已核验 ID/名称。所有 Secret 只通过 Cloudflare 安全机制注入。不得部署含占位符的配置。
6. **正式迁移**：变更审批、备份与 ID 三重确认后，在与仓库绑定一致的目录执行命令：`npx wrangler d1 migrations apply jp-document-assistant --remote`。先阅读其计划清单和目标 UUID，再逐条检查 0001～0010；不得对 HomeFlow / 家計簿 / 知学现有库执行。
7. **正式 Worker**：审批后才配置 Secret 和 Service Bindings；使用单一 Worker 的 `npx wrangler deploy`，不允许 GitHub CI 自动部署，也不创建 Preview 资源。正式域名和 OAuth JavaScript Origin 须精确匹配。关闭额外路由/公共对象访问。
8. **上线小范围验收**：健康与登录、首次初始化、两账号并发会话、CSRF、未授权访问 404、共享二次确认、附件回收站、最后引用 R2 删除、D1 部分故障补偿、加密/原件 ZIP 完整往返、Google Picker 真授权、日历订阅撤销；OCR 不满足真样本基准则继续关闭。
9. **目标 App 最小真实联动（另行批准）**：仅使用双方可识别的真实且已确认测试项目；逐个执行创建/响应丢失/幂等查询，核对账目和任务不重复、无意外积分、私人生词不覆盖。任何未批准的生产写入均跳过。
10. **双 iPhone/iPad 真机验收**：由家庭两位成员验证私人/共享隔离、底部 Sheet、Tab 无旧数据闪现、取消选择无请求、原件可放大、OCR 小字确认、备份大文件内存、PWA 本地敏感缓存和系统日历；出现缺陷回到 Draft 分支修复。
11. **费用与运行观察**：取得官方云账号总量只读来源后对比操作前后 Workers 请求、D1 行读写、R2 存储/Class A/B、Workers AI Neurons、账单增量。未知时保守降级，不保证零费用。使用现有周报，无新 Cron。

## 5. 失败隔离及回滚

- **Worker 代码缺陷**：停用跨 App 联动及 OCR 开关，回退到已记录的上一个部署版本；Worker 版本回滚不等于 D1/R2 数据回滚。停止敏感读写，保留故障前后的请求幂等键和 D1 删除补偿日志。
- **D1 迁移或数据损坏**：按审批前确认的 D1 时间旅行书签或已校验导出备份开展恢复；恢复命令为破坏性生产数据操作，需新一轮明确授权。不可在无备份情况下盲目执行逆向 SQL。
- **R2 对象异常**：切断有问题的上传/清理接口；保留 storage_objects 和 deletion_jobs 状态，按精确 key 补偿或从经 SHA-256 验证的用户备份补传。禁止全桶 LIST/DELETE；没有原件的纯数据备份只能恢复元数据。
- **跨 App 请求不明**：保持原 candidate_id/idempotency_key/request_fingerprint；先查询目标端既有记录，确认后才允许原键重试。不得改金额/账户/任务内容后用同一键重发。
- **隐私或授权失控**：立即禁用相应入口与目标桥、撤销相关会话或 OAuth 授权、核查对象公开访问状态，保留最小不含 PII 的审计证据；严重事故暂停上线。

## 6. 免费包含量与明确风险

| 资源 | 官方 Free 包含量参考 | 超限/未知的处理 |
| --- | --- | --- |
| Workers | 100,000 请求/日（还需核实单请求 CPU 限制） | 所有已运行 Worker 共享，请按账号查实际用量；接口未知 |
| D1 | 5,000,000 行读/日、100,000 行写/日、账号 5 GB 存储 | 2026-09 起 Free 日行限额触发拒绝，不能把新 App 当独享余额 |
| R2 Standard | 10 GB-month、1,000,000 Class A、10,000,000 Class B / 月 | 已开通计费的桶超额可能收费；软预算和告警不等于硬挡 |
| Workers AI | 10,000 Neurons / UTC 日 | Free 超额通常无法继续；模型输入/输出真实用量需真样本测量 |

账单 API 当前返回 403，以上属于 **官方方案参考值**而不是当前账号剩余量。应用默认不执行 OCR、大图片不预加载、相同 hash 不重复上传、D1 五条分页、不用 R2 LIST/HEAD 形成列表，不新增 Preview/Cron。任何花费风险与是否升级套餐需用户独立批准。

官方参考：https://developers.cloudflare.com/workers/platform/limits/ 、https://developers.cloudflare.com/d1/platform/pricing/ 、https://developers.cloudflare.com/r2/pricing/ 、https://developers.cloudflare.com/workers-ai/platform/pricing/ 、https://developers.cloudflare.com/d1/reference/migrations/ 。

## 7. 正式批准的硬门槛（当前未满足）

- 所有四个 PR 经独立安全审查和最新 CI；合同与实际 Worker 路由完全一致；测试在本地/模拟环境覆盖并发、权限、R2/D1 部分失败、幂等和 ZIP 恢复。
- 已获授权脱敏真实日语样本的 OCR 关键字段准确率与 Neurons 已记录且达到用户接受的风险标准；否则 OCR 保持关闭并明示需要人工核验。
- Google OAuth、Gmail 如启用则需独立完成权限审核；Apple Mail 仍仅手动复制/附件/主动转发。
- 知学两人独立账户和私人句卡完全隔离，不允许公共词卡代替私密句卡。
- Cloudflare 正式 D1/R2/Worker 的 IDs、容量/费用、备份、Secrets 管理与 Worker 域名明确；真实使用量读不到继续写未知并确认风险。
- 双设备私密访问、恢复/删除、三端受控联动完成验收；用户集中批准后才依次执行变更。

**当前结论：未部署，未达到正式上线条件；本文件只是一份可审计的预部署操作清单，不是执行授权。**
