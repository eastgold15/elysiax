import { definePage } from "@elysiax/core";
import { UserList } from "./user.partials";

export default definePage(({ di }) => ({
  title: "用户 · elysiax demo",
  content: <UserList users={di.get("userService").listUsers()} />,
}));
