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


## 2026-11-13 家庭共享文书操作权限与操作人审计增量（Draft，未上线）

按照设计书 v1.1 的「私人文书仅自己，共享文书两人可读/改、管理员不默认查看私人原件」实现：
- `worker/index.js` 新内部 `manageableDocument`：验证文书本人 owner，或同一 household 且真实 `visibility='shared'`。共享文书的标题/分类（普通）、收藏/归档/标签更新和 `document_fields` 人工核验现在允许双方，所有写 SQL 再次条件检查权限与版本；真实 `actor_user_id` 的审计与文书更新放同一 D1 batch。**共享范围仍仅原所有者可改**，非 owner 不能把共享文书转为敏感分类后偷偷继续公开；编辑失败不允许写假审计。 
- 共享文书的移入回收站/恢复由双方操作，内部字段均按真实 actor 记录。原件永久删除仍是原 owner 专属，防止 R2 `storage_objects.owner_id` 与成员账号混用；无 R2 自动扫描。
- `worker/lifecycle.js` 的共享附件现在允许双方移入回收站、恢复、查看附件回收列表，`worker/index.js` 允许成员对已有附件重新排序，全部采用再验权限、条件写入、真实 actor 审计；非 owner **不能永久删除**附件或做直接跨账号 R2 清理，撤销共享立即失去访问权限。
- `tests/worker.test.js` 双人真实内存 SQLite/假 R2 验证：先私有不可访问→原 owner 显式共享→member 修改/回收/恢复/排序→版本冲突与审计→撤销后立即不可访问、R2 原件不变。
- [Pre-merge CI #43406353483](https://github.com/PTamako/jp-document-assistant/actions/runs/43406353483) 已成功（共享文书基本操作）；其后新增共享附件协作的完整 [Pre-merge CI #43408316526](https://github.com/PTamako/jp-document-assistant/actions/runs/43408316526) **成功**（内存 D1+Vue build 等）。**所有代码仍在 Draft #97，生产没有迁移、合并或部署**。

**保留未完成**：共享原件永久删除需要安全地以真实 owner 操作私有 R2 清理、记录实际成员 actor 并在发起时验证共享关系；新附件上传要处理异账号 R2 owner、权限和重复使用；共享关联候选动作可能仍需按所有权分支授权；文书助手将私人文书同步到 HomeFlow/知学/家計簿时必须贯彻各平台独立用户 ID 与 HomeFlow 审批 gate。不得把当前基础协作实现宣称为全站全部操作均已支持。


## 2026-11-13 Stage E 增量：家庭共享附件永久删除

- **仅在原 Draft #97 中开发，未合并/未生产部署；A=待用户完成、0020～0022 禁止上线。** 修改 `worker/lifecycle.js` 与 `tests/worker.test.js`。
- 已共享且仍处于同一 `household_id` 的附件，原所有者与家庭成员均可在先移入回收站、再次明确输入 `DELETE_FOREVER` 后永久删除；私人/已撤销共享无权操作仍为 `404`。只针对**请求中精确 attachment_id** 授权；不是让 member 管理他人的所有私有 R2。
- D1 编辑前、R2 对象回收前与最终附件删除时校验仍属于可管理的同一共享文书；R2 物理对象及删除墓碑仍绑定原 `owner_id`，绝不将原主人伪装为实际执行人。新增 `audit_events(kind='attachment_permanently_deleted', actor_user_id=实际用户 ID)`，不记私人原文/附件字节。
- 如果多个附件引用同一 `storage_objects.id`，先删除引用记录；原件仅在确认无引用时删除，最后引用消失时才精准执行单个对象 `cleanupOrphans`。异常 R2 删除仍按现有 `deletion_jobs` / `delete_failed` 机制报错并可重试；不做全桶扫描和跨账号认证绕过。
- 自动回归覆盖共享前不可见、共享后双人权限、未先回收时不允许物理删除、共享成员删除两份同一 R2 的不同附件、唯一原件最后才删除、墓碑原始 owner、审计真实 actor、撤销共享立即 404、重复请求不再写成功日志。
- 提交：[`06f9fb11`](https://github.com/PTamako/jp-document-assistant/commit/06f9fb11e0ab443de895767a384fe4985385d9ae)、[`6df3a333`](https://github.com/PTamako/jp-document-assistant/commit/6df3a333bc1d0fb4263bf99b1e36a39f5b1ace4a)；[Pre-merge CI #43438562835](https://github.com/PTamako/jp-document-assistant/actions/runs/43438562835) **success**。
- 仍未完成：共享文书整份永久删除的跨所有者 R2 权限/恢复补偿，邮件与 Drive 源 OAuth 严格只归本人，跨 App 同步审批与单人旧会话清退，两个 iPhone 的授权/删除及断网真机验收。尤其不能因本模块而把未经迁移的生产身份功能打开。
