import { Readable } from 'node:stream'
import type { HtmlOptions } from './options'
import { isHtml, isTagHtml } from './utils'

export function handleHtml(
  value: string | Readable | Promise<string | Readable>,
  options: HtmlOptions,
  hasContentType: boolean
): Promise<Response> | Response {
  // Only use promises if value is a promise itself
  if (value instanceof Promise)
    return value.then((v) => handleHtml(v, options, hasContentType))

  const headers = hasContentType
    ? undefined
    : { headers: { 'content-type': options.contentType! } }

  // Simple string use cases
  if (typeof value === 'string') {
    if (
      options.autoDoctype &&
      isHtml(value) &&
      // Avoids double adding !doctype or adding to non root html tags.
      isTagHtml(value)
    )
      value = '<!doctype html>' + value

    return new Response(value, headers)
  }

  // Stream use cases
  let stream = Readable.toWeb(value) as unknown as ReadableStream<
    string | Uint8Array
  >

  // We can convert to a readable stream with StreamTransform
  if (options.autoDoctype) {
    let first = true

    stream = stream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          let str = chunk!.toString()

          // Only ever inspect the very first chunk — checking later chunks
          // risks injecting a doctype mid-document. (The first chunk of a
          // stream doesn't end with '>', so isHtml() would never match;
          // isTagHtml() alone is the right test here.)
          if (first) {
            first = false

            if (isTagHtml(str)) str = '<!doctype html>' + str
          }

          controller.enqueue(str)
        }
      })
    )
  }

  return new Response(stream as any, headers)
}
