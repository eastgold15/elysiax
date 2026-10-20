import type { OrderRepository } from "./order.repository";

// order 限界上下文：只关心订单，不认识 user 上下文的概念。
// “订单属于哪个用户 / 用户叫什么” 这类跨上下文组合由 controller（应用层）完成。
export class OrderService {
  constructor(private orderRepository: OrderRepository) {}

  listByUser(userId: number) {
    return this.orderRepository.findByUser(userId);
  }
}
