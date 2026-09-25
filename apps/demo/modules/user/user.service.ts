import type { Lazy } from "@inferdi/inferdi";
import type { UserRepository } from "./user.repository";
import type { OrderService } from "../order/order.service";
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
    if (!input.name.trim()) throw new Error("name required");
    return this.userRepository.create(input);
  }

  getUserOrders(userId: number) {
    // 真正需要时才解析 OrderService 实例
    return this.orderServiceLazy.get().listByUser(userId);
  }
}
