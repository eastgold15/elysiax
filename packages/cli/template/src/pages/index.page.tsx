import { definePage } from "@elysiax/core";
import { OrderPanel } from "./order/order.partials";
import { UserList } from "./user/user.partials";

/** 首页：直接组合两个页面的展示组件（整页服务端渲染，交互走各自 partials/actions） */
export default definePage(({ di }) => ({
  title: "elysiax demo",
  content: (
    <div class="space-y-6">
      <UserList users={di.get("userService").listUsers()} />
      <OrderPanel />
      <p class="text-sm text-gray-500">
        独立页面：<a class="text-sky-400 underline" href="/user">/user</a>
      </p>
    </div>
  ),
}));
