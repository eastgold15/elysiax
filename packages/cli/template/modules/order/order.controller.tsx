import { Elysia } from "elysia";
import OrderUi from "./order.ui";

export const orderController = new Elysia({ prefix: "/orders" })
  .get("/ui", () => <OrderUi />)
  .get("/:id/user-name", ({ di, params }) =>
    di.get("orderService").getUserName(Number(params.id)),
  );
