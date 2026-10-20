import { Elysia } from 'elysia'
import { Readable } from 'node:stream'
import { renderToStream } from '@kitajs/html/suspense'

import { handleHtml } from './handler'
import type { HtmlOptions } from './options'
import { isPageResult } from './page'
import { isHtml } from './utils'

export function html(options: HtmlOptions = {}) {
  // Normalized defaults — don't mutate the caller's object, it's also
  // used as the plugin seed for deduplication.
  const opts = {
    contentType: 'text/html; charset=utf8',
    autoDetect: true,
    autoDoctype: 'full' as NonNullable<HtmlOptions['autoDoctype']>,
    isHtml,
    ...options
  }

  // html()/stream() always honor autoDoctype; the autoDetect fallback only
  // adds a doctype for 'full' (see HtmlOptions docs).
  const explicit = { ...opts, autoDoctype: opts.autoDoctype !== false }
  const detected = { ...opts, autoDoctype: opts.autoDoctype === 'full' }

  const instance = new Elysia({
    name: 'htmx',
    seed: options
  })
    .derive(function htmlPlugin({ set }) {
      const hasContentType = 'content-type' in set.headers

      return {
        html(
          value: Readable | JSX.Element
        ): Promise<Response | string> | Response | string {
          return handleHtml(value, explicit, hasContentType)
        },
        stream<A = unknown>(
          value: (this: void, arg: A & { id: number }) => JSX.Element,
          args?: A
        ) {
          return handleHtml(
            renderToStream((id) => value({ ...args, id } as A & { id: number })),
            explicit,
            hasContentType
          )
        }
      }
    })
    .as('global')

  // 页面双响应（page-architecture.md 7.1）：PageResult → 无 HX-Request 走
  // AppLayout 渲染整页；有 HX-Request 只渲染 content 片段（不补 doctype）。
  // layout 经 options 注入，本包不 import core。
  if (opts.layout)
    instance
      .mapResponse(function handlerPageResult({ responseValue, request, set }) {
        if (!isPageResult(responseValue)) return

        const hasContentType = 'content-type' in set.headers
        if (request.headers.has('HX-Request'))
          return handleHtml(
            // JSX.Element 运行时即 string / kitajs 流，类型无法表达
            responseValue.content as Parameters<typeof handleHtml>[0],
            detected,
            hasContentType
          )

        return handleHtml(
          opts.layout!({
            title: responseValue.title,
            meta: responseValue.meta,
            content: responseValue.content,
            request
          }) as Parameters<typeof handleHtml>[0],
          explicit,
          hasContentType
        )
      })
      .as('global')

  if (opts.autoDetect)
    instance
      .mapResponse(function handlerPossibleHtml({ responseValue, set }) {
        // 简单 html 字符串,或 @kitajs/html 的流
        const value = responseValue as unknown
        if (
          !(
            opts.isHtml!(value as string) ||
            (value instanceof Readable && 'rid' in value)
          )
        )
          return

        return handleHtml(
          value as string | Readable,
          detected,
          'content-type' in set.headers
        )
      })
      .as('global')

  return instance
}
