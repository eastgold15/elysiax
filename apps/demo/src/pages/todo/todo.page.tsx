import { definePage } from "@elysiax/core";
import { TodoList } from "./todo.partials";

export default definePage(({ di }) => ({
  title: "待办 · elysiax demo",
  content: <TodoList todos={di.get("todoService").listTodos()} />,
}));
