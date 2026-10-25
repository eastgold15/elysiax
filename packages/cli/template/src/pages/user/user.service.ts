import { ServiceError } from "@elysiax/core";
import type { Lazy } from "@inferdi/inferdi";
import type { UserRepository } from "./user.repository";
// 跨原子 import 只走插座（契约 §3）
import type { OrderService } from "../order/order.socket";
import type { CreateUserInput } from "./user.model";

export class UserService {
  constructor(
    private userRepository: UserRepository,
    private orderServiceLazy: Lazy<OrderService>, // ← 延迟解析，打破循环
  ) {}

  listUsers() {
    return this.userRepository.findAll();
  }

  addUser(input: CreateUserInput) {
    // 业务错误抛 ServiceError：框架统一映射（hx → 横幅片段，普通 → JSON），actions 不写 try/catch
    if (!input.name.trim()) throw new ServiceError("用户名不能为空", 422);
    return this.userRepository.create(input);
  }

  getUserOrders(userId: number) {
    // 真正需要时才解析 OrderService 实例
    return this.orderServiceLazy.get().listByUser(userId);
  }
}
