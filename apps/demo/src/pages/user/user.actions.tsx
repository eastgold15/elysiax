import { t } from "elysia";
import { defineRoutes } from "../../../.elysiax";
import { UserList } from "./user.partials";

/** 写端点：挂在 /api/user 前缀下；校验失败由框架 422 回显（不写 try/catch） */
export default defineRoutes().post(
  "/",
  { body: t.Object({ name: t.String({ minLength: 1 }) }) },
  ({ di, body, toast }) => {
    di.get("userService").addUser(body);
    toast(`用户「${body.name}」已添加`);
    return <UserList users={di.get("userService").listUsers()} />;
  },
);
