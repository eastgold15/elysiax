import { Elysia, t } from "elysia";
// with { type: "text" }：按纯文本导入 HTML 片段（Bun 默认会把 .html 当全栈页面对象）
import ui from "./user.ui.html" with { type: "text" };

export const userController = new Elysia({ prefix: "/users" })
  .get("/", ({ di }: any) => di.get("userService").listUsers())
  .get("/ui", () => ui) // 返回 UI 片段给 htmx
  .post(
    "/",
    { body: t.Object({ name: t.String() }) }, // Elysia 2: (path, hook, handler)
    ({ di, body }: any) => di.get("userService").addUser(body),
  )
  .get("/:id/orders", ({ di, params }: any) =>
    di.get("userService").getUserOrders(Number(params.id)),
  );
