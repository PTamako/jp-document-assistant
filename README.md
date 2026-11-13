# 日本生活文书助手 · JP Document Assistant

以手机为先的日本生活私人文书 PWA（Vue 3 + Cloudflare Workers Static Assets + D1 + 私有 R2）。双人独立账户，默认私人，所有财务记账、HomeFlow 任务和知学生词/句卡写入必须本人确认。文字识别出的金额、支付状态或日期不自动当作已付款、已到账事实。

## 当前正式环境（截至 2026-11-13）

- Cloudflare 正式 Worker：[jp-document-assistant](https://jp-document-assistant.yupan6706.workers.dev/)；专用 D1 `jp-document-assistant`；专用私有 R2 `jp-document-assistant-private`。Worker Preview URLs 关闭，没有任何本项目 Preview 数据库或 R2。
- 正式 D1 已核对 18 条迁移记录；支持文书、字段人工核验、回收站、附件清理、备份/恢复、家庭权限及 Google OAuth 授权记录。
- Gmail、Google Drive：服务器端加密 refresh token，iPhone PWA 通过浏览器授权并在返回时刷新状态。Gmail 搜索全邮箱，每页 5 封；不读取 iPhone Apple Mail 全部邮箱。
- 知学有正式已同步记录；家計簿也有历史同步，但**家計簿可能在之后删除账目**。本仓库提供按需签名核对目标当前状态的代码，删除/回收站记录一律不自动重建。
- HomeFlow 允许本人选择私人或家庭共享任务；私人文书要共享任务元数据需要再次确认。家庭成员选项来自签名、当前家庭限定的 HomeFlow 只读接口，不能假冒其他账号。
- OCR：PDF 有文字层时优先本机解析；扫描 PDF 和照片可选本机 PaddleOCR、Workers AI 或 OCR.space。Gemini 3.6 Flash 为用户逐份确认的外部 AI，应用内日限 20 次、分钟限 5 次；这些上限**不等于** Google/Cloudflare 实际免费余额。
- 文书详情按「原文 → 中文解释 → 字段 → 待办 → 学习」排序；原文页可主动启动轻量日中 OPUS-MT 本地机翻，模型按需从公开 Hugging Face 下载（约 217 MB），文书正文只在独立浏览器 Worker 内处理，不持久保存翻译结果。首次下载耗时、iOS Safari 可用内存和译文精度仍需真机验收。
- AI 中文解读改为 D1 持久队列后台处理，Google 503 最多自动重试 1 次；同一正式 Worker 使用每 2 分钟 Cron 恢复中断任务，不创建 Preview 资源。
- Cloudflare Builds 发布命令只运行 JavaScript 语法、单元测试和生产构建，因为构建镜像 Python 3.13 缺少 `_sqlite3`；GitHub PR CI 仍运行完整 Python/D1 测试。
- Cloudflare 当前资源配置见 [wrangler.jsonc](wrangler.jsonc)；业务代码合并到 `main` 后使用 Cloudflare Builds 发布。PR CI 只做检查、测试、构建，不接触生产数据库、不创建 Preview。

## 开发和测试

需要 Node.js >=20.19 与 Python 3.13：

```sh
npm ci
npm run check:syntax
npm test
npm run build
```

测试使用内存 SQLite 与 Mock，不写入真实工资、账目、任务、积分或私人学习数据。正式操作仍需要签名、账号映射、人工确认和固定幂等键，绝不直接跨库写入三个目标应用。

## 仍需真实验收的项目

1. 第二位家庭成员及两台 iPhone PWA：账号私人/共享隔离、OAuth 回跳、长效授权、左滑与弹窗尺寸。
2. 经许可永久脱敏的真实扫描件：金额、日期、支付状态及 OCR 准确率、Safari WASM 内存和外部推理实际消耗。
3. 两台真实设备的备份 ZIP 往返、R2 原件恢复和异常网络重试；生产现有用户记录不得用来做破坏性测试。
4. HomeFlow 的真实签名写入与双方账号映射；家計簿回收站状态只读核对；远端删除不能默默复制新任务/账目。
5. Cloudflare Builds 使用项目专属用户级 Token；当前连接无 `/user/tokens` 管理权限，需从 Cloudflare 控制台更换。Cloudflare Billing Read 也需要授权才能核实真实费用与总免费余量。

以上项目未经实机/实账单验证时，不得宣布完整 v0.11 全部验收通过。详细历史与实施说明见 `docs/`。
