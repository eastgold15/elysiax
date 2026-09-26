import { Container } from "@inferdi/inferdi";
import { db } from "./db";
import { UserRepository } from "../../modules/user/user.repository";
import { UserService } from "../../modules/user/user.service";
import { OrderRepository } from "../../modules/order/order.repository";
import { OrderService } from "../../modules/order/order.service";

export function buildRootContainer() {
  const base = new Container()
    // 基础设施
    .registerValue("db", db)
    .registerClass("userRepository", UserRepository, ["db"], "singleton")
    .registerClass("orderRepository", OrderRepository, ["db"], "singleton");

  // userService ⇄ orderService 互相通过 Lazy 伴随键延迟解析。
  // InferDI 6.1 的类型是线性 builder：依赖键必须在注册时已存在于容器类型中，
  // 一条链式调用无法前向引用对方尚未注册的 *Lazy 键（运行时完全支持）。
  // 因此这里用 any 桥接，仅牺牲这两个注册的编译期键检查。
  const c = base as any;
  return c
    // user 模块：单例，同时生成 Lazy 伴随键
    .registerClass(
      "userService",
      UserService,
      ["userRepository", "orderServiceLazy"], // ← 依赖 Lazy<OrderService>
      "singleton",
      "userServiceLazy", // ← 生成 'userServiceLazy' 伴随键
    )
    // order 模块：单例
    .registerClass(
      "orderService",
      OrderService,
      ["orderRepository", "userServiceLazy"], // ← 依赖 Lazy<UserService>
      "singleton",
      "orderServiceLazy", // ← 生成 'orderServiceLazy' 伴随键
    ) as Container<any>;
}

export type RootContainer = ReturnType<typeof buildRootContainer>;
