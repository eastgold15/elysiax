import { brandPageResult } from "@elysiax/htmx";
import type { Container, Lifetime, Spec } from "@inferdi/inferdi";

/** 与 di.ts 同一映射：服务名 → InferDI 容器图谱 */
export type ServiceSpecs<S extends Record<string, unknown>> = {
  [K in keyof S]: Spec<S[K], Lifetime>;
};

/** 页面 handler 的上下文：di 与 controller 同一个 root container 的每请求 scope */
export type PageCtx<S extends Record<string, unknown>> = {
  di: Container<ServiceSpecs<S>>;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  request: Request;
} & Record<string, any>;

export interface PageMeta {
  /** 守卫元数据（P1-4）；缺省随 start({ auth }) 的默认策略 */
  auth?: "public" | "protected";
}

export type PageHandler<S extends Record<string, unknown>> = ((
  ctx: PageCtx<S>,
) => unknown) & { pageMeta?: PageMeta };

/**
 * 定义一个页面（L1 原子）：一个 URL 的完整渲染单元。
 *
 * 返回值：
 * - `{ title, meta, content }` → 完整 PageResult
 * - 裸 JSX → 视为 `{ content }`
 * - `Response` → 原样透传（重定向页：`return new Response(null, { status: 302, headers: { location: "/x" } })`）
 *
 * 整页 / hx 片段的分流由 html() 插件按 HX-Request 头完成（7.1），
 * 页面函数只写一份渲染代码。
 *
 * ```tsx
 * // src/pages/projects/projects.page.tsx
 * export default definePage<ProjectsServices>(async ({ di }) => ({
 *   title: "项目",
 *   content: <ProjectList items={await di.get("projectService").list()} />,
 * }));
 * ```
 */
export function definePage<S extends Record<string, unknown> = any>(
  handler: (ctx: PageCtx<S>) => unknown,
  meta?: PageMeta,
): PageHandler<S> {
  const wrapped = (async (ctx: PageCtx<S>) => {
    const r = await handler(ctx);
    // handler 直接返回 Response（如根页面的 302 重定向）时原样透传，不打 PageResult 品牌
    return r instanceof Response ? r : brandPageResult(r);
  }) as PageHandler<S>;
  wrapped.pageMeta = meta;
  return wrapped;
}

/** 页面片段/写端点的子路由实例（Elysia 泛型在页面边界处不可统一，断言到默认形态） */
type SubRouter = import("elysia").Elysia<any, any, any, any, any, any, any, any>;

/** 页面条目公共字段：URL + 可挂的片段/写端点（client 页也可有） */
interface PageEntryBase {
  /** 自然 URL（目录路径推导，[id] → :id），如 "/projects/:id/deploy" */
  url: string;
  /** hx 片段子路由（Elysia 实例，挂载在 /api<url> 前缀下） */
  partials?: SubRouter;
  /** 写端点 / JSON 子路由（同上前缀） */
  actions?: SubRouter;
}

/**
 * pages.gen 中每个页面条目的形态（codegen 生成）。
 *
 * 可辨识联合：字段组合即语义，非法组合在类型层写不出来（体检报告卡20）。
 * - client 页必须有壳（shell），不能同时有整页 handler——整页已归客户端
 * - SSR 页必须有整页 handler，不能有壳
 * - 只出片段/写端点的页：URL 本身无整页，至少要有 partials 或 actions 之一
 */
export interface ClientPageEntry extends PageEntryBase {
  /** client 模式：目录含 client/index.tsx，url 由 shell HTMLBundle 服务 */
  client: true;
  /** client 页的壳（Bun HTMLBundle），codegen 生成到 .elysiax/shells/ */
  shell: Bun.HTMLBundle;
  page?: never;
}

export interface SsrPageEntry extends PageEntryBase {
  /** 整页 handler（SSR） */
  page: PageHandler<any>;
  client?: never;
  shell?: never;
}

export interface PartialPageEntry extends PageEntryBase {
  /** 至少挂片段路由；actions 可并存 */
  partials: SubRouter;
  actions?: SubRouter;
  page?: never;
  client?: never;
  shell?: never;
}

export interface ActionPageEntry extends PageEntryBase {
  /** 只出写端点/JSON 端点 */
  actions: SubRouter;
  partials?: SubRouter;
  page?: never;
  client?: never;
  shell?: never;
}

export type PageEntry = ClientPageEntry | SsrPageEntry | PartialPageEntry | ActionPageEntry;
