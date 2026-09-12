# 项目提示词：Bun + Elysia + HTMX + Tailwind 全栈应用框架

## 目标

用 Bun 运行时构建一个全栈 Web 应用框架，满足以下要求：

- **运行时**：Bun（优先使用其原生能力，减少依赖）
- **后端**：Elysia，服务端渲染 HTML，不使用 JSON API 为主的模式
- **前端交互**：HTMX，通过服务端返回 HTML 片段实现局部更新
- **样式**：Tailwind CSS，构建独立于 Bun 的 bundler
- **UI 体系**：借鉴 shadcn-htmx 的设计语言与组件结构（纯 HTML + Tailwind + ARIA，无 React 运行时依赖）
- **架构**：垂直切片（feature-sliced），每个功能自包含路由、UI、业务逻辑
- **组装方式**：用 Bun 插件在构建时自动发现并组装切片，主入口保持单行导入
- **交付物**：可打包为单个 Windows exe（`bun build --compile`）

## 目录结构约定

```text
src/
├── index.ts                    # 入口：仅一行 import 虚拟组装模块
├── index.css                   # Tailwind 入口（@import "tailwindcss" + @theme 设计 token）
├── db/
│   ├── schema.ts  //drizzle bun:sqlite
│   └── client.ts
├── shared/
│   ├── layout.tsx              # 全站 HTML 骨架（含 HTMX 脚本、CSS 链接）
│   └── ui/                     # 设计系统组件（button.tsx、dialog.tsx 等）
└── features/
    └── <feature-name>/
        ├── index.ts            # 导出 <name>Plugin（Elysia 实例，含 prefix）
        ├── service.ts          # 业务逻辑
        ├── *.tbschema.ts           # 类型/校验（TypeBox 或 Zod）
        ├── pages/              # 完整 HTML 页面（含 <html> 骨架）
        │   └── *.tsx
        ├── fragments/          # HTMX 片段（仅返回局部 HTML）
        │   └── *.tsx
        └── intercept.ts        # 可选：该切片的横切逻辑（认证、日志）
```

## 核心实现要求

**1. 切片约定**

每个 `features/<name>/index.ts` 必须导出一个具名 Elysia 插件：

```typescript
export const todosPlugin = new Elysia({ prefix: '/todos' })
  .get('/', () => TodosPage({ ... }))          // 完整页面
  .get('/list', () => TodoListFragment({ ... })) // HTMX 片段
  .post('/', ({ body }) => todoService.create(body))
```

命名规范：`<name>Plugin`，其中 `<name>` 与文件夹名一致（camelCase）。

**2. 构建时切片组装（Bun 插件）**

编写 `build-plugin.ts`，实现一个 Bun 插件，职责是：

- 在 `onResolve` 中拦截 `virtual:assembled-app`，导向虚拟命名空间
- 在 `onLoad` 中扫描 `src/features/` 下的所有目录
- 对每个目录生成 `import { <name>Plugin } from './src/features/<name>'`
- 生成 `new Elysia().use(...).listen(...)` 的组装代码
- 如存在 `intercept.ts`，自动生成 `.use(<name>Intercept)` 的调用

生成的虚拟模块导出 `app`，类型推断链必须完整保留（`typeof app` 可用于 Eden Treaty）。

**3. 主入口**

```typescript
// src/index.ts
import app from "virtual:assembled-app";
```

不得在此文件出现任何 `.use()`、业务逻辑或切片导入。

**4. 页面与片段的区分**

- `pages/*.tsx` 返回完整 HTML 文档，包含 `<html>`、`<head>`、Tailwind CSS 链接、HTMX 脚本。
- `fragments/*.tsx` 只返回局部 HTML（如 `<ul>`、`<li>`），供 HTMX 替换。
- 浏览器直接访问路由时命中 page；HTMX 请求 `hx-get` 时命中 fragment。两者共享同一 URL 前缀，但路径不同（如 `/todos` vs `/todos/list`）。

**5. Tailwind 构建**

- 使用 bun-plugin-tailwind

- 开发模式用 `bun run --parallel dev:server dev:css`，CSS 监听必须加 `--watch=always`。

**6. exe 打包**

```typescript
await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist",
  target: "bun",
  minify: true,
  plugins: [sliceAssembler],
  compile: {
    outfile: "./dist/myapp.exe",
    assets: ["./public"],   // 整个 public 目录嵌入 exe
  },
});
```

运行时通过 `Bun.file(\`${import.meta.dir}/public/assets/index.css\`)` 访问嵌入资源。Elysia 需显式提供 `/assets/index.css` 路由，返回 `text/css`。

**7. 已知限制与应对**

- Bun 单文件可执行程序**忽略 bundler 插件**（`compile` 模式下 `plugins` 不生效）。因此切片组装必须在 `Bun.build` 的 `plugins` 中完成，不能依赖 `compile` 阶段的插件。
- 如依赖 `sharp`、`canvas` 等原生模块，`--compile` 会失败。解法是改用 bundlerbus，或避免这类依赖。
- Elysia 插件去重基于 `name` 校验和。同一插件以不同配置挂载两次时，需设置不同 `name`。

### UI 组件来源

以 shadcn-htmx 的 **Hono JSX 风味**为参考，将其组件结构（HTML 语义 + Tailwind 类名 + ARIA 属性）移植到 Elysia 的 JSX 环境。组件放在 `shared/ui/`，纯函数组件，无客户端状态管理。交互（Dialog、Dropdown、Combobox）用 HTMX + 原生 HTML 元素（`<dialog>`、`<details>`、`popover`）实现。

### 验收标准

- 新增 `features/posts/` 目录并导出 `postsPlugin` 后，无需修改任何其他文件，构建即生效。
- `src/index.ts` 始终只有一行 import。
- 打包出的 exe 双击可运行，监听端口，浏览器访问能看到完整页面，HTMX 交互正常。
- CSS 从 exe 内部虚拟文件系统正确提供。
- 类型推断完整，`typeof app` 包含所有切片路由。

### 开发脚本

```json
{
  "scripts": {
    "dev": "bun run --parallel dev:server dev:css",
    "dev:server": "bun run --hot src/index.ts",
    "dev:css": "bun tailwindcss -i ./src/index.css -o ./public/assets/index.css --watch=always",
    "build": "bun run build:css && bun run build:exe",
    "build:css": "bun tailwindcss -i ./src/index.css -o ./public/assets/index.css --minify",
    "build:exe": "bun run ./build.ts"
  }
}
```

### 需要实现方补充决策的点

- 数据库选型（Bun 原生 SQLite？Drizzle？Prisma？）
- 校验库选 TypeBox（Elysia 原生）还是 Zod
- HTMX 版本与扩展（如 `hx-boost`、`hx-swap` 默认策略）
- 是否引入 Eden Treaty 做端到端类型安全
- 开发模式下虚拟模块的热重载行为（Bun 的 `--hot` 对虚拟模块的支持需实测）

---


数据库选型Bun 原生 SQLite
校验库：TypeBox
使用bun-tailwind-Plugin