import { status, t } from "elysia";
import { defineRoutes } from "../../../.elysiax";
import type { BoardService } from "./board.service";

// 列的校验 schema（与 board.repository 的 Column 类型一一对应）
const ColumnSchema = t.Union([t.Literal("todo"), t.Literal("doing"), t.Literal("done")]);

/** 结构化取服务：避免每处重复 di.get 的键名；
 *  等 codegen 重跑后 ServiceMap 带上 boardService 键，这里即类型闭合 */
const boardOf = (di: { get(k: "boardService"): BoardService }): BoardService =>
  di.get("boardService");

// 纯 API 的 Elysia 实例（react 形态，契约 §1.3 形态 B）：挂载点 /api/board 由 codegen 推导。
// 零 try/catch：业务错误由 ServiceError 统一映射；预期错误 return status()
export default defineRoutes()
  .get("/cards", ({ di }) => boardOf(di).list())
  .post(
    "/cards",
    { body: t.Object({ title: t.String() }) },
    ({ di, body, set }) => {
      set.status = 201;
      return boardOf(di).add(body.title);
    },
  )
  .patch(
    "/cards/:id",
    { params: t.Object({ id: t.Number() }), body: t.Object({ column: ColumnSchema }) },
    ({ di, params, body }) => {
      const card = boardOf(di).move(params.id, body.column);
      if (!card) return status(404, { error: "卡片不存在" });
      return card;
    },
  )
  .delete("/cards/:id", { params: t.Object({ id: t.Number() }) }, ({ di, params, set }) => {
    if (!boardOf(di).remove(params.id)) return status(404, { error: "卡片不存在" });
    set.status = 204;
  });
