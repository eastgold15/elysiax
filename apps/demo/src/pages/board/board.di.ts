import { defineModule, provide } from "@elysiax/core";
import { BoardRepository } from "./board.repository";
import { BoardService } from "./board.service";

// board 原子身份证：codegen 据此自动发现，无需手工注册（契约 §1.1）
export default defineModule({
  route: "/board",
  provides: {
    // 值服务 "db"（demo shared/db.ts 的 bun:sqlite 实例）→ 字符串键
    boardRepository: provide(BoardRepository, ["db"]),
    // 类服务 → 类引用，编译期校验
    boardService: provide(BoardService, [BoardRepository]),
  },
});
