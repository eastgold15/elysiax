import { t } from "elysia";
import { defineController } from "../../../.elysiax";
import OrderUi from "./order.ui";

export const orderController = defineController({ prefix: "/orders" })
  .get("/ui", () => <OrderUi />)
  // 跨限界上下文的组合（订单 → 用户名字）放在应用层，service 保持单向依赖
  .get("/:id/user-name", {
    query: t.Object({
      id: t.Number()
    })
  }, ({ di, query: { id } }) => {
    const user = di
      .get("userService")
      .listUsers()
      .find((u) => u.id === id);
    return user?.name ?? "Unknown";
  });
