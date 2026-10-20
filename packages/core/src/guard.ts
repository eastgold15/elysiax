import { Elysia } from "elysia";
import type { PageEntry } from "./pages";

export interface GuardOptions {
  /** 未登录时普通请求的跳转目标 */
  loginUrl: string;
  /** 校验当前请求是否已登录（返回 falsy 即拒绝）；框架不含任何认证实现 */
  verify: (request: Request) => boolean | Promise<boolean>;
  /** 缺省策略：页面未声明 auth 时按什么处理，默认 "protected" */
  defaultAuth?: "public" | "protected";
}

/**
 * 路由守卫（page-architecture.md 7.5）：只做声明形状 + 拦截挂载点，
 * 不含任何认证实现。页面用 definePage(handler, { auth: "public" })
 * 声明公开；未通过时：普通请求 → 302 loginUrl；hx 请求 → 401 +
 * HX-Redirect（htmx 对 302 只会在局部区域跳转，必须走响应头）。
 *
 * start({ auth }) 传入才挂载，不挂载零开销零行为。
 */
export function elysiaxGuard(pages: PageEntry[], options: GuardOptions) {
  // 受保护页面的精确 URL（含 :param 形态，运行时按段匹配）
  const protectedUrls = new Set(
    pages
      .filter(
        (p) =>
          (p.page?.pageMeta?.auth ?? options.defaultAuth ?? "protected") ===
          "protected",
      )
      .map((p) => p.url),
  );
  const isProtected = (pathname: string) => {
    for (const pattern of protectedUrls) {
      const pa = pattern.split("/").filter(Boolean);
      const ua = pathname.split("/").filter(Boolean);
      if (pa.length !== ua.length) continue;
      if (pa.every((seg, i) => seg.startsWith(":") || seg === ua[i]))
        return true;
    }
    return false;
  };

  return new Elysia({ name: "elysiax-guard", seed: options }).onBeforeHandle(
    "global",
    async ({ request }) => {
      const { pathname } = new URL(request.url);
      if (!isProtected(pathname)) return;
      if (await options.verify(request)) return;
      if (request.headers.has("HX-Request"))
        return new Response(null, {
          status: 401,
          headers: { "hx-redirect": options.loginUrl },
        });
      return new Response(null, {
        status: 302,
        headers: { location: options.loginUrl },
      });
    },
  );
}
