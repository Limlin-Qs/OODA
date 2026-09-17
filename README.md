# Sharework

创新工作室实物设备共享系统的 Phase 1 MVP。当前闭环包括设备台账、成员身份与角色、借出/归还、未来预约与冲突控制、逾期站内提醒、只追加审计，以及成员和管理员界面。

## 本地运行

要求 Node.js 24.x、npm 和 PostgreSQL。真实配置通过未纳入版本控制的环境文件注入；`.env.example` 只包含公开结构，不含凭据。

```text
npm ci
npm run migrate
npm run dev:server
npm run dev
```

服务端默认监听 `http://127.0.0.1:4016`，健康检查为 `/healthz`。前端开发服务器会将 `/api`、`/auth` 和 `/healthz` 代理到服务端。生产构建：

```text
npm run lint
npm run build
npm run build:server
```

OIDC 配置完成后，访问前端的“登录”进入组织身份源；没有配置数据库或身份源时，服务会明确返回配置错误，不会使用静态业务数据或测试身份。

## 验证

```text
npm test
TEST_DATABASE_URL=<隔离数据库连接串> npm run test:integration
TEST_DATABASE_URL=<隔离数据库连接串> npm run test:e2e
```

集成和业务 E2E 必须连接隔离的真实 PostgreSQL。E2E runner 会执行迁移、创建一次性测试成员/设备/会话，并使用真实 API；不会使用生产凭据或真实通知收件人。

## 发布与恢复

`ops/Dockerfile` 构建服务端容器并保留前端产物；HTTPS 反向代理、OIDC 密钥和数据库连接串由部署环境注入。发布前执行兼容迁移和健康检查。备份、恢复和恢复演练入口见 [docs/operations/release-recovery.md](docs/operations/release-recovery.md)：

- `ops/backup.sh`：创建并校验 PostgreSQL custom dump。
- `ops/restore.sh`：需要显式 `CONFIRM_RESTORE=YES`。
- `ops/recovery-rehearsal.sh`：恢复到隔离目标库并检查迁移表。

Phase 2 和 Phase 3 仍为后续规划，本轮不实现数字订阅、许可证、卡券或配额能力。
