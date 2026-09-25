import { inferdiElysia } from "@inferdi/elysia";
import type { Container } from "@inferdi/inferdi";
import type { ModuleEntry } from "./index";

export { inferdiElysia } from "@inferdi/elysia";

/**
 * 创建 DI 插件并挂载所有模块的 controller。
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
  const api = inferdiElysia({ container: root });

  let app = api as any;
  for (const mod of Object.values(modules)) {
    if (mod.controller) app = app.use(mod.controller);
  }
  return app as typeof api;
}
