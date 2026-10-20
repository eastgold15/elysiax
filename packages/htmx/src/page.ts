/**
 * 页面原语：PageResult 品牌 + AppLayout 签名。
 * core 的 definePage 给页面返回值打品牌；html() 插件的 mapResponse
 * 识别品牌后按 HX-Request 头分流（整页 / 片段），判定收敛在框架层，
 * 页面函数零 if/else（见 docs/page-architecture.md 7.1）。
 */

// Symbol.for 返回 symbol 而非 unique symbol，注解断言是官方唯一途径
// （unique symbol 只允许在带显式注解的 const 声明上）
export const pageBrand: unique symbol = Symbol.for(
  'elysiax.page',
) as typeof pageBrand

/** definePage 处理器的返回值：裸 JSX 会被 definePage 包装成 { content } */
export interface PageResult {
  readonly [pageBrand]: true
  title?: string
  meta?: Record<string, string>
  // JSX.Element（string / Promise / kitajs 流），框架只透传不消费，
  // 无法用单一静态类型表达，故为 unknown
  content: unknown
}

/** 读取品牌字段的窄化辅助：unknown → 带品牌键的记录 */
const brandOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Record<symbol, unknown>)[pageBrand]
    : undefined

export const isPageResult = (value: unknown): value is PageResult =>
  brandOf(value) === true

/** 给页面返回值打品牌（core.definePage 内部用） */
export function brandPageResult(value: unknown): PageResult {
  if (isPageResult(value)) return value
  if (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof String) &&
    'content' in value
  ) {
    return { [pageBrand]: true, ...value } as PageResult
  }
  // 裸 JSX：string / Promise / kitajs 流，一律视为 content
  return { [pageBrand]: true, content: value }
}

/**
 * 全局壳（AppLayout）签名：负责 <html><head>、导航、toast 容器。
 * 准入：纯视觉边框，不查业务数据、不感知 URL 属于哪个页面。
 */
export type LayoutComponent = (props: {
  title?: string
  meta?: Record<string, string>
  // any 而非 unknown：壳要把 content 直接嵌进 JSX  children（unknown 不可赋值）
  content: any
  request: Request
}) => unknown
