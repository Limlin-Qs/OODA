# Architecture Decision Records

本目录只记录 `sharework_project` 中跨模块、长期有效、难以逆转或显著影响安全与数据正确性的架构决策。产品范围属于 [PRD](../PRD.md)，任务清单和普通工具选择不为“凑完整”而单独建立 ADR。

## 索引

| 编号 | 标题 | 状态 | 实现 |
| --- | --- | --- | --- |
| [0001](0001-frontend-baseline-react-ts-vite.md) | 前端基线：React 19 + TypeScript + Vite | Accepted | 模板基线已存在；业务前端未实现 |
| [0002](0002-open-architecture-questions.md) | 产品方向记录（已迁移至 PRD） | Deprecated | 不适用 |
| [0003](0003-server-authoritative-transaction-boundary.md) | 服务端权威状态与事务一致性边界 | Accepted | 借用、归还、预约、取消、审计已落地并测试 |
| [0004](0004-server-api-boundary.md) | 服务端与 API 边界 | Accepted | Fastify REST/JSON API 已落地 |
| [0005](0005-postgresql-persistence-and-migrations.md) | PostgreSQL 持久化、并发与迁移 | Accepted | PostgreSQL 迁移、约束、锁与恢复演练入口已落地 |
| [0006](0006-oidc-session-and-authorization.md) | OIDC 身份、会话与服务端授权 | Accepted | OIDC 验证边界、HttpOnly 会话和角色授权已落地；生产 IdP 配置待部署 |
| [0007](0007-in-app-notifications-and-worker.md) | 站内提醒与可靠任务处理 | Accepted | 去重、重试、尝试记录和站内查询已落地 |
| [0008](0008-container-deployment-and-recovery.md) | 容器化部署与恢复边界 | Accepted | Dockerfile、备份/恢复脚本和恢复演练材料已落地；生产代理/存储待配置 |

ADR-0001 至 ADR-0008 已接受，相关 Phase 1 能力已按上表落地并验证。生产部署细节仍需按 ADR-0008 完成环境配置；接受 ADR 不等于外部环境已经完成。

## 何时应写 ADR

通常需要 ADR：

- 应用边界或部署拓扑发生长期变化。
- 选择持久化模型、事务/一致性策略或身份信任边界。
- 采用会长期约束多个模块的数据、安全或集成方案。
- 替换已接受且迁移代价显著的技术方向。

通常不需要 ADR：

- 局部组件、样式、文件命名和普通重构。
- 可轻易替换、影响范围有限的开发工具或依赖。
- 尚无可选方案、没有做出选择的问题清单。
- 产品目标、用户故事、验收条件或迭代任务。

## 状态与流程

- `Proposed`：可评审提案，不授权实现。
- `Accepted`：用户已明确确认，可作为实现约束。
- `Superseded by ADR-xxxx`：被后续决策替代；原记录保留。
- `Deprecated`：该记录不再适合作为架构依据，但因历史原因保留。

新 ADR 默认 `Proposed`。只有用户明确确认后才能改为 `Accepted`，并记录确认日期。代码是否落实必须在“当前实现”中单独说明；`Accepted` 不等于“已实现”。

## 必备内容

每份 ADR 应结合当前仓库说明：

- 背景与驱动约束
- 状态和日期
- 一项明确决策及其范围
- 被认真考虑的替代方案
- 正面与负面后果
- 当前实现与现状差距
- 不在本决策范围的事项
- 重新评估条件

不得编造流量、并发、SLA 或合规等级；不得把候选产品、框架或云服务写成已经采用。

## 编号与维护

- 文件以四位数字递增编号，编号不回收。
- 已接受记录不删除；变更通过新 ADR 替代。
- 交叉链接必须指向实际存在的文件。
