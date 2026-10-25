import { defineRoutes } from "@gen";

/** GET 片段子路由：挂在 /api/user 前缀下（页面 URL = 文件夹路径） */
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
