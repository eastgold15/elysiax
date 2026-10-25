import { definePage } from "@elysiax/core";
import { routes } from "@gen";
// 跨原子 import 只走插座（契约 §3），穿透 import partials 会被 doctor 插座门禁拦下
import { OrderPanel } from "@/pages/order/order.socket";
import { UserList } from "@/pages/user/user.socket";

/** 首页：经插座组合两个原子的展示组件；hx URL 在这里用类型化路径助手算好注入 */
export default definePage(({ di }) => ({
  title: "elysiax demo",
  content: (
    <div class="space-y-6">
      <UserList
        users={di.get("userService").listUsers()}
        postUrl={routes.pages.user.index()}
        ordersUrl={routes.pages.user.ByIdOrders(1)}
      />
      <OrderPanel userNameUrl={routes.pages.order.ByIdUserName(1)} />
      <p class="text-sm text-gray-500">
        独立页面：<a class="text-sky-400 underline" href="/user">/user</a>
      </p>
    </div>
  ),
}));
