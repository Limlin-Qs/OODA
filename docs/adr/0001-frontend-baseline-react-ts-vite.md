# ADR-0001 前端基线：React 19 + TypeScript + Vite

## 状态（Status）

Accepted。前端基线已在仓库中存在；本状态不表示产品功能已经实现。

## 日期

- 最后核对：2026-09-12

## 背景（Context）

仓库由 Vite `react-ts` 模板初始化。产品现在已明确为创新工作室物资共享系统，但仓库仍只有模板代码。需要保留一个小而明确的前端基线，同时避免它替后端、数据、鉴权或部署做出选择。

实际配置：

- `react@19.2.4`、`react-dom@19.2.4`。
- `typescript@6.0.2`、`vite@8.0.5`、`@vitejs/plugin-react@6.0.1`。
- ESM；`tsc -b && vite build`；ESLint 9 flat config。
- `src/App.tsx` 是模板计数器；没有路由、服务端通信、状态管理或测试。
- 2026-09-12 执行 `npm run lint` 与 `npm run build` 均通过。

## 决策（Decision）

继续采用 **React 19 + TypeScript + Vite** 作为 Web 前端基线：

- 保持客户端渲染和 ESM 构建，除非后续出现明确 SSR/SEO 或服务端渲染需求。
- 以 TypeScript 项目构建和 ESLint 作为当前最低静态质量检查。
- 暂不启用 React Compiler，沿用当前模板配置。
- 此决策仅约束前端构建基线，不决定路由、状态管理、UI 组件库、API 协议、后端运行时、数据库、鉴权或部署平台。

## 替代方案（Alternatives）

- **立即迁移到 Next.js/Remix 等全栈框架**：当前没有 SSR/SEO 或一体化部署需求，迁移会提前绑定尚未确认的服务端边界。
- **纯静态前端加浏览器存储**：只能用于界面原型，不能满足多人借还、权限、审计和并发占用的产品要求。
- **替换构建插件或启用 React Compiler**：当前没有构建性能证据支持变更，先保持现状。

## 后果（Consequences）

- 可以在已知、可构建的前端工具链上继续工作。
- 当前产物仅是静态资源，不能单独构成目标产品。
- 若将来确认 SSR、服务端组件或全栈一体化要求，需要重新评估本决策。
- 路由或局部工具依赖不必机械建立 ADR；只有它们改变全局应用边界或形成高迁移成本时才需要。

## 当前实现（Current Implementation）

已实现：模板入口、样式、静态资源、TypeScript/Vite/ESLint 配置及 npm 脚本。

未实现：任何设备、成员、借还、预约、提醒、权限或审计界面；也没有 API 集成、测试、CI/CD 和部署配置。

## 现状差距（Gaps）

- `README.md` 仍为模板说明。
- 无测试 runner 与测试用例。
- 无运行环境配置约定。
- 无服务端契约或可供集成的 API。
- 仓库尚未初始化 Git。

## 不在本决策范围（Out of Scope）

服务端运行时、数据持久化与迁移、身份与授权、通知、文件存储、任务调度、部署平台和 SLA。

## 重新评估条件（Re-evaluation Triggers）

- 确认需要 SSR、SEO、服务端组件或前后端一体化部署。
- 当前构建工具出现无法接受的兼容性、安全或维护问题。
- 产品形态不再以 Web 客户端为主。
