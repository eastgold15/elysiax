import { Elysia } from "elysia";
import { inferdiElysia } from "@inferdi/elysia";
import { html } from "@workspace/htmx";
import type { Container, Lifetime, Spec } from "@inferdi/inferdi";
import type { ModuleEntry } from "./index";

export { inferdiElysia } from "@inferdi/elysia";

/** 把「服务名 → 服务类型」映射成 InferDI 容器的依赖图谱 */
type ServiceSpecs<S extends Record<string, unknown>> = {
  [K in keyof S]: Spec<S[K], Lifetime>;
};

/**
 * 定义一个模块 controller：与 `new Elysia()` 相同，但上下文里的 `di`
 * （每请求一个 InferDI scope）带有类型 —— 泛型参数声明本模块需要
 * 从容器解析的服务（对应 module.json 的 requires / provides）。
 *
 * 运行时的 `di` 由 `elysiaxAPI` 在挂载时注入（derive 沿同一实例链传播），
 * 这里只补充类型，不产生任何运行时行为。
 *
 * ```ts
 * export const orderController = elysiaxModule<{ userService: UserService }>(
 *   { prefix: "/orders" },
 * ).get("/:id/user-name", ({ di, params }) =>
 *   di.get("userService").listUsers()...
 * );
 * ```
 */
export function elysiaxModule<S extends Record<string, unknown>>(
  options?: ConstructorParameters<typeof Elysia>[0],
) {
  return new Elysia(options) as unknown as Elysia<
    "",
    "local",
    { decorator: {}; store: {}; derive: { di: Container<ServiceSpecs<S>> } }
  >;
}

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

  let app = api
  for (const mod of Object.values(modules)) {
    if (mod.controller) {
      // controller 是 any 泛型的 Elysia（各模块 derive 类型不同），
      // 挂载结果在框架边界内断言回 api 链类型
      app = app.use(mod.controller) as unknown as typeof app;
    } else if (mod.ui) {
      const route = mod.manifest.route ?? `/${mod.manifest.name}`;
      const Ui = mod.ui;
      app = app.use(new Elysia().get(`${route}/ui`, () => Ui({}))) as unknown as typeof app;
    }
  }
  return app
}
