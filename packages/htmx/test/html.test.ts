import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { html } from '../src/index'

describe('html plugin autoDetect', () => {
  const app = new Elysia()
    .use(html())
    .get('/page', () => '<html><body>hi</body></html>')
    .get('/fragment', () => '<div>frag</div>')
    .get('/json', () => ({ a: 1 }))

  test('裸返回 <html> 自动补 doctype（autoDoctype 默认 full）', async () => {
    const res = await app.handle(new Request('http://x/page'))
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toStartWith('<!doctype html><html>')
  })

  test('片段不补 doctype', async () => {
    const res = await app.handle(new Request('http://x/fragment'))
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toBe('<div>frag</div>')
  })

  test('非 html 不受影响', async () => {
    const res = await app.handle(new Request('http://x/json'))
    expect(await res.json()).toEqual({ a: 1 })
  })
})
