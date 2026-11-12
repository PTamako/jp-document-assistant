# Gmail 只读逐封导入 — Google OAuth 配置与限制

状态：开发分支的选择读取功能，真实 Google OAuth 授权、审核及 iPhone 真机验证尚未完成。没有连接用户实际邮箱或部署生产服务。

## 已实现的边界

- 仅在文书助手已登录用户点击「从 Gmail 选择邮件」后加载 Google Identity Services；用户再次点击授权时申请 Google Gmail 只读 Scope：https://www.googleapis.com/auth/gmail.readonly 。此 Scope 为受限权限，须遵守 Google 的 OAuth 应用验证和数据使用规定。
- 只在本次浏览器页面会话的 JS 模块内存保留短期 Access Token；不存 Browser Storage、D1、R2、Cookie、日志或 GitHub；不索取 Refresh Token，不后台自动刷新。
- 用户搜索后每次最多查询 5 个邮件 ID、读取五份标题/发件人元数据。只有选择其中一封后才通过 Gmail messages.get(format=full) 获取 MIME 正文；跳过附件 ID，不请求 messages.attachments.get，不渲染 HTML 或追踪图片。
- 对邮件的 MIME 文字部分复用现有安全 EML 解析，大小上限 1MB，优先纯文本，将仅 HTML 内容转换为不活动纯文字；用户必须再次点击保存才会以 private 文书导入，服务器沿用相同内容 SHA 去重。
- 用户主动点击「撤销 Gmail 授权」时调用 Google Identity Services revoke，并检查返回状态；即使撤销失败，本地 Token 仍清空，提示用户在 Google Account 授权页面复查。切换账号、退出或变更密码也清空 Token 与邮箱元数据列表。
- 分页由用户主动点击，绝不通过 Cron、后台队列、全邮箱游标或服务端持久 Token 同步。这是明确的 **逐封选择 + 按页读取**，不是 Gmail historyId 自动增量同步。

## 生产前必须单独完成

1. 在指定 Google Cloud 项目启用 Gmail API，维护两个被允许的测试 Gmail 账号、OAuth 同意屏幕、受限 Scope、安全与隐私政策。根据公开发布要求完成 Google App Verification 和必要的安全评估；不得规避审核。
2. 通过公开构建变量 VITE_GOOGLE_CLIENT_ID 配置经过验证的 Web OAuth Client ID 和唯一正式 HTTPS JavaScript Origin。Client Secret 禁止进入前端和 GitHub。
3. 在 iPhone Safari 和 PWA 双用户验证授权弹窗、切换 Google 账号、OAuth 失效、撤销、读取邮件五件分页、附件不加载、取消/失败不写入、私人文书不可越权访问。
4. 如另行要求 Gmail 自动增量同步，需单独设计经过授权的 historyId 推进、网络失败重试、邮件内容生命周期、Token 加密托管与账户成员退出清理；目前没有实现，不能标记完成。

参考：https://developers.google.com/workspace/gmail/api/guides/list-messages
https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
https://developers.google.com/identity/oauth2/web/reference/js-reference
https://developers.google.com/workspace/gmail/api/auth/scopes

## Google 权限细分与家庭成员切换（2026-11-11）

- 单独设置 include_granted_scopes=false，并通过官方 hasGrantedAllScopes 验证本次授权确实包含 Gmail readonly，防止以之前 Google Drive 权限冒充 Gmail 授权或意外扩大本次 Access Token 范围。
- 文书助手新登录、返回不同 App 用户、退出、改密和 Vue 组件卸载都清空 Gmail Access Token 与内存列表。Google 授权窗口取消/失败必须返回可操作错误，不能假装已连接。
- 注意 Google Identity Services 的 revoke 可能撤销**同一 OAuth 应用已同意的全部 Scope**，不仅 Gmail。用户需要知道可能同时影响 Google Drive Picker 的既有授权。

## PWA 长期 Gmail 连接（授权码模式，需配置后启用）

- Gmail 页面点击「连接 Gmail（长期授权）」时，Google Identity Services initCodeClient 在用户点击事件中打开官方授权窗口，并通过带 CSRF 校验的 POST /api/google/gmail/connect 将一次性授权码交给现有 Cloudflare Worker。
- Worker 用 Web OAuth Client Secret 兑换并校验 Gmail readonly 权限。刷新令牌使用 AES-256-GCM、每用户唯一 AAD 加密，放在现有 D1 的 google_oauth_grants 中；不发送给 PWA，不保存到 R2、手机本地或日志。短期 Access Token 不持久化。
- 以后打开 PWA 时，GET /api/google/gmail/status 读取绑定状态，按需刷新 Google Access Token。每次最多展示 5 封邮件元数据，只有主动点击某封才读取其 MIME 正文，不定时同步。
- 用户断开时立即删除加密令牌，并尝试向 Google 撤销授权。不同文书助手账号不能共享授权。
- 正式环境未设置完整 OAuth 配置时，仍使用原来的临时 Gmail 授权，不会导致登录或其他功能失效。
- Google 的首次官方登录窗口不能被 PWA 绕过。iOS standalone PWA 如果因为 Cookie 或 disallowed_useragent 拒绝官方窗口，不能通过仿造 Google 登录页面、直接保存密码等方式规避。

### 必需的 Google Cloud / Cloudflare 配置（目前未就绪）

1. Google Cloud 启用 Gmail API，Web OAuth Client ID 与前端的 VITE_GOOGLE_CLIENT_ID 必须相同，授权 JS Origin 包含正式 HTTPS 域名；遵守 Gmail readonly 受限 Scope 的发布/验证/数据使用要求。
2. Cloudflare 正式 Worker 设置 GOOGLE_OAUTH_CLIENT_ID（可公开 Variable）、GOOGLE_OAUTH_CLIENT_SECRET（Secret）、GOOGLE_TOKEN_ENCRYPTION_KEY（64 位十六进制、来自密码学随机生成的 256 bit Key，Secret）。Client Secret 不能进入前端、GitHub 或聊天。
3. 备份文书助手现有生产 D1，经确认后运行 migrations/0013_google_oauth_grants.sql。它只新增一张表，不得在 HomeFlow、家計簿或知学数据库中执行。
4. 在 iPhone PWA 验证：首次授权、退出 PWA 后保持绑定、Access Token 自动续期、双用户隔离、撤销、Cookie 受限时的明确提示。
5. Google OAuth 同意屏幕若为 External + Testing 且申请 Gmail Scope，刷新令牌通常 7 天过期。只有完成合适的 Google Cloud 发布与审核后，才可以期待长效授权；即使已发布，用户撤销或 Google 判定风险时仍需重新登录。

参考：
https://developers.google.com/identity/oauth2/web/guides/use-code-model
https://developers.google.com/identity/protocols/oauth2
https://developers.google.com/workspace/gmail/api/auth/scopes
