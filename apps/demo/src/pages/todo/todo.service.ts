import { ServiceError } from "@elysiax/core";
import type { TodoRepository } from "./todo.repository";
import type { CreateTodoInput } from "./schema";

export class TodoService {
  constructor(private todoRepository: TodoRepository) {}

  listTodos() {
    return this.todoRepository.findAll();
  }

  addTodo(input: CreateTodoInput) {
    // 业务错误抛 ServiceError：框架统一映射（hx → 横幅片段，普通 → JSON），actions 不写 try/catch
    if (!input.title.trim()) throw new ServiceError("标题不能为空", 422);
    return this.todoRepository.create({ title: input.title.trim() });
  }

  toggleTodo(id: number) {
    const todo = this.todoRepository.toggle(id);
    if (!todo) throw new ServiceError(`待办 #${id} 不存在`, 404);
    return todo;
  }

  removeTodo(id: number) {
    if (!this.todoRepository.remove(id)) {
      throw new ServiceError(`待办 #${id} 不存在`, 404);
    }
  }
}
