import { Elysia } from "elysia";
import { inferdiElysia } from "@inferdi/elysia";
import { html } from "@workspace/htmx";
import type { Container } from "@inferdi/inferdi";
import type { ModuleEntry } from "./index";

export { inferdiElysia } from "@inferdi/elysia";

/**
 * 创建 DI 插件并挂载所有模块的 controller / ui 片段。
 *
 * 内部已应用 `@workspace/htmx` 的 `html()` 插件（autoDetect），模块路由
 * 直接 `return <Component/>` 或 HTML 字符串即可获得 text/html 响应，
 * 无需 `html()` 包裹；裸返回 `<html>...` 会自动补 `<!doctype html>`。
 *
 * 模块有 `.ui.tsx` 但无 controller 时，自动挂载
 * `GET ${manifest.route ?? '/' + name}/ui` 渲染该组件（无 props，
 * 只适合静态片段；需要数据的组件请在 controller 里自行渲染）。
 *
 * 注意（Elysia 2.0）：`derive` 不跨 `.use()` 的兄弟插件边界传播，
 * 但会沿**同一实例链**传播。所以必须由 DI 插件实例自己来挂载各模块
 * controller，再整体 `.use()` 进外层 app —— 这样 `di`（每请求一个
 * InferDI scope）才能出现在模块路由的上下文里。
 *
 * ```ts
 * const api = elysiaxAPI(root, modules);
 * const app = new Elysia({ prefix: "/api" }).use(api);
 * ```
 */
export function elysiaxAPI<T extends Record<string | symbol, any>>(
  root: Container<T>,
  modules: Record<string, ModuleEntry>,
) {
  const api = inferdiElysia({ container: root }).use(html());

  let app = api as any;
  for (const mod of Object.values(modules)) {
    if (mod.controller) {
      app = app.use(mod.controller);
    } else if (mod.ui) {
      const route = mod.manifest.route ?? `/${mod.manifest.name}`;
      const Ui = mod.ui;
      app = app.use(new Elysia().get(`${route}/ui`, () => Ui({})));
    }
  }
  return app as typeof api;
}
