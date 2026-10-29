import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codegen, extractRoutes, type RouteRow } from "./codegen";
import type { ElysiaxConfig } from "./config";

// di 夹具直接引用 core 源码的绝对路径：fixture 在 /tmp 下，node_modules 解析不到 "@elysiax/core"
const CORE = join(import.meta.dir, "codegen.ts");

const CONFIG: ElysiaxConfig = { pages: "src/pages", modules: "src/modules" };

const roots: string[] = [];

/** 按相对路径表搭一个临时项目根，返回根目录（测后统一清理） */
function makeFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "elysiax-codegen-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const atomDi = (route?: string) => `
import { defineModule, provide } from ${JSON.stringify(CORE)};
export class TodoService {}
export default defineModule({
  ${route ? `route: ${JSON.stringify(route)},` : ""}
  provides: { todoService: provide(TodoService) },
});
`;

test("正常原子：di + socket 齐备，codegen 成功并生成 .elysiax 产物", async () => {
  const root = makeFixture({
    "src/pages/todo/todo.di.ts": atomDi("/todo"),
    "src/pages/todo/todo.socket.ts": `export { TodoService } from "./todo.di";\n`,
    "src/pages/todo/todo.page.tsx": `export default () => null;\n`,
  });
  const written = await codegen(root, CONFIG);
  expect(written).toContain(".elysiax/container.gen.ts");
  expect(written).toContain(".elysiax/services.gen.ts");
});

test("di 缺 default export defineModule：报错并指向契约 §1.1", async () => {
  const root = makeFixture({
    "src/pages/todo/todo.di.ts": `export const notAModule = 1;\n`,
    "src/pages/todo/todo.socket.ts": `export {};\n`,
  });
  await expect(codegen(root, CONFIG)).rejects.toThrow(
    /todo\.di\.ts 必须 default export defineModule/,
  );
});

test("原子有 schema.ts 但缺 socket.ts：报错并说明插座规则（契约 §3）", async () => {
  const root = makeFixture({
    "src/pages/todo/todo.di.ts": atomDi("/todo"),
    "src/pages/todo/schema.ts": `export const todos = {};\n`,
  });
  await expect(codegen(root, CONFIG)).rejects.toThrow(
    /原子 "todo" 缺少 todo\.socket\.ts/,
  );
});

test("di 提供类服务但缺 socket.ts：同样要求插座", async () => {
  const root = makeFixture({
    "src/pages/todo/todo.di.ts": atomDi("/todo"),
  });
  await expect(codegen(root, CONFIG)).rejects.toThrow(/socket\.ts/);
});

test("两个原子 route 重复：报错并列出双方", async () => {
  const root = makeFixture({
    "src/pages/todo/todo.di.ts": atomDi("/same"),
    "src/pages/todo/todo.socket.ts": `export { TodoService } from "./todo.di";\n`,
    "src/pages/board/board.di.ts": atomDi("/same"),
    "src/pages/board/board.socket.ts": `export { TodoService } from "./board.di";\n`,
  });
  await expect(codegen(root, CONFIG)).rejects.toThrow(/route "\/same" 重复/);
});

test("页面 URL 重复（index.page 与 <目录名>.page 同目录）：报错", async () => {
  const root = makeFixture({
    "src/pages/todo/index.page.tsx": `export default () => null;\n`,
    "src/pages/todo/todo.page.tsx": `export default () => null;\n`,
  });
  await expect(codegen(root, CONFIG)).rejects.toThrow(/页面 URL "\/todo" 重复/);
});

test("client 页同时有整页 handler：报错（整页归客户端，二者互斥）", async () => {
  const root = makeFixture({
    "src/pages/board/client/index.tsx": `export default () => null;\n`,
    "src/pages/board/board.page.tsx": `export default () => null;\n`,
  });
  await expect(codegen(root, CONFIG)).rejects.toThrow(/同时声明了 client\/index 与整页 handler/);
});

test("extractRoutes：方法与路径分开收集（ui 归一为 GET），同路径不同方法都保留", () => {
  const src =
    `export default defineController({ prefix: "/api/x" })` +
    `.get("/", () => 1).post("/", () => 2).ui("/page", () => 3);`;
  const { prefix, paths, routes } = extractRoutes(src, "/fallback");
  expect(prefix).toBe("/api/x");
  // 助手只看路径：同一路径只出现一次
  expect(paths).toEqual(["/api/x", "/api/x/page"]);
  expect(routes).toEqual([
    { method: "GET", path: "/api/x" },
    { method: "POST", path: "/api/x" },
    { method: "GET", path: "/api/x/page" },
  ]);
});

test("路由表旁产物：页面 / 片段 / actions 的挂载点与方法落 routes.table.json", async () => {
  const root = makeFixture({
    "src/pages/todo/todo.di.ts": atomDi("/todo"),
    "src/pages/todo/todo.socket.ts": `export { TodoService } from "./todo.di";\n`,
    "src/pages/todo/todo.page.tsx": `export default () => null;\n`,
    "src/pages/todo/todo.partials.tsx": `export default defineRoutes().get("/list", () => null);\n`,
    "src/pages/todo/todo.actions.ts": [
      "export default defineRoutes()",
      '  .post("/toggle", () => null)',
      '  .get("/config", () => null);',
      "",
    ].join("\n"),
  });
  await codegen(root, CONFIG);
  const rows = JSON.parse(
    readFileSync(join(root, ".elysiax/routes.table.json"), "utf8"),
  ) as RouteRow[];
  expect(rows).toEqual([
    { kind: "page", method: "GET", path: "/todo", source: "src/pages/todo/todo.page.tsx" },
    {
      kind: "partials",
      method: "GET",
      path: "/api/todo/list",
      source: "src/pages/todo/todo.partials.tsx",
    },
    {
      kind: "actions",
      method: "POST",
      path: "/api/todo/toggle",
      source: "src/pages/todo/todo.actions.ts",
    },
    {
      kind: "actions",
      method: "GET",
      path: "/api/todo/config",
      source: "src/pages/todo/todo.actions.ts",
    },
  ]);
});

test("插座含 export default：codegen 直接拒绝（契约 §3.1，不再只在 doctor 报）", async () => {
  const root = makeFixture({
    "src/pages/todo/todo.di.ts": atomDi("/todo"),
    "src/pages/todo/todo.socket.ts": `export { TodoService } from "./todo.di";\nexport default 1;\n`,
  });
  await expect(codegen(root, CONFIG)).rejects.toThrow(/插座纯度未通过.*export default/s);
});

test("插座导出实例：codegen 拒绝（共享可变状态必须走 DI）", async () => {
  const root = makeFixture({
    "src/pages/todo/todo.di.ts": atomDi("/todo"),
    "src/pages/todo/todo.socket.ts": `export { TodoService } from "./todo.di";\nexport const db = new TodoService();\n`,
  });
  await expect(codegen(root, CONFIG)).rejects.toThrow(/插座纯度未通过.*实例/s);
});

test("裸对象 di（未经 defineModule 归一化）：品牌校验拒绝，不再静默生成坏容器", async () => {
  const root = makeFixture({
    "src/pages/todo/todo.di.ts": `
export class TodoService {}
export default { route: "/todo", provides: { todoService: TodoService } };
`,
    "src/pages/todo/todo.socket.ts": `export { TodoService } from "./todo.di";\n`,
  });
  await expect(codegen(root, CONFIG)).rejects.toThrow(/没有经过 defineModule\(\) 归一化/);
});
