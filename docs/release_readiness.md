# 日本生活文书助手 v0.11 — 上线准备与人工批准清单

更新：2026-11-11。**不是上线完成声明。** 开发仓库当前只有 Draft PR；该文档不会自动执行云资源变更。

## 1. 代码、测试与真机区分

| 模块 | 已提交 | CI | 真实环境 |
| --- | --- | --- | --- |
| 双人登录、邀请、私人/共享文书 | 是；含个人会话查看/撤销和敏感文书自动恢复私密 | 72 项 Node 与 11 项 SQLite/API 总体 CI 通过 | 双机/iPhone 待验 |
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

- 主 PR #1 最新保存点 `ed79213870c8402be6f2eb1e14cdf19a0c17d53b`；[GitHub Actions #43036305622](https://github.com/PTamako/jp-document-assistant/actions/runs/43036305622)：72/72 Node、11/11 SQLite/API 及 Vue Build 全部通过（2026-11-11）。属于开发环境自动化验收，**并未通过真实 Cloudflare D1/R2 或 iPhone 双人验收**。
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
