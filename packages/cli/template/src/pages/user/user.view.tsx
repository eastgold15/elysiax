import type { Component } from "@workspace/htmx";
import type { User } from "./user.model";

/** 用户列表（整页与 POST 创建后的片段刷新共用）。
 *  纯展示组件：hx URL 由调用方经 props 注入，本文件不 import .elysiax——
 *  插座（user.socket.ts）re-export 本文件时，codegen 引导期（.elysiax 尚未生成）
 *  才不会因 import di → socket → ui → .elysiax 形成自举循环 */
export const UserList: Component<{
  users: User[];
  postUrl: string;
  ordersUrl: string;
}> = ({ users, postUrl, ordersUrl }) => (
  <div id="user-list" class="space-y-4">
    <h2 class="text-lg font-semibold">用户列表</h2>
    <ul class="divide-y divide-gray-700">
      {users.map((u) => (
        <li class="py-2">
          {u.id}. {u.name}
        </li>
      ))}
    </ul>
    <form hx-post={postUrl} hx-target="#user-list" hx-swap="outerHTML" class="flex gap-2">
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
      hx-get={ordersUrl}
      hx-target="#orders"
      hx-swap="innerHTML"
    >
      查看 Alice 的订单
    </button>
    <div id="orders" />
  </div>
);
