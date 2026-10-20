import { defineLayout } from "@elysiax/core";
import { ToastRoot, ToastScripts } from "@workspace/htmx";

/**
 * 全局壳（L0 唯一 AppLayout）：全站外框 = <html><head>、侧边导航、toast。
 * 准入纪律：纯视觉边框，不查业务数据、不感知 URL 属于哪个页面。
 * 样式走 /api/assets/global.css（codegen 编译 tailwind 后内联产物）。
 */
export default defineLayout(({ title, content }) => (
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title ? `${title} · Dockyard` : "Dockyard"}</title>
      <link rel="stylesheet" href="/api/assets/global.css" />
      <script
        src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.11/dist/htmx.min.js"
        integrity="sha384-2OatzQy1H+Zd/IIrjr1TcuDGqLXeHhbooAyJY1KdQMKnr4LZ22k31GBLdYKHmVjg"
        crossorigin="anonymous"
      />
      <script
        src="https://cdn.jsdelivr.net/npm/idiomorph@0.7.4/dist/idiomorph-ext.min.js"
        integrity="sha384-SsScJKzATF/w6suEEdLbgYGsYFLzeKfOA6PY+/C5ZPxOSuA+ARquqtz/BZz9JWU8"
        crossorigin="anonymous"
      />
    </head>
    <body class="flex h-screen overflow-hidden">
      <aside class="flex w-52 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900">
        <div class="flex h-14 items-center gap-2 border-b border-neutral-800 px-4 font-semibold tracking-wide">
          ⚓ Dockyard
        </div>
        <nav class="flex flex-col gap-0.5 p-2">
          <a class="rounded px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100" href="/projects">项目</a>
          <a class="rounded px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100" href="/canvas">画布</a>
          <a class="rounded px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100" href="/servers">服务器</a>
        </nav>
      </aside>
      <main id="main" class="flex min-w-0 flex-1 flex-col overflow-hidden">
        {content}
      </main>
      <div id="modal-root" />
      <ToastRoot />
      <ToastScripts />
    </body>
  </html>
));
