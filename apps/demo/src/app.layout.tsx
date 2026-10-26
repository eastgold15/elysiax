import { defineLayout } from "@elysiax/core";
import { ToastRoot, ToastScripts } from "@elysiax/htmx";

/** 全局壳（L0 唯一 AppLayout）：<html><head>、导航、toast 容器；纯视觉边框不查业务数据 */
export default defineLayout(({ title, content }) => (
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title ?? "elysiax demo"}</title>
      <link rel="stylesheet" href="/api/assets/global.css" />
      <script
        src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.11/dist/htmx.min.js"
        integrity="sha384-2OatzQy1H+Zd/IIrjr1TcuDGqLXeHhbooAyJY1KdQMKnr4LZ22k31GBLdYKHmVjg"
        crossorigin="anonymous"
      />
    </head>
    <body class="mx-auto max-w-2xl p-8">
      <h1 class="mb-6 text-2xl font-bold">
        <a href="/">模块化全栈应用</a>
      </h1>
      <main id="main">{content}</main>
      <ToastRoot />
      <ToastScripts />
    </body>
  </html>
));
