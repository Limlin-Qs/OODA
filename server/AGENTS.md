# AGENTS.md — server/

适用于 `server/`（Fastify 服务端、PostgreSQL 迁移与集成测试）。通用红线、权限矩阵和隐私边界见根 [AGENTS.md](../AGENTS.md)；本文件只补充服务端执行细则，不重复根规则。两者冲突时红线以根文件为准。

## 迁移（`server/migrations/`）

- schema 变更只写 `server/migrations/NNNN-*.sql` 版本化 SQL，一次提交一个可追踪版本；已应用的迁移文件不修改，修正用新增迁移。
- `npm run migrate`（`src/migrate.ts`）用版本表 `_sharework_schema_migrations` + `pg_advisory_xact_lock` 防并发重复执行；禁止手工修改共享环境数据库。
- 每个迁移必须在任务/PR 说明中写清兼容窗口、数据回填、失败处置和恢复办法；不承诺向下回滚；不可逆变更走扩展—迁移—收缩，破坏性步骤前确认备份可恢复。
- 禁止任何迁移 `UPDATE`/`DELETE audit_entries`（数据库触发器也会拒绝）；个人数据匿名化规则确认前，不写涉及审计或成员数据删除的迁移。
- 约束优先于应用校验：唯一性、区间排斥、状态 CHECK、外键尽量落库，应用层校验只做体验和错误信息。

## 事务、并发与幂等

- 业务命令一律走 `withTransaction`：身份/权限校验 → 前置状态校验 → 业务写入 → `appendAudit` → 幂等结果写入，同成同败。
- 占用互斥的既有模式不得替换为“先查后写”：设备行锁（`SELECT … FOR UPDATE`）作为借出/归还/预约/取消的串行点，配合 `borrow_records` 的 active 唯一索引和 `reservations` 的 GiST 排斥约束（`tstzrange(…, '[)' )`）。新增占用相关逻辑必须沿用该模式并补并发集成测试。
- 幂等键作用域 `(actor_member_id, operation, idempotency_key)` + `request_hash` 比对；同键不同内容抛 `idempotency_conflict`。新命令沿用 `acquireIdempotencyLock` / `insertIdempotencyResult`，不得自造第二套幂等机制。
- 业务时间一律取数据库 `CURRENT_TIMESTAMP`（TIMESTAMPTZ）；不用 `Date.now()` 判定占用、超期或审计时间。区间语义为半开 `[start, end)`。
- 提醒/通知意图与业务事实同事务持久化（`(borrow_id, stage)` 去重），发送与重试在事务外执行；失败只影响通知状态，不回滚借还事实。

## 错误语义

- 稳定错误码集中由 `app.ts` 错误处理器映射 HTTP 状态：`unauthenticated` 401、`forbidden`/`inactive_member` 403、`invalid_interval`/`invalid_due_at`/`missing_reason`/`invalid_*` 400、`not_found` 404、`conflict`/`idempotency_conflict`/`invalid_transition` 409、`configuration_required` 503。
- 新增错误码沿用同一命名风格（小写下划线），同步前端 `src/api.ts` 的展示逻辑；不得把数据库错误或堆栈直接返回给客户端。
- 未配置 `DATABASE_URL`/OIDC 时返回 `configuration_required`（503）；禁止用静态假数据或测试身份兜底。

## 测试

- 单测（`*.test.ts`）：领域规则、权限、会话等纯逻辑，不连数据库，跑 `npm test`。
- 集成测试（`*.integration.test.ts`）：必须连接真实 PostgreSQL（`TEST_DATABASE_URL` 指向隔离库，本地可用 `.test-postgres` 集群 + 独立数据库），跑 `npm run test:integration`。覆盖事务回滚、并发争用、唯一/引用/排斥约束、幂等重放、审计不可变、提醒去重与重试、越权与伪造用户 ID 拒绝。
- 领域规则或约束变更必须有回归测试；发现既有缺陷记录独立修复任务，不在无关改动中扩大范围。
- 测试数据用一次性随机后缀（UUID）隔离；不使用真实凭据、真实收件人或生产数据。

## 配置与秘密

- 服务端配置全部来自环境变量（键名见根目录 `.env.example`）；`.env*` 不入库。不得在源码、测试夹具或日志中写入真实连接串、OIDC 密钥或令牌。
- 日志不输出连接串、会话令牌、OIDC code、密码和联系方式明文。
