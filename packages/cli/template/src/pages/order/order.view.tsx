import type { Component } from "@elysiax/htmx";

/** 订单面板（整页直接渲染用；交互片段走 order.partials 的 GET 子路由）。
 *  纯展示组件：hx URL 由调用方经 props 注入，本文件不 import .elysiax——
 *  插座（order.socket.ts）re-export 本文件时才不会在 codegen 引导期自举循环 */
export const OrderPanel: Component<{ userNameUrl: string }> = ({ userNameUrl }) => (
  <div class="rounded-lg border border-gray-700 p-4">
    <h3 class="font-medium">订单详情</h3>
    <p class="text-sm text-gray-400">跨上下文组合：订单 → 用户名字</p>
    <button
      class="mt-2 rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500"
      hx-get={userNameUrl}
      hx-target="#uname"
      hx-swap="innerHTML"
    >
      查下单人
    </button>
    <span id="uname" class="ml-2 text-sky-400" />
  </div>
);
