# elysiax 开发规则

## 一、页面划分

1. **一个页面 = 屏幕上独立的一块。**
   用户看到一个 URL 的画面，就有一个页面文件夹对应它。

2. **页面边界 = 用户心智边界，不是技术边界。**
   不按“数据库/网络/状态管理”切，按“用户看到什么”切。

3. **一棵目录树 `src/pages/`，页面文件夹内聚一切。**
   整页、hx 片段、写端点、DI、service、repository、可选 Solid client，
   都在同一个文件夹里。URL = 文件夹路径，没有路由配置。

4. **页面内标准结构：**

```
src/pages/<name>/
  <name>.page.tsx         ← 整页（definePage，L1）
  <name>.partials.tsx     ← hx 片段 + 展示组件（defineRoutes，L2）
  <name>.actions.tsx      ← 写端点（POST/DELETE，L2）
  <name>.di.ts            ← 服务声明（defineModule，L3）
  <name>.service.ts       ← 业务逻辑
  <name>.repository.ts    ← 数据访问
  client/                 ← Solid 逃生舱（可选，L5）
```

5. **没有 .page.tsx 的文件夹 = 纯服务模块。**
   只提供 DI，不进路由表（deploy/edge/github 形态）。

## 二、UI + 逻辑一体

6. **UI 和它的逻辑在同一个文件夹下。**
   看到 UI，同文件夹就能找到它的取数和状态。

7. **源码在仓库里，可下载、可修改。**
   没有运行时黑盒，没有“升级依赖”，只有“改自己代码”。

## 三、渲染与状态

8. **一块画面，一个展示组件，一个取数路径。**
   展示组件放 partials，整页（page）和写后片段刷新（actions）共用同一份渲染。

9. **整页/片段分流在框架层，页面函数零 if/else。**
   无 HX-Request → AppLayout 整页；有 → content 片段。

10. **写操作三态用 ctx 助手，不手写响应头。**
    `ctx.redirect`（303 vs HX-Redirect）、`ctx.toast`、`ctx.formError`（422 回显）。

11. **services 抛 ServiceError，actions 零 try/catch 回显。**
    预期错误 `return status(code, { error })`；错误展示收敛在框架统一映射。

12. **client 页整页归 Solid，与 htmx 永不操作同一 DOM。**
    模态/表单 Solid 内实现（UI 原语用 Kobalte）；后端走 actions 的 JSON 端点；
    依赖链禁 Node-only 包（dotenv/bun:sqlite 会让浏览器打包 500）。

## 四、依赖方向

13. **UI 只依赖 service，service 不依赖 UI。**

14. **页面之间零耦合，跨上下文组合上移到页面/actions 层。**
    InferDI 不支持双向 Lazy——service 保持单向依赖。

## 五、事件

15. **实时推送走 defineRealtime（SSE），结构数据走 REST + refetch。**
    高频状态不进低频结构通道。

16. **跨页面通信用 DI 图（di.get），不用字符串事件。**

## 六、新增功能

17. **加一个页面 = 加一个文件夹**（或 `elysiax new page <name>`）。
18. **加一个纯服务 = 加 di + service**（或 `elysiax new service <name>`）。
19. **页面升舱 Solid = 加 client/**（或 `elysiax new client <name>`）。

---

**一句话总纲：**

> 一棵目录树，页面即文件夹，URL 即路径；htmx 优先、Solid 兜底（补 htmx 交互不足，React 已弃用）；判定收敛框架层，业务代码零样板。

**完整文档见 [apps/website/docs](./apps/website/docs/)**：[框架概念](./apps/website/docs/elysiax.mdx) · [页面架构 L0-L5](./apps/website/docs/page-architecture.md) · [dockyard 实战](./apps/website/docs/dockyard.mdx) · [踩坑记录](./apps/website/docs/pitfalls.mdx)
