# 日本生活文书助手 · JP Document Assistant

以手机为先的日本生活私人文书 PWA（Vue 3 + Cloudflare Workers Static Assets + D1 + 私有 R2）。双人独立账户，默认私人，所有财务记账、HomeFlow 任务和知学生词/句卡写入必须本人确认。文字识别出的金额、支付状态或日期不自动当作已付款、已到账事实。

## 当前正式环境（截至 2026-11-13）

- Cloudflare 正式 Worker：[jp-document-assistant](https://jp-document-assistant.yupan6706.workers.dev/)；专用 D1 `jp-document-assistant`；专用私有 R2 `jp-document-assistant-private`。Worker Preview URLs 关闭，没有任何本项目 Preview 数据库或 R2。
- 正式 D1 已核对 19 条迁移记录；支持文书、字段人工核验、回收站、附件清理、备份/恢复、家庭权限及 Google OAuth 授权记录。
- Gmail、Google Drive：服务器端加密 refresh token，iPhone PWA 通过浏览器授权并在返回时刷新状态。Gmail 搜索全邮箱，每页 5 封；不读取 iPhone Apple Mail 全部邮箱。
- 历史记录中曾有知学和家計簿联动成功，但本次只读查询文书助手的 `integration_links` 现为 0。远端是否仍保有记录需经用户主动签名核对；目标的删除/回收站记录不自动重建或新增。
- HomeFlow 允许本人选择私人或家庭共享任务；私人文书要共享任务元数据需要再次确认。家庭成员选项来自签名、当前家庭限定的 HomeFlow 只读接口，不能假冒其他账号。
- R2 文件保管：在 iPhone 浏览器内临时尝试图片 WebP/JPEG 压缩；一般图片以 300KiB 为目标，含日文小字的文书在安全清晰度下允许最多 900KiB。长边上限 2600px，压缩质量不低于 0.82，不为了达标强迫缩小到无法 OCR 的低分辨率；超过 900KiB 且无法保证清晰时明确提示分拆或改用 PDF。小于 300KiB 的图片原样上传，PDF、备份原件和非图片不重新编码。前端不将图片数据写入 IndexedDB/CacheStorage/相册，压缩过程仅临时占用 RAM，关闭导入界面即释放文件引用；浏览器/PWA 自身静态资源和 OCR 模型缓存另计。单文件真实上传仍受 Worker 8MiB 限制。R2 按用户与 SHA 去重，避免重复存储。
- OCR：PDF 有文字层时优先本机解析；扫描 PDF 和照片可选本机 PaddleOCR、Workers AI 或 OCR.space。Gemini 3.6 Flash 为用户逐份确认的外部 AI，应用内日限 20 次、分钟限 5 次；这些上限**不等于** Google/Cloudflare 实际免费余额。
- 文书详情按「原文 → 中文解释 → 字段 → 待办 → 学习」排序；全文日中机翻现在使用**知学既有 Google Apps Script LanguageApp**，通过 `ZHIXUE_BRIDGE_SERVICE` 与 `ZHIXUE_BRIDGE_SECRET` 在两个正式 Worker 之间进行 HMAC 签名调用。iPhone 不运行 227 MB OPUS-MT/ONNX 模型。仅在用户逐份勾选同意后发送已保存的日文文字，不发送照片、PDF 原件、密钥，不自动降级到 MyMemory、非正式 Google 译源或 Workers AI。每份最多 8000 字，拆成至多 8 段；文书助手按日本时间全站每日最多预留 80 次 Google 翻译调用（与知学词典共用 Google 账号免费额度，但并非全局精准余量）。译文仅在已有 D1 私有文书下按文本 SHA 复用；修改原文时失效，删除文书时级联删除缓存。机翻结果只用于对照，不影响原文、字段核验或 AI 中文解释。首次真机端到端翻译还需验收。
- OCR.space 已加入失败后五分钟冷却、同一原件最多一次明确重试、D1 原子抢占与每日预算保护；成功结果命中缓存时不重复调用。失败不自动重试。
- Google Drive 为全盘**只读搜索权限**（`drive.readonly`），而不是 Picker 的 `drive.file`；仅用户点击导入时才读取指定文件，不做后台全盘镜像。用户需理解授权范围。
- 旧 OPUS-MT 大模型中转 API 已从正在运行的 Worker 路由移除，不再提供手机端下载路径；历史本地模型源文件暂保留供测试与迁移参考。
- AI 中文解读改为 D1 持久队列后台处理，Google 503 最多自动重试 1 次；同一正式 Worker 使用每 5 分钟 Cron 兜底恢复中断任务，不创建 Preview 资源。
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
