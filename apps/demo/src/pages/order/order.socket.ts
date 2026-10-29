// order 原子的插座：对外承诺的全部契约（契约 §3）。
export type { Order } from "./order.model";
export { OrderService } from "./order.service";
// 页面组合需要的视图件也必须经插座对外（跨原子只认插座）
export { OrderPanel } from "./order.partials";
