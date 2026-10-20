# @workspace/htmx

Elysia HTML 插件（基于 [@kitajs/html](https://github.com/kitajs/html)）：JSX 组件、
suspense 流式渲染、PageResult 整页/片段分流、写操作三态助手、toast 全局机制。

## 使用

```ts
import { Elysia } from "elysia";
import { html } from "@workspace/htmx";

const app = new Elysia().use(html());
```

挂载后 **handler 直接返回 JSX 或 HTML 字符串即可**（`autoDetect` 默认开启）。
识别 PageResult 品牌对象时按 `HX-Request` 头分流：无 → layout 整页；有 → content 片段。

> 在本 monorepo 中，`@elysiax/core` 的 `elysiaxAPI` 已内置
> `.use(html())` + `.use(actions())`，页面路由（page/partials/actions）
> 零配置享受上述行为。

## 页面原语

- `PageResult` / `brandPageResult` / `isPageResult`——页面返回值品牌（core 的 definePage 打）
- `LayoutComponent`——全局壳签名：`({ title, meta, content, request }) => JSX`

## 写操作三态（actions 插件）

derive 三个 ctx 助手，协议细节（303 vs HX-Redirect、422 回显、HX-Trigger）收敛在框架：

```ts
.post("/apps", async ({ redirect, toast, formError }) => {
  toast("部署已开始", "success");   // 合并进 HX-Trigger 头（中文自动 encodeURIComponent）
  return redirect(routes.pages.canvas());  // hx → HX-Redirect；普通 → 303
})
```

- `ctx.redirect(url)`
- `ctx.toast(message, kind?)`——注意：响应头只支持 latin1，中文消息已自动编码，壳脚本负责解码
- `ctx.formError(fragment)`——hx → 422 + 片段；普通 → 422 + layout 整页

## toast 全局机制

`ToastRoot` + `ToastScripts`（AppLayout 默认包含）：toast 容器 + 启动脚本
（监听 `toast` 事件与 `htmx:responseError`），含 responseHandling 配置
（422 也参与 swap，写操作失败回显表单片段）。

## API

- `html(options?)` — Elysia 插件，选项见 `src/options.ts`
- `actions(options?)` — 三态助手插件
- context 辅助：`html(value)`（显式渲染）、`stream(fn, args)`（suspense 流式）
- 类型：`Component`（别名 `FC`）、`PropsWithChildren`
- 子路径导出：`@workspace/htmx/htmx`、`@workspace/htmx/hotwire`

## 测试

```bash
bun test
```
