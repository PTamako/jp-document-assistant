## 2026-11-12 审查更新（仅以云端实测为准）

正式环境已运行，主分支安全冒烟测试通过；核心仍需完成双人真机、OCR 真样本和三端真实写入验收。2026-11-12 已完成修复：事先捕获生产 D1 Time Travel 书签，验证既有 Google OAuth/ OCR.space / Gemini 表与字段后，仅将缺失的 `0013`、`0014`、`0015`、`0017` 文件补入 `d1_migrations`，现已核对共 17 条且无重复；未重跑 schema、未修改用户数据或外部授权。PR #59 已合并，Cloudflare Workers Builds 成功部署最新版本，GitHub 无写入安全烟测成功。历史章节描述的是当时状态，不应以旧的「未部署」结论推断当前生产状态。任何测试都不得使用真实财务、积分或私人学习记录。

## 已执行的受限 Cloudflare 正式资源验收（2026-11-12 JST）

**最新状态：受限 core-only 测试版已在 Cloudflare 正式 Worker 上部署；完整 v0.11 仍 NO-GO。** 上文所列“未创建/未部署/等待审批”属于截至 2026-11-11 的历史审查状态，不能再用来描述当前真实云资源。

- 用户明确批准范围：1 Worker、1 D1、1 独立私有 R2 Standard Bucket，启用且仅启用单个 Worker 的正式 workers.dev 子域名；合成数据功能验收，不合并目标三 App PR、不启用真实 OCR/Google/Gmail/跨 App 写入。
- **正式 Worker：** `jp-document-assistant`，账号 workers.dev 域名 `https://jp-document-assistant.yupan6706.workers.dev/`；生产部署版本 `d53998d4-75d7-4d0d-a59e-42ce7ecc9252`，API 直接上传（未使用 GitHub CI 的生产密钥）。Preview URLs 禁用。
- **专用 D1：** `jp-document-assistant` (`22a671c0-3f6c-4707-adf1-b24ac95330c6`)，仅此空库执行 `0001～0010` 10 份迁移并记录于 `d1_migrations`。验收时 0 用户、0 文书、0 会话。
- **独立私有 R2：** `jp-document-assistant-private`，Standard，APAC；r2.dev managed public domain disabled，自定义 R2 域名空列表。合成文本对象实际 PUT/GET 精确比对/DELETE 成功，测试对象已删除。
- **公网实际访问：** [Actions #43050837126](https://github.com/PTamako/jp-document-assistant/actions/runs/43050837126) 对真实公网执行 GET：`/api/health` HTTP 200 + `ai_ocr:disabled`，首页 HTTP 200，已编译 Vue JS HTTP 200；代码测试 88/88 Node + 11/11 SQLite/API + Vue build。
- **临时交付差异：** Cloudflare 连接无法用上传会话 JWT 完成原生 Workers Static Assets 上传，所以将本次 Vite 打包的八个公开前端静态文件嵌入同一个 Worker 模块直接返回。无新增资源/原件外泄；但静态请求也会计入 Workers Free 的 100,000 日请求额度。仓库 `wrangler.jsonc` 保留正式配置 + 原生 `assets` 声明，后续人工使用 Wrangler 可切换回零额外 Workers 请求的原生静态托管；目前**实际部署不是原生 Workers Static Assets**。
- **首次账号初始化待用户操作：** Worker 已配置高熵 `SESSION_HMAC_KEY` 和 `BOOTSTRAP_ADMIN_TOKEN`，但后者是部署时自动生成、未向用户交付的 secret。为避免在 GitHub/对话泄露，用户需要在 Cloudflare Dashboard 的这个 Worker → Settings → Variables and Secrets 中**覆盖** `BOOTSTRAP_ADMIN_TOKEN` 为仅本人知道的独立随机值，再在网页版首次初始化其正式个人邮箱/12 位以上密码。此时不能声称双人真实登录已通过；初始化之后应移除/失效 Bootstrap Secret。
- **未覆盖的线上验收：** 用户私有/共享、登录/CSRF/注销、备份恢复的真实双人设备与 D1/R2 端到端，还需实际用户初始化或经另行保护的合成环境完成。Google OAuth/邮件、知学双人句卡、三个业务 PR 均未启用。
- **费用**：Cloudflare Billing Usage/Profile 均 403，真实费用、R2 A/B 次数与剩余量仍未知；正式资源创建与极少量测试操作已发生，并不保证 0 费用。

# 日本生活文书助手 v0.11 — 上线准备与人工批准清单

更新：2026-11-11。**不是上线完成声明。** 开发仓库当前只有 Draft PR；该文档不会自动执行云资源变更。

## 1. 代码、测试与真机区分

| 模块 | 已提交 | CI | 真实环境 |
| --- | --- | --- | --- |
| 双人登录、邀请、私人/共享文书 | 是；含个人会话查看/撤销、敏感默认私人、跨号内存清空/晚到响应拒绝 | 88 项 Node 与 11 项 SQLite/API 总体 CI 通过 | 双机/iPhone 待验 |
| 私有 R2、附件与文书回收站、永久删除、补偿 | 是；覆盖 D1 ready 但 R2 缺失、重复上传补传与回收站原件下载拒绝 | Mock 回归通过 | 真实 R2/D1 待验 |
| JSON/ZIP 备份/加密/恢复 | 是 | 本地往返通过 | iPhone 大文件/灾难恢复待验 |
| PDF、DOCX、XLSX、PPTX、.eml、.txt | 是 | 解析及 Worker 测试通过 | 各种真文书和系统版本待验 |
| Google Drive Picker | 是 | Mock 逐文件授权/下载通过 | 真实 Google OAuth 与 iPhone 待验 |
| Google Gmail 自动同步 | 自动 historyId 增量仍未实现；用户主动只读逐封导入、五件分页、内存 Token 撤销已编码 | Mock 测试待 CI | Google 受限 Scope 审核与 iPhone 真机待验 |
| 苹果 Mail | 手动导入/复制已实现 | 通过 | PWA 不可能直接读整个苹果邮箱 |
| 日文 OCR | 默认关闭的实验模式、双人预算、空结果冷却至少24小时且用户确认重试 | Mock 通过，模型官方 Schema 只读核验通过 | **真实脱敏样本准确率与单位 Neurons 阻塞** |
| 家計簿、HomeFlow、知学生词 | 三份默认关闭的签名桥 Draft PR | CI 通过 | 服务绑定/密钥/身份映射/真实联调待验 |
| 知学私人句卡 | 主项目明确 fail-closed | 通过 | 知学个人账户隔离及句卡接收端尚未实现 |
| ICS 私人订阅 | 可撤销随机订阅链接 | 通过 | iPhone 日历订阅/撤销待验 |
| OpenAPI 3.1 | 53 路径 / 54 操作 | YAML 严格解析及 Node/Python 契约检查通过 | 真实客户端契约待验 |

## 1A. 最新 CI 与实际 Cloudflare 核验

- 主 PR #1 最新已核验安全代码 `0d7bbf01a94451618b6dd11b96b2fd46e168fa91`；[GitHub Actions #43045926313](https://github.com/PTamako/jp-document-assistant/actions/runs/43045926313)：88/88 Node、11/11 SQLite/API 及 Vue Build 全部通过（2026-11-11）。属于开发环境自动化验收，**并未通过真实 Cloudflare D1/R2 或 iPhone 双人验收**。
- 连接 Cloudflare 只读检查：全账号 6 Worker、6 D1、2 R2 Bucket，两个现有 R2 Bucket 的 r2.dev 均关闭且无自定义公开域名；文书助手专用 Worker/D1 均不存在。
- Cloudflare Billing/Usage API 未获 Billing Read 权限（403）。实际计费、剩余月度容量、D1 日读写、R2 Class A/B、Workers AI Neurons 都是 **未知**，不代表零费用。
- 三份接收端 PR 均仍为 Draft；知学单用户结构未实现双人私密句卡，必须保持该写入路径 fail-closed。

## 2. Cloudflare 生产资源原则（严格执行）

- 一个 **正式 Worker**（同时提供静态 Vue 资源和 API），一个**新软件专用的正式 D1**。不得把迁移运行到 HomeFlow、家計簿或知学既有 D1。
- 一个**私有 R2 绑定**，优先复用经过路径隔离/权限检查的既有正式 Bucket；不启用 public bucket / 自定义公开图片域名。
- 不创建 Preview Worker、Preview D1、Preview R2，不创建 Cron、Queues、KV，GitHub Actions 无生产写权限。
- 上传压缩在浏览器临时内存完成。页面列表只查 D1，用户点开原件后才 GET R2；不遍历整个 Bucket。
- Workers AI 实验默认关闭；两个用户在本应用中共享 UTC 调用上限，默认每天 1 次，但这**不是 Cloudflare 全账号配额**。官方 Workers AI 免费额度当前为每天 10,000 Neurons（UTC 零点重置），所有同账户 App 共享，额度变化应在正式审批时再查官方来源和账号实际统计。**不自动升级付费**。
- 严禁带占位符执行 wrangler deploy，严禁在 CI 使用真实生产密钥试写数据库。

## 3. 尚需用户集中完成的外部步骤

1. 选择唯一正式 D1 和私有 R2 Bucket 的资源标识，检查现有 HomeFlow / 家計簿 / 知学配额，并确认迁移计划和回滚/备份。
2. 如启用 Google Drive Picker：为正式 HTTPS 源配置 Google Web OAuth Client ID、受 referrer 限制的 Picker API Key、Google Cloud 数字项目编号及授权测试账号。不可向仓库提供 Client Secret。
3. 如果要 Gmail 自动读取：评估独立 Gmail OAuth、必要最小 scope、Google App 验证/品牌/数据政策；上线前不得伪称 iOS PWA 可直接访问 Apple Mail 聚合收件箱。
4. 取得有明确许可且**永久脱敏**的日语工资、税费、票据、信用卡通知和政策原图；在不上传公开 GitHub 的前提下完成 OCR 与字段真值评分，确认是否适合使用免费推理模式。
5. 两位家庭成员在实际 iPhone/iPad 端验收私人文书不可见、共享二次确认、OCR 小字核验、日历订阅、R2 回收站/ZIP 恢复、大文件内存及退出登录。
6. 独立检查三份目标 App Draft PR 的签名密钥、服务绑定、账号身份映射、权限校验，**先通过只写本地 Mock 的联调**；任何生产灰度写入都需单独书面批准。
7. 在以上完成后再审核正式部署、真实 D1 迁移、三个目标 App 的桥接合并和生产配置。**本次均未申请自动执行**。

## 4. 当前发布判断

**不可直接上线**。主要非代码门槛：脱敏 OCR 的真实精度和单位用量，Google OAuth 和 Gmail 审核，知学句卡双人隔离，真实目标服务联调，两个 iPhone 的隐私/备份验证，以及生产资源审批。项目已具备可供审核的开发代码和自动化回归基础，但不能等同于完整验收。

## 2026-11-11 Gmail 与备份完整性审核增量

- Gmail：用户点击才请求受限 readonly OAuth；token 仅会话内存、谷歌 Scope 单独验证、5 件分页、选定一封才读 MIME 文字、不请求附件、手动保存并沿用私密导入 SHA 去重；已加入静态和纯模拟测试。Google 正式授权审批、撤销真机、完整 historyId 自动增量都未验收。
- 备份：新增 AES-GCM 错误密码、密文篡改、缺失/修改原件、版本不支持的失败拒绝测试；真实 D1/R2 灾难恢复仍需经过批准后在可控环境验证。
- Cloudflare 生产费用用量读取权限缺失：未知，不假定为零或充足。一个正式 Worker、专用 D1、私有 R2 方案仍只是拟议，未执行。

## 2026-11-11 部署前安全审查最终分级

- 代码已完成的 P0 新修复均有 CI 回归；最新已验证安全基线 `0d7bbf01a94451618b6dd11b96b2fd46e168fa91`，CI 88/88 Node、11/11 SQLite/API、Vue Build 全部成功。附加文档更新提交 CI 另行核实。
- Cloudflare 账号现有 6 Workers / 6 D1 / 2 R2；Billing Read=403、实际费用及余额未知；Zones 和 Workers Custom Domains 均为空，当前 workers_dev=false 的配置不能直接形成可访问的网址。
- **全功能正式发布 NO-GO**。只可在集中明确批准后创建一个正式 core-only Worker、专用 D1 与独立私有 R2，以合成资料先做真环境验收。禁止自动合并/部署目标三 App 或启用 AI/Gmail 受限 OAuth。详见 `docs/predeployment_security_audit.md`。
