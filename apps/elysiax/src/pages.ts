import home from './pages/index.html'
import about from './pages/about.html'

/**
 * 收集模块 —— 这就是"用 Bun 收集打包"的位置:
 *
 * 每个 `import ... from './pages/*.html'` 在 Bun 编译/启动时,
 * 会把该 .html 连同它引用的 css / ts 一起打包成
 * 一个带 `text/html` 头的 Response(类型为 HTMLBundle)。
 *
 * Elysia 只需要 return 这里导出的对象,不用自己读文件、
 * 不用管 content-type、也不用配静态服务器。
 */
export const pages = {
  home,
  about,
}

export type Pages = typeof pages
