// board 原子的插座：对外承诺的全部契约（契约 §3）。
// 只含 named/type export，无 default、无运行时逻辑；跨原子 import 唯一合法入口。
export { BoardService } from "./board.service";
export type { Card, Column } from "./board.repository";

// client 形态追加：Eden Treaty 的 API 类型出口（同原子 client 引用）
import type boardApi from "./board.actions";
export type BoardApi = typeof boardApi;
