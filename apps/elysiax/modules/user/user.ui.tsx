import type { Component } from "@workspace/htmx";
import type { User } from "./user.model";

const UserUi: Component<{ users: User[] }> = ({ users }) => (
  <div class="space-y-4">
    <h2 class="text-lg font-semibold">用户列表</h2>
    <ul class="divide-y divide-gray-700">
      {users.map((u) => (
        <li class="py-2">{u.name}</li>
      ))}
    </ul>
    <button
      class="inline-flex items-center justify-center rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 transition-colors"
      hx-get="/api/users/1/orders"
      hx-target="#orders"
      hx-swap="innerHTML"
    >
      查看 Alice 的订单
    </button>
    <div id="orders"></div>
  </div>
);

export default UserUi;
