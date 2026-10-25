import { defineModule, provide } from "@elysiax/core";
import { TodoRepository } from "./todo.repository";
import { TodoService } from "./todo.service";

// todo 限界上下文：自含数据层与服务层，不依赖其他业务模块；db 复用 infra 的值服务
export default defineModule({
  route: "/todos",
  provides: {
    todoRepository: provide(TodoRepository, ["db"]),
    todoService: provide(TodoService, [TodoRepository]),
  },
});
