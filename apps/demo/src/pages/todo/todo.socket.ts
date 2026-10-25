// todo 原子的插座：对外承诺的全部契约（契约 §3）。
// 跨原子 import 唯一合法形式：import { ... } from "../todo/todo.socket"
export { todosTable } from "./schema"; // 表锚点
export type { Todo, TodoRow, CreateTodoInput } from "./schema"; // 行/领域类型
export { TodoService } from "./todo.service"; // 服务类（供外原子 di 注入）
