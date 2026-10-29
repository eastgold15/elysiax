---
title: 仓库导览与文件后缀
description: 新人第一站：elysiax 仓库每个目录、每个文件后缀是干什么的，以及"我要做 X 该建哪个文件"的对照表。
---

# 仓库导览与文件后缀

第一次打开仓库看到几百个文件很正常——**真正需要你看懂的只有 `src/pages/` 下的业务目录**，
其余是框架包、示例、文档站和生成物。这一页按"目录 → 页面原子 → 文件后缀 → 我该建什么"的顺序讲完。

## 1. 先看这张地图

```
elysiax/
├─ apps/
│  ├─ demo/                  # 可运行的示例应用：4 个原子覆盖 htmx / Solid / 数据库三种形态
│  └─ docs/                  # 文档站（blume），docs/docs/ 下就是本页
├─ packages/                 # 框架本体（纯 ESM，每个包只做一件事）
│  ├─ core/                  # 运行时：start / codegen / definePage / defineModule / defineLayout
│  ├─ cli/                   # elysiax 命令：dev / gen / doctor / new
│  ├─ htmx/                  # 服务端 TSX 渲染：html()、defineRoutes、HX 三态助手
│  ├─ solid/                 # Solid client 入口的 Bun 插件（把 client/index.tsx 预打包成 .client.js）
│  ├─ flow/                  # 画布基座：panzoom / 拖拽 / 连线 / 拉伸（纯 DOM + SVG）
│  └─ elysia/                # InferDI 的 Elysia 请求作用域插件（包名 @inferdi/elysia）
├─ scripts/                  # 仓库自用工具（atoms-mcp.ts：给 AI 读原子清单的 MCP server）
├─ docs/atoms.md             # 旧笔记，内容以 apps/docs/docs/ 为准
├─ DESIGN.md                 # 设计哲学长文（为什么这么切）
├─ CLAUDE.md                 # 给 AI / 开发者的硬规则摘要
└─ 各应用根目录下的 .elysiax/ # codegen 生成物，git 忽略，永远不要手改
```

一个应用（例如 `apps/demo`）通常长这样：

```
apps/demo/
├─ src/
│  ├─ index.ts               # 入口：start({ port, gen })
│  ├─ app.layout.tsx         # 全站唯一 AppLayout（<html> 壳、导航、toast 容器）
│  ├─ infra.di.ts            # 基础设施 DI（最先装配，例如 db）
│  ├─ global.css             # 全局样式（codegen 会内联进 assets.gen）
│  ├─ htmx.d.ts              # 环境类型补充（框架/平台没有自带的类型）
│  ├─ shared/                # 跨原子共享的零依赖工具（浏览器安全，禁止业务逻辑）
│  └─ pages/                 # ★ 业务都在这：一个文件夹 = 一个页面/原子
├─ elysiax.config.ts         # 应用配置（端口、桌面壳、打包目标）
├─ bunfig.toml               # Bun 配置（例如 Tailwind 插件、BUN_PUBLIC_ 环境变量）
├─ package.json
└─ tsconfig.json
```

## 2. 一个页面文件夹长什么样

以 `src/pages/todo/` 为例（htmx 形态 + 数据库）：

```
pages/todo/
├─ todo.di.ts              # 模块身份证：defineModule({ route, provides })，codegen 靠它发现本原子
├─ todo.socket.ts          # 唯一对外插座：导出表、行类型、服务类、API 类型
├─ todo.service.ts         # 业务逻辑：抛 ServiceError，不碰 HTML
├─ todo.repository.ts      # 数据访问：依赖 "db" 值服务
├─ schema.ts               # drizzle 表定义（有持久化才需要）
├─ migrations.ts           # 本原子的迁移（有持久化才需要）
├─ todo.page.tsx           # 整页：default export definePage(...)
├─ todo.partials.tsx       # hx 片段 + 展示组件（整页/片段共用同一份渲染）
├─ todo.actions.tsx        # 写端点：只吐 HTML 片段
└─ todo.test.ts            # 就近单测（可选）
```

Solid 整页 client 形态（L5）把 `page/partials/actions.tsx` 换成：

```
pages/board/
├─ board.di.ts
├─ board.socket.ts
├─ board.service.ts
├─ board.repository.ts
├─ board.actions.ts        # 能力端点：只吐 JSON，default export 供 Eden 推导类型
└─ client/
   ├─ index.tsx            # Solid 入口（浏览器包），标记本目录为 client 页面
   ├─ api.ts               # Eden Treaty 客户端，类型来自 socket 的 API 类型出口
   └─ ...                  # 其它 UI 文件（board.tsx / nodes.tsx / live.ts …）
```

## 3. 文件后缀速查

分两类：**codegen 会扫描的后缀**（决定路由/装配）和**原子内部约定后缀**（靠 import 生效，doctor 会检查越界）。

### 3.1 codegen 扫描的后缀（改错 = 路由不生效）

| 后缀 | 作用 | 不写会怎样 |
|---|---|---|
| `<name>.di.ts` | 模块身份证，`default export defineModule({ route, provides })` | 原子不会被发现、不进 DI 图 |
| `<name>.page.tsx` | 整页 handler，`definePage(...)` | 没有整页路由 |
| `<name>.partials.tsx` | hx 片段路由（`defineRoutes()`） | 片段刷新无端点 |
| `<name>.actions.tsx` | 写端点，只吐 **HTML 片段** | 表单提交无端点 |
| `<name>.actions.ts` | 能力端点，只吐 **JSON**（Solid 形态） | 浏览器无数据接口 |
| `client/index.tsx` | 标记本目录为整页 client 模式，走 HTMLBundle 壳 | 当作普通页面（无客户端渲染） |

URL 推导规则（`packages/core/src/codegen.ts` 的 `scanPages`）：

- `index.page.tsx` 或 `<目录名>.page.tsx` → 目录 URL（`pages/todo/todo.page.tsx` → `/todo`）
- 其它 `<x>.page.tsx` → 目录 URL + `/x`（`pages/todo/list.page.tsx` → `/todo/list`）
- `[id]/` 目录段 → `:id` 动态参数；`.` 或 `_` 开头的文件/目录被跳过
- `client/` 目录不参与 URL（它只是页面标记）

### 3.2 原子内部约定后缀（import 生效，插座门禁检查）

| 后缀 | 作用 | 规则 |
|---|---|---|
| `<name>.socket.ts` | 唯一对外门 | 别的原子只能从这里 import；导出表锚点、行类型、服务类、API 类型 |
| `<name>.service.ts` | 业务逻辑 | 只抛 `ServiceError`；不 import UI |
| `<name>.repository.ts` | 数据访问 | 依赖 `"db"` 值服务；SQL/ORM 只在这里 |
| `<name>.model.ts` | 视图模型 / DTO | 服务端与 client 同构共享；**只放类型与纯数据** |
| `schema.ts` / `migrations.ts` | drizzle 表与迁移 | 迁移只追加，时间戳全局排序 |
| `<name>.layout.tsx` | 全局壳（约定名 `app.layout.tsx`） | 由 `index.ts` 侧效应 import；全站只一个，纯视觉不查业务 |
| `<name>.test.ts(x)` | 就近测试 | server 侧 `bun test`；浏览器侧 `bun test --conditions=browser` |
| `*.d.ts` | 环境类型补充 | 不给运行时行为 |
| `*.gen.ts` | **codegen 产物** | 在 `.elysiax/` 下，禁止手改、禁止提交 |
| 普通 `.ts` / `.tsx` | 本原子内部工具 | 例如 `zones.ts`、`discovery.ts`、`detect.ts`；跨原子必须走 socket |

### 3.3 已废弃、会被 codegen 直接拒绝的后缀

- `.controller.tsx` / `.ui.tsx`：旧约定，`elysiax gen` 会报错并列出文件，请迁移到 `.page.tsx` / `.partials.tsx` / `.actions.tsx`。

## 4. "我要做 X，该建哪个文件？"

| 我要… | 做法 |
|---|---|
| 新建一个表单/列表类页面 | `bunx elysiax new module <name> --ui htmx`（加 `--db` 带数据层骨架） |
| 新建一个整页客户端界面 | `bunx elysiax new module <name> --ui solid` |
| 给已有页面加客户端交互 | 目录下放 `client/index.tsx`，端点改/加 `<name>.actions.ts` |
| 新增一张表 | 本原子 `schema.ts` + `migrations.ts`（只追加） |
| 让别的原子调用我的服务 | 在 `<name>.socket.ts` 导出服务类 / 表 / 类型 |
| 在 client 里请求数据 | `<name>.actions.ts` 加 JSON 端点，`client/api.ts` 走 Eden |
| 写一个可复用的纯函数 | 同目录普通 `.ts`；只有**浏览器也要用**的零依赖工具才放 `src/shared/` |
| 加一个测试 | 与被测文件同目录的 `<thing>.test.ts(x)` |

## 5. `.elysiax/` 里都是什么（生成物，别怕也别改）

`bunx elysiax gen` 扫描 `pages/` 后生成，`dev` 会在页面结构/client 源变化时自动重生成并重启：

| 文件 | 内容 |
|---|---|
| `container.gen.ts` | InferDI 容器装配（各原子的 provide 串起来） |
| `modules.gen.ts` | 原子清单 |
| `routes.gen.ts` | 路由表（Eden 类型来源之一） |
| `pages.gen.ts` | 页面注册表（URL、整页/hx/JSON/client 标记） |
| `services.gen.ts` | 服务类型出口 |
| `controller.gen.ts` | Elysia 控制器装配 |
| `assets.gen.ts` | 内联的全局样式文本 |
| `desktop.gen.ts` | 桌面壳配置 |
| `shells/<slug>.html` + `<slug>.client.js` | client 页的 Bun HTMLBundle 壳与预打包入口 |
| `index.ts` | 以上产物的统一出口（`import * as gen`） |

它们相当于 `.next/`：**看懂它有助于理解"魔法"，改它没有任何意义**（下次 gen 就覆盖）。

## 6. 新人阅读路线（约 15 分钟）

1. 本页 + 仓库根目录 `CLAUDE.md` 的硬规则
2. `apps/demo/src/index.ts` → `app.layout.tsx`：应用怎么起、壳在哪
3. `pages/todo/`：按 `di → socket → service → repository → page/partials/actions` 顺序读一遍（htmx + DB 全形态）
4. `pages/board/`：`actions.ts` + `client/index.tsx`（Solid + JSON 形态）
5. 想看路由"魔法"：`packages/core/src/codegen.ts` 的 `scanPages`（约 100 行）
6. 想核对生成结果：`apps/demo/.elysiax/pages.gen.ts` 与 `routes.gen.ts`

## 7. 常见误解

- **文件名 ≠ 随便起**：`.page.tsx` 的 stem 参与 URL；`board.page.tsx` 放在 `pages/board/` 下才是 `/board`，`boards.page.tsx` 会变成 `/board/boards`。
- **`.actions.ts` 和 `.actions.tsx` 不是风格差异**：前者吐 JSON，后者吐 HTML。一个原子选一种渲染器，不双写、不做内容协商。
- **没有 `.page.tsx` 的目录不是错误**：纯服务模块（只提供 DI，不进路由）是合法形态。
- **`client/` 不是"组件文件夹"**：它是整页 client 模式的标记；普通展示组件放 `partials.tsx` 或 client 内部文件。
- **跨原子 import 只能走 `*.socket.ts`**：直接 import 别人的 service/schema 会被插座门禁和 review 打回。
- **别手改 `.elysiax/`、别提交它**：已在 `.gitignore`；typecheck 也会重写它（dev watcher 会自动重启自愈）。

## 8. 常用命令

```bash
bun run dev                 # turbo 起所有应用的 dev（单应用内：bunx elysiax dev）
bunx elysiax gen            # 重新生成 .elysiax/（typecheck 会自动跑）
bunx elysiax doctor         # 契约体检：DI/路由/插座/迁移/错误约定/端点 schema
bun run typecheck           # gen + tsc --noEmit
bun test                    # server 侧测试
bun test --conditions=browser  # client 组件测试（happy-dom）
bunx elysiax new module <name> --ui htmx|solid [--db]
```

延伸阅读：[页面架构 L0-L5](./page-architecture.md) · [模块契约](./module-contract.md) · [elysiax 框架概念](./elysiax.mdx) · [踩坑记录](./pitfalls.mdx)
