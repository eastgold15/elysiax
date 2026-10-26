import { defineRoutes } from "../../../.elysiax";
import type { Component } from "@elysiax/htmx";
import { routes } from "../../../.elysiax";
import type { User } from "./user.model";

/** 用户列表（整页与 POST 创建后的片段刷新共用） */
export const UserList: Component<{ users: User[] }> = ({ users }) => (
  <div id="user-list" class="space-y-4">
    <h2 class="text-lg font-semibold">用户列表</h2>
    <ul class="divide-y divide-gray-700">
      {users.map((u) => (
        <li class="py-2">
          {u.id}. {u.name}
        </li>
      ))}
    </ul>
    <form
      hx-post={routes.pages.user.index()}
      hx-target="#user-list"
      hx-swap="outerHTML"
      class="flex gap-2"
    >
      <input
        name="name"
        required
        placeholder="新用户名"
        class="rounded-md border border-gray-700 bg-transparent px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        class="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
      >
        添加
      </button>
    </form>
    <button
      class="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
      hx-get={routes.pages.user.ByIdOrders(1)}
      hx-target="#orders"
      hx-swap="innerHTML"
    >
      查看 Alice 的订单
    </button>
    <div id="orders" />
  </div>
);

/** GET 片段子路由：挂在 /api/user 前缀下（页面 URL 推导） */
export default defineRoutes()
  // 跨限界上下文的组合（用户 → 订单列表）由 service 的 lazy 依赖完成
  .get("/:id/orders", ({ di, params }) => {
    const orders = di.get("userService").getUserOrders(Number(params.id));
    return (
      <ul class="list-disc pl-5 text-sm text-gray-300">
        {orders.map((o) => (
          <li>订单 #{o.id}（用户 {o.userId}）</li>
        ))}
      </ul>
    );
  });
