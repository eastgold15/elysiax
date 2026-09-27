import type { Component } from "@workspace/htmx";

const OrderUi: Component = () => (
  <div class="rounded-lg border border-gray-700 p-4">
    <h3 class="font-medium">订单详情</h3>
    <p class="text-sm text-gray-400">订单信息将在此处显示</p>
    <button
      class="mt-2 inline-flex items-center justify-center rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 transition-colors"
      hx-get="/api/orders/1/user-name"
      hx-target="#uname"
      hx-swap="innerHTML"
    >
      查下单人
    </button>
    <span id="uname" class="ml-2 text-sky-400"></span>
  </div>
);

export default OrderUi;
