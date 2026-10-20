import { defineModule, provide } from "@elysiax/core";
import { OrderRepository } from "./order.repository";
import { OrderService } from "./order.service";

// order 限界上下文：只提供订单相关服务，不依赖其他模块
export default defineModule({
  route: "/orders",
  provides: {
    orderRepository: provide(OrderRepository, ["db"]),
    orderService: provide(OrderService, [OrderRepository]),
  },
});
