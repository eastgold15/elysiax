import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codegen } from "./codegen";
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
