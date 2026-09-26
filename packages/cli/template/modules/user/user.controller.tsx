import { Elysia, t } from "elysia";
import UserUi from "./user.ui";

export const userController = new Elysia({ prefix: "/users" })
  .get("/", ({ di }: any) => di.get("userService").listUsers())
  // 直接返回 JSX 即 text/html（elysiaxAPI 内的 html() autoDetect），可注入数据
  .get("/ui", ({ di }: any) => (
    <UserUi users={di.get("userService").listUsers()} />
  ))
  .post(
    "/",
    { body: t.Object({ name: t.String() }) }, // Elysia 2: (path, hook, handler)
    ({ di, body }: any) => di.get("userService").addUser(body),
  )
  .get("/:id/orders", ({ di, params }: any) =>
    di.get("userService").getUserOrders(Number(params.id)),
  );
