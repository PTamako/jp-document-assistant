# 日本生活文书助手 · JP Document Assistant

手机优先、两人使用的私人文书助手。**以 Google Docs v0.11 最终约束和 ZIP v1.0-rc1 的 D1/OpenAPI 设计为依据。** 默认私人，任何财务写入、家庭待办或生词同步都必须人工确认；识别所得的金额和到期日期不是已付款/到账事实。

## 当前可运行的代码

- Vue 3 / Vite 移动端 SPA：双人独立登录、单家庭与双人上限数据库约束、今日摘要、文书库、字段核验、原文与原件按需查看、收藏/归档、搜索、回收站、附件操作、备份/恢复界面和 iPhone 安全区样式。**不启用缓存私人资料的 Service Worker**。
- Cloudflare Workers API + D1：一次性初始化、邀请加入、14 天可撤销会话、HttpOnly Cookie/CSRF/登录限速，私人/共享文书隔离，日文文字规则抽取，和历转换与星期复核、金额取证、人工修改；OCR 原图不会被当作已识别。
- 私有 R2：图片/PDF 明确确认后上传、前端内存压缩、内容哈希去重、按需 GET、单附件/整份回收站与最后引用的永久物理删除，失败保留待清理状态并支持重试；异常上传的对象可由所有者手动执行小批清理，不使用 R2 LIST。
- 每批最多五份文书的 JSON/ZIP 备份；可选 AES-256-GCM + PBKDF2 加密、原件 SHA-256 校验、从备份确认恢复文书和附件；不自动重写其他 App。
- 家計簿 / HomeFlow / 知学：服务端签名与固定幂等键的源端适配，针对不同类型进行核验。**在目标侧专用桥、账号映射和授权未配置时明确拒绝写入**，不会通过公开 Cookie 或直接操作目标 App 的 D1。
- **OCR 重构（开发分支）**：PDF.js 优先提取原有文字层；扫描 PDF（最多 10 页 OCR）和 JPG/PNG/WebP 通过 PaddleOCR PP-OCRv6 日文 Small 的浏览器 WASM 路径产生待核对文字。OCR.space Engine 3 仅在附件本人明确同意第三方上传、管理员确认免费 API Key/调用预算后作为备选；结果仍须人工核对。**浏览器 SDK/模型跨域加载及 iPhone PWA 真机质量、内存、离线表现尚未完成安全验收，禁止把单元测试当生产验收**。
- **AI 智能分析（Cloudflare 默认启用，仅每份明确选择）**：每份文书单独选择 Cloudflare Workers AI、Gemini 免费 API 或纯规则；不使用全局用户设置。支持中文解释、原文引用核对、生活日语生词和句子候选以及 HomeFlow/家計簿需人工核对的建议。D1 按源内容哈希与引擎缓存，服务端每日次数限制。**Gemini 免费 API 不处理被判为敏感的文书，且必须逐份同意；免费层可能将数据用于改进产品**。知学生词和句子可以通过已签名的服务桥在你逐项脱敏、明确确认后同步；目标接收端由 it-study-platform PR #167 扩展，账号映射未配置或目标未部署时仍严格拒绝，不会假装同步成功。

## 开发与测试

要求 Node.js >= 20.19、Python 3.13 和 npm。首次安装：

```sh
npm install
npm test
npm run build
```

本地 Mock D1 使用 Node `node:sqlite` + Python `sqlite3`，完全不触碰 Cloudflare 生产数据库。GitHub Actions 只运行语法、单元测试及前端构建；**不进行部署或创建 Preview Worker / D1 / R2**。

## 云端环境（**未部署**）

1. **现有正式文书助手 D1** 使用 `wrangler.jsonc` 中已绑定的专用数据库 `jp-document-assistant`，与另外三个 App 的数据库分离。新功能需要增量迁移 `0011_document_ai_provider.sql` → `0012_document_ai_analysis.sql`；生产执行前先备份、确认现行版本，绝不向家計簿 / HomeFlow / 知学 D1 迁移，也不创建 Preview。
2. 单个正式 Worker 的静态资源托管 `dist/`，绑定 `DB`、私有 `DOCUMENTS` R2（可以使用已有 Bucket 的受限制前缀），不得为本项目建立 Preview。
3. 密钥仅写入 Worker Secrets，**不要提交至 GitHub**：`SESSION_HMAC_KEY`（高熵随机）、`BOOTSTRAP_ADMIN_TOKEN`（只用于首次管理员初始化）。可选的服务桥需要分别设置 `KAKEBO_BRIDGE_SECRET`、`HOMEFLOW_BRIDGE_SECRET`、`ZHIXUE_BRIDGE_SECRET` 和对应 `*_BRIDGE_SERVICE` / 固定 HTTPS `*_BRIDGE_URL`；双人身份映射保存在仅服务端可见的 `BRIDGE_USER_MAP` Secret。
4. 旧实验性 Cloudflare 视觉 OCR 已设置 `ENABLE_EXPERIMENTAL_OCR=false`。新的文书分析为 `ENABLE_DOCUMENT_AI=true`（必须逐份选择引擎）、`AI_ANALYSIS_DAILY_LIMIT=2`（全应用 UTC 日限额，不表示共享账户的实际免费余额）；启用前必须验证绑定模型可用性、完整免费额度、输入合规和样本准确率。Gemini 需 Worker Secret `GEMINI_API_KEY` 且显式确认 `GEMINI_FREE_ONLY_CONFIRMED=true`；OCR.space 需 Secret `OCR_SPACE_API_KEY` 和 `OCR_SPACE_FREE_ONLY_CONFIRMED=true`。禁止在网页暴露密钥、未经同意将私人文书上传第三方。
5. 禁止在 PR 运行 `wrangler deploy` / 远程迁移 / 生产 D1 写入。切换资源前先确认读写权限、R2 A/B 类计费和 Worker Free 当前限额。

## 使用限制及待验收

- Apple Mail iOS 统一收件箱 **不能被普通 PWA 自动读取**；目前支持复制文字、选择附件和手动上传，专用转发地址与 Gmail 独立 OAuth 尚未投入使用。
- 文字层优先；PaddleOCR 浏览器日文模型和 OCR.space 备选已经有开发代码与模拟测试，但**尚无正式 iPhone PWA 真机基准测试或准确率评分**。浏览器从 CDN 加载第三方运行时代码会扩大隐私和供应链风险；应改为固定版本的同源打包资源、核对模型许可证/哈希及存储占用后再部署。
- `0011`/`0012` 未应用生产数据库；新 OCR、AI 实际推理以及三个 App 的跨系统验收尚未完成。完成代码与模拟测试 **不代表生产上线**。
- 不支持在无法从 R2 或包含原件的备份恢复图片时宣称永久删除可撤销；远端三 App 已确认的数据不会因删除来源文书而自动消失。

源码公开不等于用户数据公开：仓库绝不包含个人工资、真实文书、登录密钥或生产样本。更多信息请见 `docs/` 设计、API、验证记录。
