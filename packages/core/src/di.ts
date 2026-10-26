import { Elysia, ValidationError } from "elysia";
import { websocket } from "elysia/websocket";
import { compress } from "@elysia/compress";
import { openapi } from "@elysia/openapi";
import { inferdiElysia } from "@inferdi/elysia";
import { actions, html, type LayoutComponent } from "@elysiax/htmx";
import type { Container, Lifetime, Spec } from "@inferdi/inferdi";
import type { ModuleEntry } from "./index";
import type { PageEntry } from "./pages";
import { elysiaxAuth } from "./auth";
import type { GuardOptions } from "./auth";
import {
  ServiceError,
  serviceErrorHandler,
  validationErrorHandler,
  errorBanner,
} from "./errors";

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
    {
      decorator: {};
      store: {};
      derive: {
        di: Container<ServiceSpecs<S>>;
        // 类型声明：运行时由 elysiaxAPI 的 actions() 插件 derive('global') 注入
        redirect: (url: string) => Response;
        toast: (message: string, kind?: "info" | "success" | "error") => void;
        formError: (fragment: unknown) => Response;
      };
    }
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
 * 内部已应用 `@elysiax/htmx` 的 `html()` 插件（autoDetect），模块路由
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
   * 返回 422 + 错误片段（全局壳的 responseHandling 配置允许 swap 422，
   * 见 page-architecture.md 7.2），非 htmx 请求仍走默认 JSON 422。
   * 传 false 关闭，传函数自定义片段。
   */
  validationError?: false | ((error: ValidationError) => string);
  /** 页面路由表（.elysiax/pages.gen）；不传则只有模块路由 */
  pages?: PageEntry[];
  /** 全局壳 AppLayout（html() 的 PageResult 双响应用） */
  layout?: LayoutComponent;
  /** API 前缀（模块 controller 与页面 partials/actions 的挂载点），默认 "/api" */
  apiPrefix?: string;
  /**
   * auth 宏（7.5）：传入即按 PageMeta.auth 给页面整页路由、partials、
   * actions 挂载 `{ auth: true }` 守卫（未声明页面随 defaultAuth 策略，
   * 默认 protected）。client 页的壳是静态 HTML，其 JSON 端点（本页的
   * partials/actions）同样受保护。模块 controller 需自行 .use(elysiaxAuth)。
   */
  auth?: GuardOptions;
  /**
   * 响应压缩（@elysia/compress，Elysia 2 RC 官方插件）：br/zstd/gzip/deflate
   * 按 Accept-Encoding 协商，≥1KB 才压，SSE（text/event-stream）自动排除。
   * 传 false 关闭；默认开启。
   */
  compress?: false | Parameters<typeof compress>[0];
  /**
   * OpenAPI 文档（@elysia/openapi）：挂载 /openapi（Scalar UI）+ /openapi/json。
   * 路由与运行时 schema 从路由注册表生成——我们的端点 body/query/params 都有
   * 显式 t schema，spec 天然完整。fromTypes() 不适用：elysiaxAPI 在框架边界
   * 把组合类型断言回基链（路由类型不进 App 类型），等类型管道打通后再启用。
   */
  openapi?: boolean | Parameters<typeof openapi>[0];
}

/** 默认校验错误横幅（errorBanner 统一样式） */
const defaultValidationBanner = (error: ValidationError) =>
  errorBanner(`表单校验失败：${error.message}`);

export function elysiaxAPI<T extends Record<string | symbol, any>>(
  root: Container<T>,
  modules: Record<string, ModuleEntry>,
  options: ElysiaxAPIOptions = {},
) {
  // Elysia 2：.ws() 需要显式 websocket 能力，框架层统一开启（各 controller 直接用 .ws）
  // as any：packages/htmx 有独立 node_modules/elysia（同版本但物理两份），
  // Elysia 类的 #private 字段跨包不可互认（TS2769）；derive 的运行时注入不受影响，
  // 类型在 elysiaxModule 里手工声明（di/redirect/toast/formError）
  const api = inferdiElysia({ container: root })
    .use(html({ layout: options.layout }) as any)
    .use(actions({ layout: options.layout }) as any)
    .use(websocket());

  // 响应压缩：默认开启（SSE/小响应/已编码响应插件自动跳过）
  if (options.compress !== false) api.use(compress(options.compress ?? {}));

  if (options.validationError !== false) {
    const banner = options.validationError ?? defaultValidationBanner;
    // Elysia 2 rc：错误处理器按错误类注册（.onError(Class, handler)）
    api.onError(ValidationError, validationErrorHandler(banner));
  }
  // ServiceError：services 抛类型化错误 → 统一 hx 片段 / JSON 映射，
  // controller 不再各自 try/catch 回显（7.3）
  api.onError(ServiceError, serviceErrorHandler);

  // auth 宏：具名插件幂等，内层实例各自 .use() 以获得宏定义
  const authed = options.auth ? elysiaxAuth(options.auth) : null;
  /** 页面是否受保护：PageMeta.auth 优先，缺省随 start({ auth }) 策略 */
  const isProtected = (p: PageEntry) =>
    (p.page?.pageMeta?.auth ?? options.auth?.defaultAuth ?? "protected") ===
    "protected";

  const apiPrefix = options.apiPrefix ?? "/api";

  let app = api
  for (const mod of Object.values(modules)) {
    if (mod.controller) {
      // controller 是 any 泛型的 Elysia（各模块 derive 类型不同），
      // 挂载结果在框架边界内断言回 api 链类型
      app = app.use(
        new Elysia({ prefix: apiPrefix }).use(mod.controller),
      ) as unknown as typeof app;
    } else if (mod.ui) {
      const route = mod.manifest.route ?? `/${mod.manifest.name}`;
      const Ui = mod.ui;
      app = app.use(
        new Elysia({ prefix: apiPrefix }).get(`${route}/ui`, () => Ui({})),
      ) as unknown as typeof app;
    }
  }

  // 页面路由（L0）：整页挂自然 URL；partials/actions 挂 /api<页面URL>。
  // client 页（L5）的 url 由 Bun.serve 的 HTMLBundle 服务，这里只挂端点。
  //
  // as unknown as：Elysia 每次链式调用都生成新的泛型实例（类型不可重新
  // 赋值），且各页面的 derive 泛型互不相同；框架边界内断言回 app 链类型。
  for (const p of options.pages ?? []) {
    if (p.page && !p.client) {
      const handler = p.page;
      type Ctx = Parameters<typeof handler>[0];
      const pageApp = authed
        ? new Elysia()
            .use(authed)
            .get(p.url, { auth: isProtected(p) }, (ctx) =>
              handler(ctx as unknown as Ctx),
            )
        : new Elysia().get(p.url, (ctx) => handler(ctx as unknown as Ctx));
      app = app.use(pageApp) as unknown as typeof app;
    }
    if (p.partials || p.actions) {
      const prefix = `${apiPrefix}${p.url === "/" ? "" : p.url}`;
      if (authed) {
        // guard 把宏选项批量应用到本页所有片段/写端点
        const sub = new Elysia({ prefix })
          .use(authed)
          .guard({ auth: isProtected(p) }, (s) => {
            let r = s;
            if (p.partials) r = r.use(p.partials) as unknown as typeof r;
            if (p.actions) r = r.use(p.actions) as unknown as typeof r;
            return r;
          });
        app = app.use(sub) as unknown as typeof app;
      } else {
        let sub = new Elysia({ prefix });
        if (p.partials) sub = sub.use(p.partials) as unknown as typeof sub;
        if (p.actions) sub = sub.use(p.actions) as unknown as typeof sub;
        app = app.use(sub) as unknown as typeof app;
      }
    }
  }
  // OpenAPI 文档：最后挂载（reflect 运行时路由注册表，顺序无关）
  if (options.openapi)
    app = app.use(
      openapi(options.openapi === true ? {} : options.openapi),
    ) as unknown as typeof app;
  return app
}
