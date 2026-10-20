import { setupTypebox } from "elysia";
import * as typeboxType from "typebox/type";
import * as typeboxSystem from "typebox/system";
import * as typeboxValue from "typebox/value";
import * as typeboxSchema from "typebox/schema";
import * as typeboxCompile from "typebox/compile";
import { serve } from "bun";
import type { Container } from "@inferdi/inferdi";
import type { LayoutComponent } from "@workspace/htmx";
import { elysiaxAPI, type ElysiaxAPIOptions } from "./di";
import type { GuardOptions } from "./guard";
import { getLayout } from "./layout";
import type { ModuleEntry } from "./index";
import type { PageEntry } from "./pages";

export interface ElysiaxGenerated {
  modules: Record<string, ModuleEntry>;
  buildRootContainer: () => Container<any>;
  /** .elysiax/pages.gen 的页面路由表（无页面时 codegen 不生成，故可选） */
  pages?: PageEntry[];
  /** .elysiax/assets.gen 的全局样式文本（有则服务在 /api/assets/global.css） */
  globalCss?: string;
}

/**
 * 启动 elysiax 应用：根容器 + 模块装配 + 全栈 serve。
 * 生成物全部在 .elysiax/（elysiax dev / gen 生成），app 入口只剩：
 *
 * ```ts
 * import index from "./index.html";
 * import { start } from "@elysiax/core";
 * import * as gen from "../.elysiax";
 *
 * await start({ port: 3000, index, gen });
 * ```
 */
// elysia 惰性加载 typebox 走运行时 req("typebox/type")（dist/type/typebox-type.mjs），
// bun --compile 后在 $bunfs 里解析不到、编译产物一编译路由就死。
// 必须在模块顶层注入：controller 模块在 import 阶段就会调 t.Numeric() 等 stub，
// 等 start() 执行再注入就晚了。静态 import 会被打进产物，注入后跳过运行时解析。
// app 入口约定先 `import { start } from "@elysiax/core"` 再 import gen，本模块先求值。
setupTypebox({
  typebox: {
    type: typeboxType,
    system: typeboxSystem,
    value: typeboxValue,
    schema: typeboxSchema,
    compile: typeboxCompile,
  },
});

export async function start(opts: {
  port?: number;
  /**
   * 旧模式单页壳：`import index from "./index.html"`。
   * 页面架构下 htmx 页纯 SSR（AppLayout 渲染）、client 页由 codegen
   * 生成的壳 HTMLBundle 服务，不再需要它；保留仅为兼容旧应用。
   */
  index?: Bun.HTMLBundle;
  /** `import * as gen from "../.elysiax"` */
  gen: ElysiaxGenerated;
  /** 全局壳 AppLayout；缺省读 defineLayout 注册的全局单例 */
  layout?: LayoutComponent;
  /** API 前缀，默认 "/api" */
  apiPrefix?: string;
  /** 传入选项才启用 auth 宏（7.5）：页面/端点按 PageMeta.auth 受保护，不挂载零开销零行为 */
  auth?: GuardOptions;
  /** 透传 elysiaxAPI 的其余选项（如 validationError） */
  api?: Omit<ElysiaxAPIOptions, "pages" | "layout" | "apiPrefix">;
}) {
  const root = opts.gen.buildRootContainer();
  const pages = opts.gen.pages ?? [];
  const app = elysiaxAPI(root, opts.gen.modules, {
    ...opts.api,
    pages,
    layout: opts.layout ?? getLayout(),
    apiPrefix: opts.apiPrefix,
    auth: opts.auth,
  });
  const handle = (req: Request) => app.handle(req);

  // 动态路由表（Bun.serve routes 不支持热增，新增页面需重启 dev server）：
  // - client 页 URL → codegen 生成的壳 HTMLBundle（自带 JS/CSS 资产服务）
  // - SSR 页 URL → Elysia（PageResult 双响应）
  // - /api/* → Elysia（模块 controller + 页面 partials/actions）
  const routes: Record<string, unknown> = {};
  if (opts.index) routes["/"] = opts.index;
  for (const p of pages) {
    if (p.client && p.shell) routes[p.url] = p.shell;
    else if (p.page) routes[p.url] = handle;
  }
  if (opts.gen.globalCss)
    routes["/api/assets/global.css"] = new Response(opts.gen.globalCss, {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  routes["/api/*"] = handle;

  // auth 由 elysiaxAPI 的 auth 宏按路由挂载（7.5），不再包全局 URL 匹配守卫
  for (const k of Object.keys(routes))
    if (typeof routes[k] === "function") routes[k] = handle;

  serve({
    port: opts.port ?? 3000,
    routes: routes as never,
    development: true,
  });

  console.log(`✅ elysiax: http://localhost:${opts.port ?? 3000}`);
  console.log(`   已挂载模块: ${Object.keys(opts.gen.modules).join(", ") || "(无)"}`);
  if (pages.length)
    console.log(
      `   页面: ${pages.map((p) => `${p.url}${p.client ? " (client)" : ""}`).join(", ")}`,
    );
}
