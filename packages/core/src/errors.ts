import { ValidationError } from "elysia";

/**
 * 领域错误基类：services 抛出（替代 `throw new Error("中文消息")` +
 * controller 人肉 try/catch），框架（elysiaxAPI）按错误类统一映射：
 * - hx 请求 → statusCode + 错误横幅片段（htmx responseHandling 允许
 *   swap 非 2xx，见 page-architecture.md 7.2/7.3）
 * - 普通请求 → JSON `{ error }` + statusCode
 *
 * 子类化可区分错误类别（DeployError、SshError……），均走同一映射；
 * 需要不同片段形态时在 elysiaxAPI 用 .error(SubClass, handler) 覆盖。
 */
export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 统一错误横幅：inline style 不依赖任何主题，role=alert 可读屏 */
export const errorBanner = (message: string) =>
  `<div role="alert" style="border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;` +
  `border-radius:6px;padding:8px 12px;font-size:12px;margin-bottom:8px">` +
  `${escapeHtml(message)}</div>`;

/**
 * ServiceError 的统一映射（elysiaxAPI 注册）。hx → 片段；否则 JSON。
 */
export function serviceErrorHandler({ error, request }: { error: ServiceError; request: Request }) {
  if (!request.headers.has("HX-Request"))
    return Response.json({ error: error.message }, { status: error.statusCode });
  return new Response(errorBanner(error.message), {
    status: error.statusCode,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * ValidationError 的 hx 映射（elysiaxAPI 注册）：非 htmx 请求返回
 * undefined，走 elysia 默认 JSON 422。
 */
export function validationErrorHandler(
  banner: (error: ValidationError) => string,
) {
  return ({ error, request }: { error: ValidationError; request: Request }) => {
    if (!request.headers.has("HX-Request")) return;
    return new Response(banner(error), {
      status: 422,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
}
