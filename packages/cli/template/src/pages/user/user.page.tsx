import { definePage } from "@elysiax/core";
import { routes } from "@gen";
import { UserList } from "./user.view";

export default definePage(({ di }) => ({
  title: "用户 · elysiax demo",
  // hx URL 在应用层（page/actions）用类型化路径助手计算，再注入纯展示组件
  content: (
    <UserList
      users={di.get("userService").listUsers()}
      postUrl={routes.pages.user.index()}
      ordersUrl={routes.pages.user.ByIdOrders(1)}
    />
  ),
}));
