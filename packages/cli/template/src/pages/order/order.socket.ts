// order 原子的插座：对外承诺的全部契约（契约 §3）。
// 跨原子 import 的唯一合法形式：import { OrderService } from "../order/order.socket"
export { OrderService } from "./order.service";
// 展示组件也经插座登记：首页组合原子 UI 时同样只能 import 插座。
// 注意只能 re-export 不 import .elysiax 的纯展示组件（.ui.tsx），
// 否则 codegen 引导期（.elysiax 尚未生成）import di → socket → .elysiax 会自举循环
export { OrderPanel } from "./order.ui";
