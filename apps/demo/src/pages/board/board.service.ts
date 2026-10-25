import { ServiceError } from "@elysiax/core";
import type { BoardRepository, Card, Column } from "./board.repository";

export class BoardService {
  constructor(private boardRepository: BoardRepository) {}

  list(): Card[] {
    return this.boardRepository.findAll();
  }

  add(title: string): Card {
    // 业务错误抛 ServiceError：框架统一映射为 JSON，actions 不写 try/catch（契约 §4）
    const trimmed = title.trim();
    if (!trimmed) throw new ServiceError("标题不能为空", 422);
    return this.boardRepository.create(trimmed);
  }

  /** 移动换列；卡片不存在返回 null，由 action return status(404) */
  move(id: number, column: Column): Card | null {
    return this.boardRepository.move(id, column);
  }

  /** 删除；卡片不存在返回 false，由 action return status(404) */
  remove(id: number): boolean {
    return this.boardRepository.remove(id);
  }
}
