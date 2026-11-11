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
