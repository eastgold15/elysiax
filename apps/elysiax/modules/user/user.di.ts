import { defineModule } from "@elysiax/core";
import { UserRepository } from "./user.repository";
import { UserService } from "./user.service";

// user 上下文单向依赖 order（'orderServiceLazy' 约定后缀 → 自动生成 Lazy 伴随键）
export default defineModule({
  provides: {
    userRepository: { class: UserRepository, deps: ["db"] },
    userService: {
      class: UserService,
      deps: ["userRepository", "orderServiceLazy"],
    },
  },
});
