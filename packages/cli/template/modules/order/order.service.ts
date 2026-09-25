import type { Lazy } from "@inferdi/inferdi";
import type { OrderRepository } from "./order.repository";
import type { UserService } from "../user/user.service";

export class OrderService {
  constructor(
    private orderRepository: OrderRepository,
    private userServiceLazy: Lazy<UserService>, // ← 延迟解析
  ) {}

  listByUser(userId: number) {
    return this.orderRepository.findByUser(userId);
  }

  getUserName(userId: number) {
    const user = this.userServiceLazy
      .get()
      .listUsers()
      .find((u) => u.id === userId);
    return user?.name ?? "Unknown";
  }
}
