import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { elysiaxAuth } from "./auth";
import { ServiceError, serviceErrorHandler } from "./errors";

const loggedIn = new Elysia()
  .use(elysiaxAuth({ loginUrl: "/login", verify: () => true }))
  .get("/me", { auth: true }, () => "ok");

const loggedOut = new Elysia()
  .use(elysiaxAuth({ loginUrl: "/login", verify: () => false }))
  .get("/me", { auth: true }, () => "ok")
  .get("/public", { auth: false }, () => "public");

test("已登录：auth 宏放行，handler 正常执行", async () => {
  const res = await loggedIn.handle(new Request("http://x/me"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("未登录普通请求：302 跳登录页", async () => {
  const res = await loggedOut.handle(new Request("http://x/me"));
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/login");
});

test("未登录 hx 请求：401 + HX-Redirect", async () => {
  const res = await loggedOut.handle(
    new Request("http://x/me", { headers: { "HX-Request": "true" } }),
  );
  expect(res.status).toBe(401);
  expect(res.headers.get("hx-redirect")).toBe("/login");
});

test("auth: false 关闭宏", async () => {
  const res = await loggedOut.handle(new Request("http://x/public"));
  expect(res.status).toBe(200);
});

test("guard({ auth: true }) 批量保护子路由（partials/actions 挂载形态）", async () => {
  const partials = new Elysia().get("/list", () => "items");
  const app = new Elysia()
    .use(elysiaxAuth({ loginUrl: "/login", verify: () => false }))
    .guard({ auth: true }, (s) => s.use(partials));
  const res = await app.handle(new Request("http://x/list"));
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/login");
});

test("ServiceError：hx → 片段，普通 → JSON", async () => {
  const app = new Elysia()
    .onError(ServiceError, serviceErrorHandler)
    .get("/boom", () => {
      throw new ServiceError("部署失败", 409);
    });

  const json = await app.handle(new Request("http://x/boom"));
  expect(json.status).toBe(409);
  expect(await json.json()).toEqual({ error: "部署失败" });

  const hx = await app.handle(
    new Request("http://x/boom", { headers: { "HX-Request": "true" } }),
  );
  expect(hx.status).toBe(409);
  expect(hx.headers.get("content-type")).toContain("text/html");
  expect(await hx.text()).toContain("部署失败");
});
