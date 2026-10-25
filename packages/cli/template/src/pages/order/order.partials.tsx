import { defineRoutes } from "@gen";

/** GET 片段子路由：挂在 /api/order 前缀下 */
export default defineRoutes()
  // 跨限界上下文的组合（订单 → 用户名字）放在应用层，service 保持单向依赖
  .get("/:id/user-name", ({ di, params }) => {
    const id = Number(params.id);
    const user = di.get("userService").listUsers().find((u) => u.id === id);
    return user?.name ?? "Unknown";
  });
