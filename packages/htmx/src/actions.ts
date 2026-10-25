import { Elysia } from 'elysia'

import { handleHtml } from './handler'
import type { LayoutComponent } from './page'

/**
 * 写操作三态助手（page-architecture.md 7.2）：把 303 vs HX-Redirect、
 * 422+片段、HX-Trigger toast 这些协议细节收敛成三个 ctx 方法，
 * 页面 actions 不手写响应头。
 *
 * ```ts
 * .post('/apps', async ({ di, redirect, toast }) => {
 *   await di.get('deployService').deploy(...)
 *   toast('部署已开始', 'success')
 *   return redirect(routes.pages.canvas())
 * })
 * ```
 */
export interface ActionsOptions {
  /** 非 htmx 表单失败时整页回显用的全局壳（与 html() 的 layout 同一份） */
  layout?: LayoutComponent
}

type ToastKind = 'info' | 'success' | 'error'

const TRIGGER_HEADER = 'hx-trigger'

export function actions(options: ActionsOptions = {}) {
  return new Elysia({ name: 'elysiax-actions', seed: options }).derive(
    'global',
    ({ request, set }) => {
      const isHx = () => request.headers.has('HX-Request')

      return {
        /**
         * 成功后跳转：hx 请求 → 200 + HX-Redirect（htmx 对 302 只会在
         * 局部区域跳转，必须走响应头）；普通表单 → 303（PRG）。
         */
        redirect(url: string): Response {
          if (isHx())
            return new Response(null, {
              status: 200,
              headers: { 'hx-redirect': url }
            })
          return new Response(null, {
            status: 303,
            headers: { location: url }
          })
        },

        /**
         * 叠加 toast：多次调用合并进同一个 HX-Trigger 头，
         * 全局壳的 toast 脚本统一弹出。可与 redirect/片段返回值共存。
         */
        toast(message: string, kind: ToastKind = 'info'): void {
          const prev = set.headers[TRIGGER_HEADER]
          // 上游插件可能写过非 JSON 的 HX-Trigger（裸事件名等）：解析失败按无既有事件处理，不让 toast 把请求炸成 500
          let events: Record<string, unknown> = {}
          if (typeof prev === 'string') {
            try {
              const parsed: unknown = JSON.parse(prev)
              if (parsed && typeof parsed === 'object')
                events = parsed as Record<string, unknown>
            } catch { /* 非 JSON 头：覆盖为全新事件对象 */ }
          }
          const list = Array.isArray(events.toast) ? (events.toast as unknown[]) : []
          // 响应头只能是 latin1：中文消息 encodeURIComponent，壳脚本负责解码
          list.push({ message: encodeURIComponent(message), kind })
          events.toast = list
          set.headers[TRIGGER_HEADER] = JSON.stringify(events)
        },

        /**
         * 校验失败回显：hx → 422 + 表单片段（全局壳的 responseHandling
         * 配置允许 swap 422）；普通表单 → 422 + layout 整页回显
         * （仅当 actions() 传了 layout；未传时非 HX 路径也是裸片段 422）。
         * 禁止返回 200 + 空白（7.2）。
         */
        formError(fragment: unknown): Promise<Response> | Response {
          const value =
            !isHx() && options.layout
              ? options.layout({ content: fragment, request })
              : fragment
          const res = handleHtml(
            // JSX.Element 运行时即 string，类型无法表达，框架边界断言
            value as Parameters<typeof handleHtml>[0],
            {
              contentType: 'text/html; charset=utf8',
              autoDoctype: !isHx() && !!options.layout ? 'full' : false,
              isHtml: (v: string) =>
                v.length > 3 && v.startsWith('<') && v.endsWith('>')
            },
            false
          )
          const patch = (r: Response) =>
            new Response(r.body, { status: 422, headers: r.headers })
          return res instanceof Promise ? res.then(patch) : patch(res)
        }
      }
    }
  )
}
