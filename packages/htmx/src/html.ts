import { Elysia } from 'elysia'
import { Readable } from 'node:stream'
import { renderToStream } from '@kitajs/html/suspense'

import { handleHtml } from './handler'
import type { HtmlOptions } from './options'
import { isHtml } from './utils'

export function html(options: HtmlOptions = {}) {
  // Defaults
  options.contentType ??= 'text/html; charset=utf8'
  options.autoDetect ??= true
  options.isHtml ??= isHtml
  options.autoDoctype ??= true

  const instance = new Elysia({
    name: 'htmx',
    seed: options
  })
    .derive(function htmlPlugin({ set }) {
      return {
        html(
          value: Readable | JSX.Element
        ): Promise<Response | string> | Response | string {
          return handleHtml(value, options, 'content-type' in set.headers)
        },
        stream<A = any>(
          value: (this: void, arg: A & { id: number }) => JSX.Element,
          args: A
        ) {
          return handleHtml(
            renderToStream((id) =>
              (value as Function)({ ...args, id })
            ),
            options,
            'content-type' in set.headers
          )
        }
      }
    })
    .as('global')

  if (options.autoDetect)
    instance.mapResponse(
      function handlerPossibleHtml({ responseValue: value, set }) {
        // 简单 html 字符串,或 @kitajs/html 的流
        if (
          !(
            isHtml(value) ||
            (value instanceof Readable && 'rid' in value)
          )
        )
          return

        return handleHtml(value, options, 'content-type' in set.headers)
      }
    ).as('global')
  return instance
}