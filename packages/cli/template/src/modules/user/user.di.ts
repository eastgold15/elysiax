import { defineModule, lazy, provide } from "@elysiax/core";
import { OrderService } from "../order/order.service";
import { UserRepository } from "./user.repository";
import { UserService } from "./user.service";

// user 上下文单向依赖 order：lazy(OrderService) → 自动生成 orderServiceLazy 伴随键
export default defineModule({
  route: "/users",
  provides: {
    userRepository: provide(UserRepository, ["db"]),
    userService: provide(UserService, [UserRepository, lazy(OrderService)]),
  },
});
