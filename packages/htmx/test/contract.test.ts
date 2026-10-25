import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import {
  actions,
  brandPageResult,
  html,
  isPageResult,
  type LayoutComponent
} from '../src/index'

/**
 * 契约形态 A（module-contract.md §1.3）的框架侧行为：
 * definePage 整页双响应、actions 三态助手（redirect/toast/formError）。
 * definePage 本体在 @elysiax/core，本包只负责 PageResult 品牌与分流，
 * 测试用 brandPageResult 模拟 core 打品牌后的页面返回值。
 */

// 测试用全局壳：带 title 的整页骨架
const layout: LayoutComponent = ({ title, content }) =>
  `<html><head><title>${title ?? ''}</title></head><body>${content}</body></html>`

const HX = { headers: { 'HX-Request': 'true' } }

describe('PageResult 品牌（page.ts）', () => {
  test('裸 JSX 视为 content', () => {
    const r = brandPageResult('<div>x</div>')
    expect(isPageResult(r)).toBe(true)
    expect(r.content).toBe('<div>x</div>')
    expect(r.title).toBeUndefined()
  })

  test('带 content 的对象保留 title/meta', () => {
    const r = brandPageResult({ title: 'T', content: '<p>y</p>' })
    expect(r.title).toBe('T')
    expect(r.content).toBe('<p>y</p>')
  })

  test('已品牌的值原样透传', () => {
    const a = brandPageResult('<i>z</i>')
    expect(brandPageResult(a)).toBe(a)
  })

  test('非品牌值识别为 false', () => {
    expect(isPageResult('<div>x</div>')).toBe(false)
    expect(isPageResult({ content: 1 })).toBe(false)
    expect(isPageResult(null)).toBe(false)
  })
})

describe('definePage 整页双响应（html() + layout）', () => {
  const app = new Elysia()
    .use(html({ layout }))
    .get('/page', () =>
      brandPageResult({ title: '项目', content: '<div>list</div>' })
    )

  test('普通请求 → layout 整页 + doctype + title', async () => {
    const res = await app.handle(new Request('http://x/page'))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toStartWith('<!doctype html><html>')
    expect(body).toContain('<title>项目</title>')
    expect(body).toContain('<div>list</div>')
  })

  test('HX 请求 → 仅 content 片段：无 doctype、无 layout、无 title', async () => {
    const res = await app.handle(new Request('http://x/page', HX))
    expect(await res.text()).toBe('<div>list</div>')
  })
})

describe('actions() 三态助手', () => {
  describe('redirect：303 PRG vs HX-Redirect', () => {
    const app = new Elysia()
      .use(actions())
      .post('/save', ({ redirect }) => redirect('/done'))

    test('普通表单 → 303 + location', async () => {
      const res = await app.handle(
        new Request('http://x/save', { method: 'POST' })
      )
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/done')
    })

    test('HX 请求 → 200 + hx-redirect（htmx 对 302 只局部跳转，必须走响应头）', async () => {
      const res = await app.handle(
        new Request('http://x/save', { method: 'POST', ...HX })
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('hx-redirect')).toBe('/done')
    })
  })

  describe('toast：多次调用合并进同一 HX-Trigger 头', () => {
    const app = new Elysia()
      .use(actions())
      .get('/t', ({ toast, set }) => {
        toast('第一步完成')
        toast('创建成功', 'success')
        set.headers['x-ok'] = '1'
        return 'ok'
      })

    test('两条 toast 合并为数组；中文经 encodeURIComponent 进头（latin1 限制）', async () => {
      const res = await app.handle(new Request('http://x/t'))
      const raw = res.headers.get('hx-trigger')
      expect(raw).toBeString()
      const events = JSON.parse(raw!) as {
        toast: { message: string; kind: string }[]
      }
      expect(events.toast).toHaveLength(2)
      expect(events.toast[0]).toEqual({
        message: encodeURIComponent('第一步完成'),
        kind: 'info'
      })
      expect(events.toast[1]!.kind).toBe('success')
      // 壳脚本 decodeURIComponent 后应还原原文
      expect(decodeURIComponent(events.toast[1]!.message)).toBe('创建成功')
    })
  })

  describe('toast 可与 redirect 共存（响应头合并）', () => {
    const app = new Elysia()
      .use(actions())
      .post('/both', ({ toast, redirect }) => {
        toast('已保存', 'success')
        return redirect('/list')
      })

    test('HX：200 + hx-redirect + hx-trigger 同时存在', async () => {
      const res = await app.handle(
        new Request('http://x/both', { method: 'POST', ...HX })
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('hx-redirect')).toBe('/list')
      expect(res.headers.get('hx-trigger')).toContain('toast')
    })
  })

  describe('formError：校验失败 422 回显', () => {
    const app = new Elysia()
      .use(actions({ layout }))
      .post('/f', ({ formError }) => formError('<form>错误片段</form>'))

    test('HX → 422 + 片段（壳的 responseHandling 允许 swap 422），无 doctype', async () => {
      const res = await app.handle(
        new Request('http://x/f', { method: 'POST', ...HX })
      )
      expect(res.status).toBe(422)
      expect(await res.text()).toBe('<form>错误片段</form>')
    })

    test('普通表单 → 422 + layout 整页回显（带 doctype）', async () => {
      const res = await app.handle(new Request('http://x/f', { method: 'POST' }))
      expect(res.status).toBe(422)
      const body = await res.text()
      expect(body).toStartWith('<!doctype html><html>')
      expect(body).toContain('<form>错误片段</form>')
    })
  })
})
