/** client 的 API 层：Eden Treaty 端到端类型客户端（路径/params/body 全类型安全）。
 *  类型唯一来源是 board.socket 的 BoardApi 出口（契约 §3）；
 *  依赖链只允许浏览器安全包（react + @elysia/eden），禁 Node-only。 */
import { treaty } from "@elysia/eden";
import type { BoardApi } from "../board.socket";

export const api = treaty<BoardApi>(`${location.origin}/api/board`);

/** Eden TreatyResponse 的宽松形状（data 按状态码收窄，这里只取成功分支） */
type AnyTreaty = {
  data: unknown;
  error: { status: unknown; value: unknown } | null;
};

/** 从错误体提取消息：ServiceError 映射是 { error } JSON，兜底状态码 */
function errMessage(value: unknown, status: unknown): string {
  if (value && typeof value === "object" && "error" in value) {
    const v = (value as { error: unknown }).error;
    if (typeof v === "string") return v;
  }
  return `HTTP ${String(status)}`;
}

/** Eden 的 { data, error } → 抛错式：失败抛 Error(message)，成功取 data */
export async function unwrap<R extends AnyTreaty>(
  p: Promise<R>,
): Promise<NonNullable<R["data"]>> {
  const { data, error } = await p;
  if (error) throw new Error(errMessage(error.value, error.status));
  return data as NonNullable<R["data"]>;
}
