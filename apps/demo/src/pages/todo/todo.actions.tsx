import { t } from "elysia";
import { defineRoutes } from "../../../.elysiax";
import { TodoList } from "./todo.partials";

/** 写端点：挂在 /api/todo 前缀下；零 try/catch——校验失败框架 422 回显，
 *  业务错误由 service 抛 ServiceError，框架统一映射为横幅片段 */
export default defineRoutes()
  .post(
    "/",
    { body: t.Object({ title: t.String({ minLength: 1 }) }) },
    ({ di, body, toast }) => {
      di.get("todoService").addTodo(body);
      toast(`待办「${body.title}」已添加`);
      return <TodoList todos={di.get("todoService").listTodos()} />;
    },
  )
  .post("/:id/toggle", ({ di, params }) => {
    di.get("todoService").toggleTodo(Number(params.id));
    return <TodoList todos={di.get("todoService").listTodos()} />;
  })
  .delete("/:id", ({ di, params, toast }) => {
    di.get("todoService").removeTodo(Number(params.id));
    toast("待办已删除");
    return <TodoList todos={di.get("todoService").listTodos()} />;
  });
