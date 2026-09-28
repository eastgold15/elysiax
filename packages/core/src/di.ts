import { Elysia, ValidationError } from "elysia";
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
type DiCtx<S extends Record<string, unknown>> = {
  di: Container<ServiceSpecs<S>>;
} & Record<string, any>;

/** .ui() 挂载的组件签名（@kitajs/html Component 的宽松版） */
type UiComponent<P> = (props: P) => unknown;

export interface UiRoute<S extends Record<string, unknown>> {
  /**
   * UI 片段路由：`取数 → 渲染组件` 一步声明，等价于
   * `.get(path, async (ctx) => <Component {...await model(ctx)} />)`。
   * 不传 model 即静态片段。
   */
  ui<P>(
    path: string,
    component: UiComponent<P>,
    model?: (ctx: DiCtx<S>) => P | Promise<P>,
  ): this;
}

export function elysiaxModule<S extends Record<string, unknown>>(
  options?: ConstructorParameters<typeof Elysia>[0],
) {
  const app = new Elysia(options) as unknown as Elysia<
    "",
    "local",
    { decorator: {}; store: {}; derive: { di: Container<ServiceSpecs<S>> } }
  > &
    UiRoute<S>;

  // Elysia 链式方法原地返回同一实例，挂个 ui 方法不破坏后续链
  (app as any).ui = function (
    this: any,
    path: string,
    component: UiComponent<any>,
    model?: (ctx: DiCtx<S>) => unknown,
  ) {
    return this.get(path, async (ctx: DiCtx<S>) =>
      component({ ...((model ? await model(ctx) : {}) as object) }),
    );
  };
  return app;
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
export interface ElysiaxAPIOptions {
  /**
   * htmx 请求的 typebox 校验错误回显：HX-Request 头 + ValidationError 时，
   * 返回 200 + 错误横幅片段（htmx 默认不 swap 4xx，片段必须能吃进 target），
   * 非 htmx 请求仍走默认 JSON 422。传 false 关闭，传函数自定义片段。
   */
  validationError?: false | ((error: ValidationError) => string);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 默认校验错误横幅：inline style 不依赖任何主题，role=alert 可读屏 */
const defaultValidationBanner = (error: ValidationError) =>
  `<div role="alert" style="border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;` +
  `border-radius:6px;padding:8px 12px;font-size:12px;margin-bottom:8px">` +
  `表单校验失败：${escapeHtml(error.message)}</div>`;

export function elysiaxAPI<T extends Record<string | symbol, any>>(
  root: Container<T>,
  modules: Record<string, ModuleEntry>,
  options: ElysiaxAPIOptions = {},
) {
  const api = inferdiElysia({ container: root }).use(html());

  if (options.validationError !== false) {
    const banner = options.validationError ?? defaultValidationBanner;
    // Elysia 2：错误处理器按错误类注册（.error(Class, handler)）
    (api as any).error(ValidationError, ({ error, request }: any) => {
      if (!request.headers.has("HX-Request")) return; // 非 htmx 走默认 JSON 422
      // 显式 200 Response：htmx 默认不 swap 4xx，片段必须能吃进 target
      return new Response(banner(error), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
  }

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
