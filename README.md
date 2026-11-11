# 日本生活文书助手 / JP Document Assistant

面向在日生活的双人家庭的私人文书管理 PWA。以 Google Docs v0.11 设计书及项目初始迁移、OpenAPI 契约为开发基线。

## 开发原则

- Vue 3 + Cloudflare Workers Static Assets + D1 + 私有 R2
- 默认私人，跨应用写入须用户明确确认
- 尽量不在手机持久存储敏感资料
- 仅本地与 CI 测试，不建立预览 Worker / D1 / R2，不自动部署生产
- 不提交密钥、令牌或真实个人资料

> 本仓库初始化完成；功能以实际提交和自动化测试结果为准。
