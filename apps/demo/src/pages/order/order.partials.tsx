import type { Component } from "@elysiax/htmx";
import { defineRoutes, routes } from "../../../.elysiax";

/** 订单面板（整页直接渲染用；交互片段走下面 GET 子路由） */
export const OrderPanel: Component = () => (
  <div class="rounded-lg border border-gray-700 p-4">
    <h3 class="font-medium">订单详情</h3>
    <p class="text-sm text-gray-400">跨上下文组合：订单 → 用户名字</p>
    <button
      class="mt-2 rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500"
      hx-get={routes.pages.order.ByIdUserName(1)}
      hx-target="#uname"
      hx-swap="innerHTML"
    >
      查下单人
    </button>
    <span id="uname" class="ml-2 text-sky-400" />
  </div>
);

/** GET 片段子路由：挂在 /api/order 前缀下 */
export default defineRoutes()
  // 跨限界上下文的组合（订单 → 用户名字）放在应用层，service 保持单向依赖
  .get("/:id/user-name", ({ di, params }) => {
    const id = Number(params.id);
    const user = di.get("userService").listUsers().find((u) => u.id === id);
    return user?.name ?? "Unknown";
  });
