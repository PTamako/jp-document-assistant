# 日本生活文书助手 · JP Document Assistant

手机优先、两人使用的私人文书助手。**以 Google Docs v0.11 最终约束和 ZIP v1.0-rc1 的 D1/OpenAPI 设计为依据。** 默认私人，任何财务写入、家庭待办或生词同步都必须人工确认；识别所得的金额和到期日期不是已付款/到账事实。

## 当前可运行的代码

- Vue 3 / Vite 移动端 SPA：双人独立登录、今日摘要、文书库、字段核验、原文与原件按需查看、收藏/归档、搜索、回收站、附件操作、备份/恢复界面和 iPhone 安全区样式。**不启用缓存私人资料的 Service Worker**。
- Cloudflare Workers API + D1：一次性初始化、邀请加入、14 天可撤销会话、HttpOnly Cookie/CSRF/登录限速，私人/共享文书隔离，日文文字规则抽取，和历转换与星期复核、金额取证、人工修改；OCR 原图不会被当作已识别。
- 私有 R2：图片/PDF 明确确认后上传、前端内存压缩、内容哈希去重、按需 GET、单附件/整份回收站与最后引用的永久物理删除，失败保留待清理状态并支持重试；异常上传的对象可由所有者手动执行小批清理，不使用 R2 LIST。
- 每批最多五份文书的 JSON/ZIP 备份；可选 AES-256-GCM + PBKDF2 加密、原件 SHA-256 校验、从备份确认恢复文书和附件；不自动重写其他 App。
- 家計簿 / HomeFlow / 知学：服务端签名与固定幂等键的源端适配，针对不同类型进行核验。**在目标侧专用桥、账号映射和授权未配置时明确拒绝写入**，不会通过公开 Cookie 或直接操作目标 App 的 D1。
- Workers AI：实验性视觉识别仅在显式开关 + AI Binding + 每用户每日预算下可调用；返回空/失败时不保存识别文字、不编造成功；实际免费日文 OCR 的生产可信度仍需真实脱敏样本验证。

## 开发与测试

要求 Node.js >= 20.19、Python 3.13 和 npm。首次安装：

```sh
npm install
npm test
npm run build
```

本地 Mock D1 使用 Node `node:sqlite` + Python `sqlite3`，完全不触碰 Cloudflare 生产数据库。GitHub Actions 只运行语法、单元测试及前端构建；**不进行部署或创建 Preview Worker / D1 / R2**。

## 云端环境（**未部署**）

1. 使用新的正式 D1，**不能用家計簿、HomeFlow、知学的数据库**，对新库按 0001 → 0002 → 0003 → 0004 顺序执行迁移，执行前先备份和演练。本仓库中 `wrangler.jsonc` 的 D1 和 R2 ID 是占位符，部署前须由所有者审核并填入真实绑定。
2. 单个正式 Worker 的静态资源托管 `dist/`，绑定 `DB`、私有 `DOCUMENTS` R2（可以使用已有 Bucket 的受限制前缀），不得为本项目建立 Preview。
3. 密钥仅写入 Worker Secrets，**不要提交至 GitHub**：`SESSION_HMAC_KEY`（高熵随机）、`BOOTSTRAP_ADMIN_TOKEN`（只用于首次管理员初始化）。可选的服务桥需要分别设置 `KAKEBO_BRIDGE_SECRET`、`HOMEFLOW_BRIDGE_SECRET`、`ZHIXUE_BRIDGE_SECRET` 和对应 `*_BRIDGE_SERVICE` / 固定 HTTPS `*_BRIDGE_URL`；双人身份映射保存在仅服务端可见的 `BRIDGE_USER_MAP` Secret。
4. 视觉 OCR 默认不启用。只有样本验证且明确接受预算后再设 `ENABLE_EXPERIMENTAL_OCR=true`、绑定 `AI`，使用保守的 `OCR_CALLS_PER_USER_DAY`。**模型调用可能消耗同一个 Cloudflare 账户的共享免费用量，不能保证零账单**。
5. 禁止在 PR 运行 `wrangler deploy` / 远程迁移 / 生产 D1 写入。切换资源前先确认读写权限、R2 A/B 类计费和 Worker Free 当前限额。

## 使用限制及待验收

- Apple Mail iOS 统一收件箱 **不能被普通 PWA 自动读取**；目前支持复制文字、选择附件和手动上传，专用转发地址与 Gmail 独立 OAuth 尚未投入使用。
- 文字层优先；图片/PDF OCR 需真实脱敏样本和 Neurons 实测。人工粘贴及核对链路可用，但不应当被宣传成已通过日本工资单/政府文书的自动准确率验收。
- 生产 Cloudflare D1/R2、iPhone 双设备及三个目标 App 跨系统验收尚未完成。完成代码与模拟测试 **不代表生产上线**。
- 不支持在无法从 R2 或包含原件的备份恢复图片时宣称永久删除可撤销；远端三 App 已确认的数据不会因删除来源文书而自动消失。

源码公开不等于用户数据公开：仓库绝不包含个人工资、真实文书、登录密钥或生产样本。更多信息请见 `docs/` 设计、API、验证记录。
