// 这个文件被 index.html / about.html 通过
//   <script type="module" src="./frontend.ts">
// 引用。Bun 打包 HTML 时,会把它一起编译成浏览器能跑的 JS。

console.log('[frontend] 已加载(由 Bun HTML import 打包)')

// 演示:监听 htmx 的 afterSwap 事件
document.addEventListener('htmx:afterSwap', (event) => {
  const detail = (event as CustomEvent).detail
  console.log('[frontend] htmx 完成替换,目标:', detail.target)
})
