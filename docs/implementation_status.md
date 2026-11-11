# 日本生活文书助手 — 实施保存点与验收缺口

更新日期：2026-11-11。依据 Google Docs v0.11（最新版）及工程 ZIP。以下区分 **代码已提交**、**本地已验证**、**目标 App 待合并** 和 **生产尚未验证**；不可将开发态声明为上线态。

## 保存位置

- 主工程 [PR #1](https://github.com/PTamako/jp-document-assistant/pull/1)：`feature/v011-implementation`。
- HomeFlow 专用服务桥 [PR #296](https://github.com/PTamako/homeflow/pull/296)：默认关闭，只在双端独立授权后接受签名请求。
- 家計簿专用服务桥 [PR #294](https://github.com/PTamako/kakebo_jp/pull/294)：默认关闭，单账本 actor 白名单、D1 幂等、疑似重复支出拦截。
- 知学专用服务桥 [PR #162](https://github.com/PTamako/it-study-platform/pull/162)：默认关闭，已有生词词条跳过，不覆盖个人释义。
- 四份 PR 均为 Draft，**未合并至正式分支、未部署、未使用任何生产数据做写入测试**。

## 当前代码完成与测试

| 模块 | 代码状态 | 验证范围 / 限制 |
| --- | --- | --- |
| 双人身份 | 密码登录、初始化、邀请、会话/CSRF/限速、单家庭/双用户 D1 约束 | Node + SQLite，包括同邀请码并发加入 |
| 文书库 | 文字导入、私人/共享、收藏/归档、轻量搜索、字段人工核验、五条分页、今日摘要 | 规则抽取，不等于完整机器翻译 |
| 附件/R2 | 私有对象上传、去重、按需查看、附件级回收站/恢复、最后引用永久物理删除、可重试清理 | 已用 Mock R2 验证，生产 R2 未验 |
| 数据备份 | JSON/ZIP 分批、可选 AES-GCM、SHA-256 原件检查、元数据 + 原件恢复、缺失对象主动补传 | 已通过“ZIP → 空数据库 → R2 恢复 → 重试无重复”的本地端到端测试 |
| 财务联动 | 人工确认金额/到账或付款日期、HMAC 签名、稳定幂等键、目标服务失败重试；已发出候选禁止重建 | 未配置目标服务前拒绝写入，真实家計簿写入未验 |
| 家庭任务联动 | 截止日核验、保密范围、负责人、用户明确指定额外积分 | HomeFlow bridge PR 未合并，实际钱包/双人映射待验 |
| 知学联动 | 词汇候选 + 强制脱敏确认 + 私人词条 skip-existing | 目标生词桥 PR 未合并；私人句卡与双人知学账户尚未完整实现 |
| iPhone UI | Vue 3 手机优先、Bottom Sheet、原件按需加载、无敏感离线持久缓存 | CI 只验证构建，未经过 iPhone/iPad 实机验收 |
| 扫描页排序 | 已实现附件稳定 ID 的上移/下移、服务端版本/数量校验、完整事务更新；无需重新上传或读取 R2 | 本地多页、版本冲突、重复 ID 与零 R2 操作测试；CI 已验证 |
| 本地邮件导入 | 由用户明确选取 .eml/.txt，浏览器内存提取纯文字与日文编码/MIME，跳过附件；确认后保存为私人文书 | 五项解析测试、一项端到端测试；不能自动读取 Apple Mail 聚合邮箱 |
| 本地 PDF / Office 文字层 | PDF.js 按需提取文字；DOCX/XLSX/PPTX 由用户选择后本机解析；默认只保存文字而不上传 R2；选择原件才私有存储 | 实际 DEFLATE Office、XML/CRC、异常膨胀及原件拒绝用例通过；公式缓存值、日期单元格仍需人工核验 |
| 非财务条款解读 | 政策、合同、活动、说明书的关键限制词句显示日文原文证据、中文说明与人工核对动作；文书版本日期线索与官方现行有效性严格分开 | 纯规则抽取，不作机器全文翻译或法律实时验证 |
| OCR | 按需实验模型、同 R2 对象结果缓存、失败和空响应去重、人工修正；个人与本应用 UTC 额度双重硬上限，24h 卡住需用户再次确认 | Mock 测试通过；**真实脱敏日本文书准确率、Neurons/张仍未验证**，默认禁用 |

当前最后一轮安全代码 CI：主工程 **88/88 项 Node + 11/11 项 SQLite/API 契约** 通过；GitHub Actions 对主工程执行语法、测试及 Vue 构建。所有目标 PR 均必须在最新提交 CI 通过后才可视为通过对应 CI，不能以旧提交结果代替。

## 仍未完成的功能 / 真正上线阻塞

1. **真实图片 OCR**：需授权的脱敏工资条/缴费单/信用卡/政策文书原图，记录字段准确率、来源证据、Neurons 成本及误识别；若模型输出为空，使用手动文本输入，不伪造结果。
2. **Google Drive / Gmail / 苹果邮件**：当前支持手工粘贴、本地 .eml/.txt 文字提取及照片/PDF 原件；Drive Picker 的逐文件授权读取代码和测试已完成，正式 Google OAuth 客户端及 iPhone 实测尚未配置；邮件转发专用地址和 Gmail 独立 OAuth 增量同步仍未完成。普通 iOS PWA 不能读取 Apple Mail 全邮箱。
3. **文件类型与解释尚未完备**：PDF/Office 可复制文字层、原文证据条款已完成；仍缺扫描件免费日文 OCR 真实准确率测试、Office 公式/日期样式的可靠呈现、完整段落翻译以及复杂表格和图片中的限制条件解释。
4. **三 App 真实服务联调**：受保护桥需各自合并并配置 Service Binding/HMAC Secrets、正确的双人账户映射，先本地 Mock，再经允许的生产灰度验证；禁止直接跨写目标 D1。
5. **备份与生命周期极端场景**：R2 DELETE 成功但 D1 清理失败后重试已通过 Mock 测试；多原件部分失败、ZIP 分包缺失、加密错误/跨版本恢复、批量附件/文书回收站的真实双设备测试仍需验证。
6. **数据契约**：OpenAPI 当前为 53 路径 / 54 操作（包含新增会话管理接口），严格 YAML 解析、重复键与已实现字段检查已通过 CI；正式部署前仍需外部真实客户端契约测试。
7. **安全/运营**：密码找回与成员退出/私有资料迁移、OAuth token 撤销、所有用户数据完整删除、多源重复事件聚合、额度实时监控仍需完善。
8. **正式部署**：一个正式 Worker + 一个正式 D1 + 私有 R2，正式绑定 ID/Secrets 尚未配置。零 Preview 资源，未运行远程迁移，未将功能上线。生产执行必须先备份、审核与审批。

## 续做优先级

先闭环最新 CI 和 OpenAPI → 完善目标服务桥成功路径的本地端到端测试 → 原件恢复/删除故障注入 → 文件文字层解析及免费 OCR 真实样本 → 用户权限与双人 iPhone 验收 → 审核并申请正式生产部署。每次开发只更新已有草稿 PR，避免新建重复工作或无意义构建。

## 2026-11-11 开发续作（已保存）

- 新增用户主动选择 .eml / .txt 读取：在会话内存解析 UTF-8、Shift-JIS、MIME/Quoted-Printable/Base64，跳过附件/远程跟踪资源，用户确认后才写入私人文书库。
- 新增扫描页排序：PATCH /api/documents/{documentId}/attachments/order，稳定 ID、文书版本冲突保护，排序不访问 R2。
- OpenAPI 45 路径、46 操作已同步代码，并通过本地契约校验。
- 最新独立 CI：2026-11-11，提交 7091ca2ba0807b36f4bc4b103328017efe42d1ff；42 项 Node + 11 项 SQLite/API 契约测试通过，Vue 生产构建通过。
- 仍然没有真实生产 Worker / D1 / R2 部署；三 App 草稿 PR 尚未合并，OCR 实测门槛仍未通过。

## 最新代码增量与真实阻塞（2026-11-11）

- PDF.js 已按需加载本地 PDF 可复制文字层；DOCX/XLSX 同样优先本地取文字，不自动 OCR、不持久缓存、不自动保存原件。
- Office ZIP 安全边界包括：目录完整性、文件名/宏过滤、CRC、真实解压逐块上限及必需 XML 校验；Worker 在发起 R2 PUT 前拒绝不合格的 Office。
- 日文政策、活动、合同、说明书的关键限制条款增加逐条日文证据、中文释义及实际核对建议；官方版本未核实时明确为 null。
- **后续仍需**：真实脱敏日本文书 OCR 精度与费用评估；手机双人真机安全/恢复测试；Gmail/Drive 授权；目标 App 联动密钥/账号映射及部署审批。现有三个 App 的生产数据仍未被写入。

- 新增 D1 迁移 `0006_document_version.sql`，原文发布日期与官方核验时间分别保存；前者须人工核对，后者没有实际验证渠道则始终 NULL。API、界面、备份/恢复已同步；恢复外部备份不能伪造已核验状态。

- 账号安全：新增需核验旧密码的自助密码变更，PBKDF2 更新后立即撤销该用户全部旧会话；独立的另一位家庭成员会话不受影响。需经 CI 测试验收；忘记密码的邮件找回仍需经授权邮件渠道。

## 本轮增量：跨 App 并发与幂等安全

- 上次已验证基线 `701b5332`：50 项 Node、11 项 SQLite/API 契约及 Vue 构建通过。
- 已在 PR 新增 `0008_bridge_fingerprint.sql` 和原子 CAS：同一候选只会有一个发送者，首次发送前锁定包含目标账号、金额、日期的 SHA-256 请求指纹。网络响应丢失后改日期或账号将返回 `RETRY_PAYLOAD_CHANGED` 而不是默默二次记账；旧版无指纹的已尝试联动拒绝盲目重试。
- 新增真实网络响应丢失后改日期、并发双击、发送完成后再次提交测试；本次提交的最新 CI 待独立确认。
- 不改其他三个 App 生产 D1，仍未部署。

## Google Drive Picker 最小权限导入（本轮提交待 CI 验收）

- 新增前端 Google Drive Picker：仅在用户明确点击时加载官方组件并申请 `drive.file`，只读取选中文件。Google Docs→TXT、Sheets→XLSX、Slides→PPTX；其他 PDF/Office/图片/EML/TXT 下载到临时内存，继续沿用原有文字层优先与人工确认流程。
- 未配置三项构建公开凭据前入口隐藏；无服务器同步、无自动 R2 上传、不读取全盘或 Gmail。详见 `docs/google_drive_picker_setup.md`。
- 纠正“仅保存文字”时错误提示已上传 R2 的 UI 文案；新增无授权、逐文件下载、8MB 限额和缺失格式的单元测试。独立 Google OAuth 许可及 iPhone 实机验证尚未完成。

## OCR 成本与意外中断保护（新增，待最新 CI 验收）

- 新增同一个文书助手 D1 内的 `0010_ocr_utc_budget.sql`，按 UTC 日限制两名用户合计 OCR 调用，默认一天 1 次；原先个人用量按东京日期统计保持兼容。不能用本应用计数推算 Cloudflare 账号整体免费剩余额度。
- 图片 OCR 在意外中断后如果 `pending` 超过 24 小时，只能由用户主动勾选 `retry_stale` 再次尝试；不自动重试模型，不添加 Cron、KV 或额外服务。
- 同时运行新的 SQLite/Node 测试后更新验收结果。生产数据与正式 Worker/R2/D1 均未修改。

- Google Drive 原件导入时显式记录用户选择的来源类型，保存到 `document_sources.source_type=google_drive`；拒绝非白名单来源，未确认上传前不访问 R2，新增 Worker 回归测试。此为来源声明，不代表验证文件的法律时效。

## OpenAPI 严格校验（本轮补齐，待最新 CI）

- 修正日历订阅新增时遗留的错位 `change-password`、重复 `components`、孤立的响应对象。保留 50 条真实路径与 51 个 operationId。
- 新增 YAML 解析器真实读取 OpenAPI 3.1 文档，CI 会拒绝不完整语法、重复键，并检验 Google Drive 来源、OCR 手动重试及 UTC 预算的响应契约。
- 此次修改尚需以实际最新 GitHub Actions 的完整结果验收；不自动部署或迁移生产数据。

- 保护联动幂等历史：统一 `analyzeStored()` 内禁止对已经发出过远程请求的文书重新生成候选 ID；即使通过未来新增的重新分析入口，也不能抹除目标 App 的既有同步记录。新增直达 API 回归测试，最新 CI 仍需核验。

- 知学个人句卡**未标成已完成**：当前目标桥只支持 `vocabulary`，且知学尚无双人隔离的句卡存储。文书助手现在对 `sentence` 预览标记 `available=false`，提交返回 `STUDY_SENTENCE_NOT_READY`，不向不支持的目标发送私人内容。新增 Mock 网络调用数为 0 的安全测试；后续仍需知学独立的身份系统与可私有句卡数据模型。

## 历史保存点（2026-11-11；该段为早前 CI 基线，非最新）

- **代码已提交**：主项目 PR #1 分支 `feature/v011-implementation`，当前测试验证基线 `811fdbf20e876fc2721bd782146b7a905d93b379`。
- **CI 已通过**：GitHub Actions [43028728039](https://github.com/PTamako/jp-document-assistant/actions/runs/43028728039)：63/63 Node、11/11 SQLite/API 契约测试，以及 Vue 生产构建。该结果不代表真实 Cloudflare 账户兼容性或 iPhone 测试。
- **三 App 目标 PR**：HomeFlow #296、家計簿 #294、知学 #162 均为 Draft，最后检查时各自最新 CI 通过；**未合并、未部署**。
- **这轮补齐**：Google Picker 用户选择文件（OAuth 设置仍待批准）；PPTX/Office 安全恢复；ICS 私人日历订阅；OCR UTC 双人调用预算和无结果去重；Cloudflare 账号余量未知的明确提示；已发出联动的不可变 payload 指纹、并发互斥、原文再分析保护；OpenAPI 真实 YAML 校验；知学不支持的私人句卡明确失败关闭。
- **真实生产验证**：无。没有创建/修改新的正式或 Preview Worker/D1/R2，没有改动三个既有 App 的生产 D1，也没有执行账号合并或部署。
- **不可回避的阻塞**：OCR 真实获授权脱敏样本及字段准确率/模型实际费用、Google OAuth 客户端与 iPhone 真机、Gmail 受限 OAuth 审核、知学双人私密句卡账户模型、目标服务签名密钥/账号映射与真实安全联调、Cloudflare 免费方案当期账号总余额/资源配额、生产迁移与部署审批。

## 2026-11-11 安全增量（本次提交待 CI）

- 修复用户主动上传的 SHA-256 验证备份在复用 D1 ready 对象时 R2 实际缺失仍建立空引用的问题；先检查物理对象并补传，失败则安全拒绝。
- 修复整个文书已进回收站后，仍能通过独立备份原件路径读取原件的问题。
- 新增 Mock R2 丢失/补传故障及回收站原件访问拒绝两项测试。尚未经过真实 R2/D1 环境验收。
- 仅修改现有 Draft PR；生产资源、目标 App 均未改动。

## 2026-11-11 上线计划与 Google Picker CSP 续作（本次提交待 CI）

- 新增 docs/production_deployment_plan.md：记录已核实的 6 Worker / 6 D1 / 2 私有 R2、全账号账单缺 Billing Read 因而未知、生产资源审批、Secrets、迁移命令、故障隔离和回滚，以及真实验收硬门槛。
- 修复 Google Picker 官方按需脚本/文件读取被默认 CSP 拦截；仅允许已知 Google OAuth/Picker 脚本、框架与 Drive API 来源，保留 object-src none、frame-ancestors none；新增静态响应 CSP 回归测试。真 Google OAuth/iPhone 仍需审批后验收。
- 未创建任何 Cloudflare 资源、Preview、Cron 或生产写入；四份 PR 均保持 Draft。

## 2026-11-11 敏感文书共享权限保护（新增，待 CI）

- 扩展默认私密类型：工资、税务、银行卡、医疗、保险、行政身份、住房、行程及酒店；未知分类里出现个人编号、在留卡、护照、保険証和账户字段也默认 private。
- 已共享文书的原文更换为敏感文本时，在同一 D1 batch 内自动收回共享权限；已共享文书手动改为敏感类别时也自动回到私人状态。之后仍可通过明确二次确认的独立共享操作授权。
- 新增两项回归覆盖保险/医疗/身份资料导入、工资原文替换和分类变更。这只属于新分支开发与 Mock 验证，尚无真实设备审查。

## 2026-11-11 本账号设备会话管理（新增，待 CI）

- 新增 GET /api/auth/sessions、POST /api/auth/sessions/revoke、POST /api/auth/sessions/revoke-others，所有授权来自服务端当前会话，二次写入必须通过 CSRF。单页五条，不返回哈希或 Cookie；不得查询/撤销其他家庭成员。
- 设置页新增移动端会话管理 Bottom Sheet；当前设备使用原有退出操作，其他登录可单独或一键撤销。不采集设备指纹和精确位置。
- 增加实际 Worker/SQLite Mock 回归：跨账号撤销拒绝、失效 Cookie、CSRF 与密码会话并行。OpenAPI 同步新增路由，未经部署不代表真机验收。

## 2026-11-11 实验 OCR 空结果受控重试（新增，待 CI）

- 当前 Moondream 官方 Schema 验证 input 为 task=query/image=base64 data URI/question，输出为 answer+metrics。代码格式符合 Schema，但真实日本文书空结果根因尚未验证，不编造准确率。
- 同源原图空结果先缓存避免重复费用，至少24小时后才允许本人在前端明确勾选一次重试，并再次消费受个人及全应用 UTC 预算保护的额度；失败可后续人工录入。
- 新增 UI 选择、OpenAPI 属性和端到端 Mock 回归。真实推理未执行，生产开关仍关闭。

## 2026-11-11 普通文件复用 R2 缺失实体的恢复（新增，待 CI）

- 正常导入命中相同文书 SHA 或复用孤立 ready storage_objects 时，必须核对精确 R2 对象；对用户本次上传且校验 SHA 的原件补传，再返回复用/建立引用。
- 对象缺失且补传失败返回 503，避免表面成功、实际原件无法读取。若用户曾删除附件引用，明确提示重新关联而非重复造文书。
- 两项 Worker/Mock R2 回归验证失败不新增 D1 引用，成功重试恢复物理文件。普通列表/搜索仍不会 HEAD/LIST R2。

## 2026-11-11 最新开发验收检查点（CI 已完成）

- 最新主分支提交：`ed79213870c8402be6f2eb1e14cdf19a0c17d53b`，现有 Draft PR #1，未合并；对应 GitHub Actions [43036305622](https://github.com/PTamako/jp-document-assistant/actions/runs/43036305622) **通过：72/72 Node、11/11 SQLite/API、Vue 生产构建**。
- 从 `2709db97` 继承继续开发并保留原分支：修复 R2 恢复/重复上传时 D1 已有 ready 元数据但物理文件丢失；回收站整份文书原件不可从备份下载旁路读取；Google Picker 官方按需脚本 CSP；敏感分类/新原文自动转私密；同账号其他会话查看与撤销；OCR 空结果冷却/人工重试与预算。相关新增测试均在本次 CI 中通过。
- OpenAPI 严格解析验收：53 路径、54 操作；新增个人会话三个接口与 OCR retry_empty 契约均被精确校验，不是降低测试门槛。
- 真实外部检查仅覆盖 Cloudflare 只读资源清单（6 Worker、6 D1、2 私有 R2）与两个 Bucket 的公共访问状态；账单调用 403，所有账号实际用量及是否收费为**未知**。文书助手专用 D1 和 Worker 均尚不存在。
- 目标三 App PR #294/#296/#162 未合并；知学端当前单用户且只有生词桥，双人私人句卡不满足上线要求。Google OAuth、Gmail 真实授权、OCR 真实脱敏样本、目标 App 真联调、双 iPhone 验收与 Cloudflare 新资源审批仍是阻塞。
- 正式部署状态：**未创建资源、未迁移、未部署、未合并四个 PR、未写入三个 App 生产数据**。集中审批的操作步骤记录于 `docs/production_deployment_plan.md`。

## 2026-11-11 Gmail 逐封只读导入（新增，待最新 CI）

- 新增 Gmail 仅用户主动授权、每页最多五封元数据、选定一封才读取 full MIME 文字、附件与远程跟踪图片不加载的流程。复用现有安全 EML 提取、私人文字导入和同内容 SHA 去重；前端手机 Bottom Sheet。
- Gmail OAuth Access Token 仅 JS 模块内存，登出/切用户/更改密码清除，主动撤销检查 Google 返回状态。限定官方 Gmail API CSP，不增加 Preview/Worker/Secrets。详见 docs/gmail_oauth_setup.md。
- 这不等于 Gmail historyId 自动增量同步；Google 限制 OAuth Scope 的审批、浏览器授权真机测试和 Gmail 实时账号读取仍未完成。所有现有云和生产数据保持不动。

## 2026-11-11 ZIP 原件与 AES-GCM 篡改防护回归（新增，待 CI）

- 新增 AES-GCM + PBKDF2 用户 ZIP 备份真实本地往返、错误密码、密文单字节篡改、无效加密文件头测试。
- 新增原件缺失、SHA-256 原件内容被篡改、跨不受支持版本（明确拒绝而不伪装成功）的 ZIP 完整性测试；验证受损备份在写入 D1/R2 前失败。尚不代表所有历史 schema_version 能跨版本恢复，旧版适配仍待明确真实格式。

## 2026-11-11 Gmail 账户范围收紧（本次提交待 CI）

- 检查 Google 官方 token model 文档后明确 include_granted_scopes=false、hasGrantedAllScopes 验证范围；取消弹窗时提示，且 Gmail Token 在文书助手换账号/新登录及组件卸载时清除。Google revoke 撤销的是应用授权集合，已在配置文档披露。

## 2026-11-11 最终本轮代码验证记录

- 最新经完整 CI 验证的代码 SHA：`84249bc7989512d735b31b2bbc068072a4971cb9`；[GitHub Actions #43039499158](https://github.com/PTamako/jp-document-assistant/actions/runs/43039499158) **成功：80/80 Node、11/11 SQLite/API、Vue 生产构建**。
- Gmail 按需只读 OAuth 代码、五件分页、选定单封 MIME、用户主动保存、内存 Token 清除、Google Scope 最小授权检查、新登录/换人隔离和显式撤销已通过 Mock/静态合同测试；未配置正式 Google OAuth，尚未进行真实 Gmail 或 iPhone 实测；自动 historyId 同步仍未实现。
- 加密 ZIP 增加错误密码、篡改、缺失原件及版本不支持安全拒绝测试。不是声称完成了任意历史版本迁移。
- **真实部署验收未完成，绝不可因 CI 绿灯变更四个 PR 为 Ready / 自动合并/部署。**

## 部署前安全审查：扫描页/备份补传的最后引用检查（2026-11-11）

- 修复追加扫描页 `POST /api/documents/{id}/attachments` 的两条去重路径：原文书附件重复上传及不同文书共享 owner-scoped R2 对象，均需在用户主动上传后确认原件物理存在；缺失则先精确补传成功，再宣称复用或建立引用。R2 故障返回 503，不产生空附件引用。
- 限制 `restore-upload` 每份文书最多 30 个附件；在触发新 R2 PUT 前检查数量（已有同 SHA 附件的幂等恢复仍允许）。不改变列表/搜索的零 R2 HEAD/LIST 行为。
- 本次以 Mock R2 与 SQLite 注入故障回归，不能代替真实 Cloudflare 权限/成本验收；未执行生产写入。

## 部署前安全审查：双人账号切换的私人内存隔离（2026-11-11）

- 新增会话 epoch（纯内存）：所有文书助手 API 回包必须匹配发起时账号世代，退出、换用户、密码变更或组件卸载立即使旧响应无效；不允许旧请求回流旧账号数据。备份恢复使用固定 epoch 的 API，防止多步恢复途中切人后写到新账户。
- 统一清空使用量、回收站列表、附件回收站、会话列表、日历订阅链接、备份 ZIP 与密码、恢复预览、候选草稿、附件内存及旧列表；异步原图 Blob 获取前后检查 epoch。与已有 Gmail Token 清理合并。
- 新增 epoch 纯单元测试和 Vue 私密状态静态约束。仍需要两人 iPhone 真机测试同一浏览器中退出/登录和网络延迟边界。

## 部署前安全补充：旧账号请求中止与备份防串号（2026-11-11）

- 在统一账号会话清空时立即 Abort 上一账号默认 API 与私有原件 GET；旧响应已由 epoch 丢弃。新账号使用全新 AbortController，禁止旧账号网络请求完成后向页面写入。
- 私人 ZIP 导出使用账号快照绑定 API、R2 下载 AbortSignal，且在实际向设备发起文件下载前再次校验账号世代；恢复批次沿用原有固定 epoch 防跨用户中途写入。
- Google Drive TXT/EML/Office 下载后的异步解析新增会话检查，不让旧账号的选择结果重新出现在新账号编辑表单。

## 部署前静态准入门禁（2026-11-11）

- 新增 CI 回归 tests/release-preflight.test.js：在未审批阶段强制唯一 Worker/Static Assets、唯一 D1/R2 Binding、占位符不误当真实 ID、workers_dev 与 preview_urls 关闭、不存在 Cron/KV/Queues/DO/其他资源。
- 校验 GitHub Actions 仅运行只读 CI，没有生产 Secrets、远端 D1 迁移、部署或自动 Preview；检查 Cookie Strict+HttpOnly、CSRF、私有 API no-store、无 R2 LIST 等静态边界。审批后如决定开通正式 workers.dev 域名，需同步改变审批模板和受控测试。

## 部署前集中安全审查完成（2026-11-11；待本次文档 CI）

- 代码基线 `0d7bbf01a94451618b6dd11b96b2fd46e168fa91` GitHub Actions [43045926313](https://github.com/PTamako/jp-document-assistant/actions/runs/43045926313) 成功：**88/88 Node、11/11 SQLite/API、Vue build**。后续此文档提交的 CI 另验。
- 完整审批报告见 `docs/predeployment_security_audit.md`：区分静态代码/Mock 通过、Cloudflare 只读核验、真实云端和双 iPhone 未验。
- 只读新发现：Cloudflare Zones 与 Workers Custom Domains 均为空，现有 `wrangler.jsonc` 禁用 workers.dev，故没有现成可访问正式域名。受限首次验收部署需用户明确批准 Worker 使用唯一 workers.dev 正式域名，并保持 preview_urls:false。
- 为强隔离，建议在审批后**新建一个独立私有 R2 Bucket**，不与既有 HomeFlow/家計簿 Worker 共桶；R2 Bucket 数量目前在官方包含量内，但全账号容量、Class A/B、费用依然未知（Billing Read 403）。
- **完整 v0.11 正式上线仍 NO-GO**（OCR 真样本、真实服务联调、知学双人私密句卡、成员退出、Google OAuth/真机等未完成）。可申请的是关掉这些功能的 core-only 云端验收，而不是宣称正式产品全功能上线。

## 2026-11-11 部署计划冲突消除（本次纯文档提交待 CI）

- 明确区分 core-only 首次正式云资源验收和完整 v0.11 发布。首轮仅核心 Worker、专用空 D1、一个独立私有 R2；绝不合并三个目标 App PR 或配置桥接服务。Google/Gmail/Workers AI 默认关闭。
- 当前 Cloudflare 无 Zone 时 workers_dev=false 不会产生可访问地址；启用正式 Worker 的 workers.dev 需要与创建资源、D1 迁移和合成数据写入一起明确审批，且保持 preview_urls=false。完整功能与 iPhone 真机未通过仍不得称为正式上线。
