// user 原子的插座：对外承诺的全部契约（契约 §3）。
export type { User, CreateUserInput } from "./user.model";
export { UserService } from "./user.service";
// 表名锚点：跨原子的外键要引它，而不是抄字面量（抄了表名一改就断）
export { usersTable } from "./schema";
// 页面组合需要的视图件也必须经插座对外（跨原子只认插座）
export { UserList } from "./user.partials";
