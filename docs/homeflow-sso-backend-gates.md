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

## 2026-11-13 增量：iOS PWA ↔ Safari 一次性授权回传（仍为 Draft）

- 已实现 `GET /api/homeflow-sso/status`（只有服务器全部配置就绪才会显示登录按钮）、原 App `POST /start`、Safari `GET /callback` 暂存 **AES-GCM 加密授权码**、原 App `POST /complete` 使用不会出现在 OAuth URL 中的 `resume_secret`（仅服务器 SHA-256 存储）完成后端 code+PKCE/userinfo、双重 owner 证明与独立 HttpOnly 登录会话。Safari callback **绝不颁发应用 session**，避免不同 iOS 容器的 Cookie 混用。
- 原 PWA 仅在当前 `sessionStorage` 暂存 5 分钟验证凭证；返回原 PWA 后由用户按“完成 HomeFlow 登录”提交，成功后清理旧私有工作区缓存再读自己的数据。当前 PWA 跳转/恢复的 iOS 实机行为**未实测**，因此仍不是验收成功。
- 回调只能暂存一次密文；二次消费和错误状态不允许直接落本地登录。管理员初次绑定必须当前 PWA 的旧 owner 会话仍有效；成员没有 owner 历史账号继承权。没有数据库/R2 正式改写、未执行 `0020/0021`，也没有开启生产功能标志。
- **生产安全结论保持不变**：四份可恢复加密备份与恢复演练、跨应用停用/退出撤销、iPhone 双人实测、HomeFlow OAuth 部署及 callback allowlist 均未完成；不能合并或上线。`0021` 仍是尚未执行的新增迁移，其字段已增加 PWA `resume_secret_hash`/加密回调列；旧线上 schema 未受影响。

## 当前尚不能放行的功能和安全问题

1. **iOS 独立 PWA 与 Safari Cookie 隔离**：一次性原 PWA 回传协议与 UI 已编码、单测覆盖基本凭证窃取/跨容器/错误 Origin/重放，**尚未做真实 iPhone 独立 PWA 与 Safari 双账号测试**，仍不允许启用或称已可用。后续还需检查浏览器切换、后台冻结、设备更换时 `sessionStorage` 的保留与过期行为，不能把 Safari 中的 Cookie 当 PWA 会话。
2. **撤销/停用传播**：HomeFlow 已可在 3 分钟的短期 userinfo 上拒绝停用账号，但文书助手一旦创建 15 分钟自有 Session，仍需服务端撤销通知/按需身份复核机制、账号冻结与昵称变更传播设计；现在不能称跨四应用立即注销。
3. `web/src/App.vue` 已加入**受服务器能力控制、默认不显示**的“使用 HomeFlow 登录”和“完成 HomeFlow 登录”按钮；owner 在账户与安全页可启动旧身份绑定。需要正式部署前完成 UI/服务端完整联调与独立会话复核；旧登录/邀请入口只在 F 阶段验收后清退。
4. HomeFlow Draft #305 的 OAuth 只是一阶段接口，不是完整 OIDC IdP：无 ID Token / JWKS。该应用只通过单次 PKCE+后端 `userinfo` 作为受信身份，且严格使用 Service Binding 和固定 client 配置；不得把此称为标准兼容的 OIDC。
5. 正式 0020/0021 均**未执行**，四生产 D1/R2 的完整加密备份尚未能上传 Drive、未完成恢复测试；GitHub CI success 不等于已经上线。

## 测试与交接

`tests/homeflow-sso.test.js` 使用内存 SQLite 实测“默认关闭、非法 Origin、浏览器绑定、状态单次消费、管理员双重绑定、旧文书/Gmail 原样保留、member 个人空间无数据、先 owner 后 member、防 audience/role/household 置换、原会话撤销阻断”。`tests/test_homeflow_identity_links.py` 验证迁移幂等及映射不可变。每次代码/测试/部署状态变化均应同步更新唯一主日志 `PTamako/homeflow/docs/four-app-development-handoff.md`；不得创建第二份进度日志。


## 2026-11-13 阶段 B 跨应用注销/停用联动增量（仅 Draft，未上线）

HomeFlow Draft #305 新增 15 分钟的**仅服务端** `session_assertion`：与 HomeFlow 原 `sessions(token_hash)` 的外键绑定；`POST /api/oauth/session-introspect` 仅允许后端以固定 client_id、一次性授权时取得的断言校验。HomeFlow 原会话登出、账户 disabled、家庭成员关系失效后，下次校验直接返回 401；不采用每分钟/每五分钟轮询，普通读取不写 D1 审计。HomeFlow [CI #43402025579](https://github.com/PTamako/homeflow/actions/runs/43402025579) 已 success，迁移 0053 **尚未执行**。

文书助手的未执行新 `migrations/0022_homeflow_session_proofs.sql` 在既有 `sessions` 添加 `auth_source`，旧行默认 `legacy`；新 HomeFlow Session 必须存 `homeflow`，与在服务器 AES-GCM 加密的断言 1:1 关联。所有私人 GET 和写请求经 `worker/index.js::requireSession` 检查一次 HomeFlow 当前用户/role/household/昵称和已连接本地 ID，不满足立刻 401；失去 proof 严禁降级为旧身份认证。新 OAuth 交换返回的 assertion 仅保存在服务端加密表，**不放入浏览器 Cookie/URL/localStorage**。iPhone 端保留 15 分钟 cookie 的上限，实际上线前仍需确认 iOS 跨 PWA 真机行为。

已新增自动测试：双重绑定、无 Cookie Safari 回传、HomeFlow 源会话撤销、role/household 冒用、防重放、无 proof 不能回退 legacy、旧 owner 私人文书及 Google OAuth 不变。文书助手 [Pre-merge CI #43402597451](https://github.com/PTamako/jp-document-assistant/actions/runs/43402597451) success（Node/Python/D1 测试、Vue build）；该结果仍**不代表生产或设备验收**。

**生产保护**：新 0022/原 0020/0021 迁移、HomeFlow 0053/0054、功能开关均未运行/启用。备份由用户在电脑上自行完成；在其确认加密持久备份及隔离恢复结果前不合并/上线。跨 App 真机登录、session 切换和角色失效需阶段 F 人工核验。
