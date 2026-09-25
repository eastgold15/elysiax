import { Elysia } from "elysia";
import ui from "./order.ui.html" with { type: "text" };

export const orderController = new Elysia({ prefix: "/orders" })
  .get("/ui", () => ui)
  .get("/:id/user-name", ({ di, params }: any) =>
    di.get("orderService").getUserName(Number(params.id)),
  );
