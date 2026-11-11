# Google Drive Picker — 安全配置和隐私验收

本集成只读取用户在官方 Picker 中**主动选择的一个文件**，使用 `https://www.googleapis.com/auth/drive.file`。不访问整个 Drive、不保存 Refresh Token、不在本地或 D1/R2 存储 OAuth Token、不后台同步、不要求 Gmail Scope。

## 正式配置（需用户在自己的 Google Cloud Project 操作）

1. 在 Google Cloud Console 为对应项目启用 **Google Picker API** 和 **Google Drive API**，配置 OAuth 同意屏幕及测试用户/发布状态。根据 Google 审核要求处理应用信息和隐私政策。
2. 建立 Web OAuth 2.0 Client ID：在授权 JavaScript Origins 填写真正发布的 HTTPS 来源；测试来源需要显式单独登记。请勿把 Client Secret 放入浏览器。
3. 建立浏览器 API Key，并限制允许的 HTTPS Referrer 和仅 Picker 所需的 Google API；不要使用无限制密钥。
4. 在**构建环境**配置非秘密公开值：`VITE_GOOGLE_CLIENT_ID`（OAuth Web 客户端 ID）、`VITE_GOOGLE_API_KEY`（已按来源限制的浏览器 API Key）、`VITE_GOOGLE_APP_ID`（Google Cloud **项目数字编号**）。未提供完整配置时入口隐藏，本地上传继续可用。
5. 人工实测：iPhone Safari/PWA 的 OAuth 弹窗与取消、Google Docs → TXT、Google Sheets → XLSX、Google Slides → PPTX、上传 PDF/图片、8MB 限制、登出后的 token 清除、不同 Google 账号的选择。未通过前不宣称已接入生产账户。

Google Workspace 的 export 有自身最大 10 MB 限制，本应用进一步限制到 8 MB。Drive 下载后，文本、原件只在本次页面会话中用于预览；用户主动提交后才保存到文书助手。关闭 Picker 不触发上传、R2 GET/PUT、D1 写入或 Workers AI。下载失败不进行无穷重试。

参考官方资料：
- https://developers.google.com/workspace/drive/picker/guides/web-picker
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export
- https://developers.google.com/workspace/drive/api/guides/ref-export-formats
