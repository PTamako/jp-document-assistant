# HomeFlow 单点登录后端（阶段 B/E Draft，未上线）

> 状态（2026-11-13）：仅 `feature/homeflow-identity-link-safety-20261113` / Draft PR #97。**严禁在 A 阶段四 D1/R2 可恢复备份完成前执行迁移、设置启用标志或把当前方案称为可用的 iPhone PWA SSO。**

## 现已编写的内容

- `migrations/0020_homeflow_identity_links.sql`：不可变一对一映射，原 `users.id` / `documents.owner_id` / `google_oauth_grants.user_id` 均不重写、不自动指派历史数据。
- `migrations/0021_homeflow_sso_pending.sql`：单次、5 分钟有效的后台 PKCE 请求。只存加密 verifier、nonce、原文书助手会话指针与状态。不会保存 HomeFlow 原始密码或 access token。
- `worker/homeflow-sso.js`：`POST /api/homeflow-sso/start` → HomeFlow `/authorize` → `GET /api/homeflow-sso/callback`。用 Cloudflare 已有 `HOMEFLOW_BRIDGE_SERVICE` **服务绑定**向 HomeFlow `/api/oauth/token` 做后端授权码兑换、`/api/oauth/userinfo` 校验真实 `sub/audience/household/role`。精确固定 redirect URI；本地应用创建单独 Secure+HttpOnly 会话，最长 15 分钟（暂行，未完成跨应用撤销）。
- 账号绑定安全要求：HomeFlow **owner 首次绑定**必须由仍有效的文书助手原 owner 会话发起，不能根据昵称、邮箱或角色猜测旧 owner UUID；HomeFlow **member 首次创建**仅在 owner 已验证绑定相同 HomeFlow 家庭后生成空白本地 member，原两份私人文书/Google OAuth grant 保持在原 owner 名下。更换账号要按不可变映射判断，绝不可自动转移。
- 只有该特性完全启用才打开上述路由；`HOMEFLOW_SSO_ENABLED` 不存在时 fail-closed 503。所有个人备份/附件仍用原用户权限检查。

## 后端部署前必须配置（**当前不要配置或启用**）

以下值应通过 Cloudflare Worker 的**服务器端 Secrets/受保护变量**提供，不进入 GitHub、Google Docs 或聊天：

- `HOMEFLOW_SSO_ENABLED`：仅在全部安全验收后才设置字符串 `true`，缺省关闭。
- `HOMEFLOW_SSO_ENCRYPTION_KEY`：独立 32 字节（64 hex）高强度随机 AES-256-GCM 密钥，与已有 Google Token Key、SESSION_HMAC_KEY 不共用；**必须安全备份单独保管，密钥丢失会导致进行中的 SSO 无法继续**。
- `HOMEFLOW_OAUTH_ORIGIN`：官方 HomeFlow **生产 HTTPS origin**，无路径、查询或碎片；不是 preview 域名。
- `DA_PUBLIC_ORIGIN`：文书助手正式 HTTPS origin，与浏览器请求 origin 完全相同；允许的回调仅 `DA_PUBLIC_ORIGIN + /api/homeflow-sso/callback`。
- HomeFlow 的 `OAUTH_CLIENT_REDIRECTS` 后端 JSON allowlist 必须包含 client `jp-document-assistant` 对应的 **完全精确** callback URI；HomeFlow `OAUTH_ENABLED` 也必须经过独立备份/迁移门槛后才能开启。
- 保留已存在的文书助手 `SESSION_HMAC_KEY` 和 `HOMEFLOW_BRIDGE_SERVICE` Service Binding；绝不可用浏览器提交 HomeFlow 密码、直接跨 D1 SQL 连接或用 admin 共享 Token 冒充用户。

## 当前尚不能放行的功能和安全问题

1. **iOS 独立 PWA 与 Safari Cookie 隔离**：目前回调要求与启动时相同的 `__Host-da_homeflow_state` Cookie 才能建立本地会话，这对同一浏览器有效、能防登录 CSRF，但不同 iOS PWA/Safari 存储域不一定共享，**实际首次 PWA 登录仍可能失败**。下一阶段需要不依赖跨浏览器 Cookie 的二次、用户确认的一次性 PWA 回传凭证，配套重放/替换设备/混账号测试；在此之前不可启用或向最终用户显示成功提示。
2. **撤销/停用传播**：HomeFlow 已可在 3 分钟的短期 userinfo 上拒绝停用账号，但文书助手一旦创建 15 分钟自有 Session，仍需服务端撤销通知/按需身份复核机制、账号冻结与昵称变更传播设计；现在不能称跨四应用立即注销。
3. 目前 `web/src/App.vue` 未加入“使用 HomeFlow 登录”正式 UI。必须先解决上述 PWA Cookie/续接问题与独立会话复核，再启用入口；旧登录/邀请入口仅按 F 阶段验证后清退。
4. HomeFlow Draft #305 的 OAuth 只是一阶段接口，不是完整 OIDC IdP：无 ID Token / JWKS。该应用只通过单次 PKCE+后端 `userinfo` 作为受信身份，且严格使用 Service Binding 和固定 client 配置；不得把此称为标准兼容的 OIDC。
5. 正式 0020/0021 均**未执行**，四生产 D1/R2 的完整加密备份尚未能上传 Drive、未完成恢复测试；GitHub CI success 不等于已经上线。

## 测试与交接

`tests/homeflow-sso.test.js` 使用内存 SQLite 实测“默认关闭、非法 Origin、浏览器绑定、状态单次消费、管理员双重绑定、旧文书/Gmail 原样保留、member 个人空间无数据、先 owner 后 member、防 audience/role/household 置换、原会话撤销阻断”。`tests/test_homeflow_identity_links.py` 验证迁移幂等及映射不可变。每次代码/测试/部署状态变化均应同步更新唯一主日志 `PTamako/homeflow/docs/four-app-development-handoff.md`；不得创建第二份进度日志。
