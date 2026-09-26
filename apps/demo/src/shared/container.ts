import { Container } from "@inferdi/inferdi";
import { db } from "./db";
import { UserRepository } from "../../modules/user/user.repository";
import { UserService } from "../../modules/user/user.service";
import { OrderRepository } from "../../modules/order/order.repository";
import { OrderService } from "../../modules/order/order.service";

// 限界上下文：order 不依赖 user；user 通过 Lazy 伴随键单向查询订单。
// 单向依赖可以在一条链式调用中线性注册，全程类型安全（无 any）。
export function buildRootContainer() {
  return new Container()
    // 基础设施
    .registerValue("db", db)
    .registerClass("userRepository", UserRepository, ["db"], "singleton")
    .registerClass("orderRepository", OrderRepository, ["db"], "singleton")
    // order 模块先注册，生成 'orderServiceLazy' 伴随键
    .registerClass(
      "orderService",
      OrderService,
      ["orderRepository"],
      "singleton",
      "orderServiceLazy",
    )
    // user 模块单向依赖 Lazy<OrderService>
    .registerClass(
      "userService",
      UserService,
      ["userRepository", "orderServiceLazy"],
      "singleton",
    );
}

export type RootContainer = ReturnType<typeof buildRootContainer>;
