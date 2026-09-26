# @workspace/htmx

Elysia HTML 插件（基于 [@kitajs/html](https://github.com/kitajs/html)）：JSX 组件、
suspense 流式渲染、自动 content-type / doctype 检测。

## 使用

```ts
import { Elysia } from "elysia";
import { html } from "@workspace/htmx";

const app = new Elysia().use(html());
```

挂载后 **handler 直接返回 JSX 或 HTML 字符串即可**，不需要 `html()` 包裹
（`autoDetect` 默认开启，自动设置 `content-type: text/html`）：

```tsx
// 片段 —— 自动 text/html，不加 doctype
app.get("/users/ui", () => <UserList users={users} />);

// 整页 —— autoDoctype 默认 'full'，自动补 <!doctype html>
app.get("/page", () => (
  <html>
    <body>...</body>
  </html>
));
```

> 在本 monorepo 中，`@elysiax/core` 的 `elysiaxAPI` 已内置 `.use(html())`，
> 模块路由（`*.controller.tsx`）零配置享受上述行为。只有在 `elysiaxAPI`
> 之外、直接挂在根 app 上的路由才需要自己 `.use(html())`。

## 组件约定

- JSX：`class`（非 `className`），`hx-*` 属性有类型提示（各 app 的
  `src/htmx.d.ts` 通过 `import "@kitajs/html/htmx.js"` 引入增强）
- 模块片段：`modules/<name>/<name>.ui.tsx` 默认导出组件，由
  `moduleAggregator` 聚合；有 controller 时在路由里 `<Ui {...props}/>`
  渲染，无 controller 时自动挂载 `GET <route>/ui`

## API

- `html(options?)` — Elysia 插件，选项见 `src/options.ts`
  （`contentType` / `autoDetect` / `autoDoctype` / `isHtml`）
- context 辅助：`html(value)`（显式渲染）、`stream(fn, args)`（suspense 流式）
- 类型：`Component`（别名 `FC`）、`PropsWithChildren`
- 子路径导出：`@workspace/htmx/htmx`、`@workspace/htmx/hotwire`
  （启用对应的 kita 属性类型）

## 测试

```bash
bun test
```
