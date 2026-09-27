import { t } from "elysia";
import { defineController } from "../../../.elysiax";
import UserUi from "./user.ui";

export const userController = defineController({ prefix: "/users" })
  .get("/", ({ di }) => di.get("userService").listUsers())
  // 直接返回 JSX 即 text/html（elysiaxAPI 内的 html() autoDetect），可注入数据
  .get("/ui", ({ di }) => <UserUi users={di.get("userService").listUsers()} />)
  .post(
    "/",
    { body: t.Object({ name: t.String() }) }, // Elysia 2: (path, hook, handler)
    ({ di, body }) => di.get("userService").addUser(body),
  )
  .get("/:id/orders", ({ di, params }) =>
    di.get("userService").getUserOrders(Number(params.id)),
  );
