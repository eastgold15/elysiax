import { Elysia } from "elysia";

export interface GuardOptions {
  /** 未登录时普通请求的跳转目标 */
  loginUrl: string;
  /** 校验当前请求是否已登录（返回 falsy 即拒绝）；框架不含任何认证实现 */
  verify: (request: Request) => boolean | Promise<boolean>;
  /** 缺省策略：页面未声明 auth 时按什么处理，默认 "protected" */
  defaultAuth?: "public" | "protected";
}


/**
 * auth 宏：page-architecture.md 7.5 的宏形态（Elysia 2.0 rc）。
 *
 * 路由选项 `{ auth: true }` 声明受保护；未通过 verify 时：
 * - 普通请求 → 302 loginUrl
 * - hx 请求 → 401 + HX-Redirect（htmx 对 302 只会在局部区域跳转）
 *
 * 用 beforeHandle 而非 derive：rc 里 derive 只有返回 status() 才短路，
 * 裸 Response 会被当上下文合并掉；且这里需要自定义响应头（location /
 * hx-redirect），beforeHandle 返回 Response 天然支持。handler 假设
 * 已登录（7.5「页面函数不写鉴权 if」）。
 *
 * 框架（elysiaxAPI 传了 auth）自动按 PageMeta.auth 给页面整页路由
 * 和 partials/actions 挂载；模块 controller 想用可自行 .use()：
 *
 * ```ts
 * elysiaxModule<S>().use(elysiaxAuth(opts)).get("/x", { auth: true }, ...)
 * ```
 */
export function elysiaxAuth(options: GuardOptions) {
  return new Elysia({ name: "elysiax/auth", seed: options }).macro({
    auth: {
      beforeHandle: async ({ request }) => {
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
    },
  });
}
