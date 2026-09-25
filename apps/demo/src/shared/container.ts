import { Container } from "@inferdi/inferdi";
import { db } from "./db";
import { UserRepository } from "../../modules/user/user.repository";
import { UserService } from "../../modules/user/user.service";
import { OrderRepository } from "../../modules/order/order.repository";
import { OrderService } from "../../modules/order/order.service";

export function buildRootContainer() {
  return new Container()
    // 基础设施
    .registerValue("db", db)
    // user 模块：单例，同时生成 Lazy 伴随键
    .registerClass("userRepository", UserRepository, ["db"], "singleton")
    .registerClass(
      "userService",
      UserService,
      ["userRepository", "orderServiceLazy"], // ← 依赖 Lazy<OrderService>
      "singleton",
      "userServiceLazy", // ← 生成 'userServiceLazy' 伴随键
    )
    // order 模块：单例
    .registerClass("orderRepository", OrderRepository, ["db"], "singleton")
    .registerClass(
      "orderService",
      OrderService,
      ["orderRepository", "userServiceLazy"], // ← 依赖 Lazy<UserService>
      "singleton",
      "orderServiceLazy", // ← 生成 'orderServiceLazy' 伴随键
    );
}

export type RootContainer = ReturnType<typeof buildRootContainer>;
