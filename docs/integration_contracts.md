# 三 App 服务端联动契约 — v1.0-rc1

**代码检查范围（2026-11-11）**：GitHub `PTamako/kakebo_jp` 主分支 `functions/api/[[path]].js`、`PTamako/homeflow` 主分支 `worker/tasks.js`、`PTamako/it-study-platform` 主分支 `worker/index.ts`。它们的现有前端业务路由已经具备部分能力，但 **没有证明跨应用的专用 Service Binding / 服务端账户绑定接口已经部署**。本文件给的是拟新增的安全桥接契约，**不得直接拿原有浏览器 Cookie 或 DB 作为跨应用授权**。

## 通用调用规则

* 仅文书助手的正式 Worker 在收到用户明确确认时调用对应目标 App 的正式 Worker；无额外中转 Worker，也不直接写目标 D1。
* 每个目标接口必须验证调用方（受保护 Service Binding 或专用签名/短期令牌）、目标账户身份映射和 `idempotency_key`。每个端点返回 `status: created|replayed|linked_existing|rejected|unknown`、`remote_id` 和稳定错误码。网络超时后先查相同幂等键执行结果，不能当作未执行后盲目重发。
* 仅传已确认的最小结构化字段，不传原文图片、工资扣款表、整封邮件或 OCR 完整正文；保存 `integration_links` 供回查与独立重试。目标写入前候选仍应由用户逐条确认，用户可选择关联已存在条目。
* 所有财务、共享任务、私人学习卡片默认仅自己，用户要主动共享才允许更广的数据流。对已经同步的远端项目，删除文书不会默认删除对应远端记录。

## 家計簿桥接（候选 / 原接口能力）

**现有**：`POST /api/entries` 接受 `type` (`income|expense|transfer`)、`date`、`time`、`amount`（**正整数日元**）、`category`、`merchant`、`paymentSource`、`note`、`clientRequestId`（8～128 位英数字下划线/短横线）、`duplicatePolicy`，并返回 `{ok,duplicate,id}`。代码中具有 D1 `ON CONFLICT(client_request_id) DO NOTHING`，重复消费规则还有候选检测。该端点是现有应用路由，并不自动具备跨 Worker 调用身份认证。

**新增桥接建议**：`POST /internal/document-import/entries`，仅服务端可访问。请求示例：

```json
{
  "external_user_binding_id": "opaque-binding",
  "idempotency_key": "da_b06c4e6c2db244e99aa4f5c3d4eb6cd0",
  "type": "income",
  "date": "2026-11-10",
  "amount_jpy": 250000,
  "category": "給与",
  "payment_source": "银行账户（用户选择的目标端 ID）",
  "merchant": "工资",
  "note": "2026年11月工资（不含私人 OCR）",
  "source_token": "opaque-doc-reference",
  "check_duplicates": true
}
```

目标端根据自己数据库验证 `category/payment_source` 映射，使用自身 `clientRequestId` 幂等写入或关联既有收入，返回真实 ID。信用卡利用速報、月度账单、信用卡还款、尚未支付的发票都不能默认生成一条消费。原币不是 JPY 时先保留原币并等待真实结算金额，不猜汇率。

## HomeFlow 桥接（候选 / 原接口能力）

**现有**：`POST /api/tasks` 接受 `title`、`notes`、`dueOn`、`visibility`、`assigneeUserId` 等；`clientRequestId` 是 UUID 格式（`[0-9a-f-]{36}`），可查询重复请求并回放任务 ID。现有 `visibility` 是 `private`/`household` 语义，必须映射而不能直接把文书助手 `shared` 发送过去。

**新增桥接建议**：`POST /internal/document-import/tasks`，请求示例：

```json
{
  "external_user_binding_id": "opaque-binding",
  "idempotency_key": "b84391a6-2b9a-4312-aed3-d030fc5d0d8a",
  "title": "确认电费支付",
  "due_on": "2026-11-29",
  "visibility": "private",
  "assignee_external_id": "mapped-user-id",
  "source_token": "opaque-doc-reference"
}
```

目标端验证家庭/负责人关联，仅由 HomeFlow 调度提醒。航班/酒店/网购任务优先关联已有旅行、购物记录；更新提醒必须保留旧日期和新的用户确认。OCR 不直接决定任务完成、奖励积分或购物核验。

## 知学桥接（候选 / 原接口能力）

**现有**：`/api/vocabulary/saved` 支持 `term`、`language=ja`、`entry` 和 `explicit=true`；使用 `language+term` 作为词条唯一身份。但保存逻辑是 `ON CONFLICT DO UPDATE entry_json=excluded.entry_json`，可能**覆盖用户自己编辑的释义**；且现有系统的私人学习记录没有双用户隔离。`/api/language-cards` 是静态课程内容，**不能直接当作个人自定义句卡库**。

**新增桥接建议**：

* `POST /internal/document-import/vocabulary:batch`：每项 `user_binding`, `term`, `language=ja`, `reading`, `meaning_zh`, `source_sentence_redacted`, `tags`, `idempotency_key`。目标端先检查已有词条，默认 `skip_existing`，绝不覆盖用户已有解释。批量最多 20 条，返回逐项状态和词条 ID。
* `POST /internal/document-import/sentence-cards:batch`：目标端新增用户专属句卡表及访问 API 后再启用；与内置 `/api/language-cards` 保持分离。
* 双人学习时必须先为知学增加用户维度、账户映射及迁移，否则明确限制当前仅一个授权学习账号可写入，不把第二人的词卡混入第一人。
* 单词和句子先去除姓名、地址、工资金额、卡号、订单号等个人信息；可保留无隐私的通用改写，标为“改写”。

## 错误处理 / 对账

* 对 `409 DUPLICATE_CANDIDATE`：必须返回候选远端记录供用户关联，不能强制新建。
* 对 `401/403`：停止调用、提示重新授权，不自动无限重试。
* 对超时：保存 `sending` 或 `unknown` 状态，后续按 `idempotency_key` 查询是否已经成功，再重试。
* 软删除、恢复或恢复备份时不自动触发远端写入。
* 上线条件：两账户、三目标各有最小权限测试，模拟网络成功后断线、重试、幂等、撤销、误删原件、真实目标端授权和账户映射。
