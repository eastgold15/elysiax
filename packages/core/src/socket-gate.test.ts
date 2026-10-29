/**
 * 插座门禁回归点（契约 §3）：跨原子 import 只能指向对方 <name>.socket.ts，
 * 且引用的符号必须真实存在。门禁现在挂在 codegen（dev/gen/build/add 都会经过），
 * doctor 共用同一实现——这里同时保证判定口径本身。
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { checkSocketGate, scanSource, socketPurityViolations } from "./socket-gate";

/** 造一个最小页面树：pages/alpha、pages/beta 两个原子 */
function fixture(betaImports: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "elysiax-gate-"));
  const dir = (a: string) => {
    const d = join(root, "src/pages", a);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${a}.di.ts`), "export const di = {};\n");
    // 插座：alpha 导出符号，beta 只需存在
    const syms = a === "alpha" ? "export const alphaThing = 1;\n" : "";
    writeFileSync(join(d, `${a}.socket.ts`), syms);
    writeFileSync(join(d, `${a}.service.ts`), "export class S {}\n");
  };
  dir("alpha");
  dir("beta");
  writeFileSync(join(root, "src/pages/beta/beta.service.ts"), betaImports.join("\n") + "\n");
  return root;
}

/** 在 fixture 基础上补写任意文件（路径相对 root） */
function fixtureWith(extra: Record<string, string>): string {
  const root = fixture([]);
  for (const [rel, content] of Object.entries(extra)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("scanSource：注释换空格保行数、字符串内容保留、正则与字符串内容标记为非代码", () => {
  const src = [
    "a /* x",
    'y */ b = "no import";',
    "const re = /[/*]/;",
    'import x from "./y";',
    "",
  ].join("\n");
  const { code, isCode } = scanSource(src);
  // 行结构不变：注释里换行保住，注释后的代码仍在自己的行
  expect(code.split("\n")).toHaveLength(src.split("\n").length);
  // 字符串内容保留（import 路径要能被正则捕获），但标记为「非代码」
  const str = code.indexOf('"no import"');
  expect(str).toBeGreaterThan(-1);
  expect(isCode[str + 1]).toBe(false);
  // 正则字面量内容也非代码，且没有把后面的行吞掉
  expect(isCode[code.indexOf("/[/*]/")]).toBe(false);
  // 真实 import 关键字在代码区
  expect(isCode[code.indexOf("import x")]).toBe(true);
});

test("checkSocketGate：跨原子经插座 = 合规", async () => {
  const root = fixture(['import { alphaThing } from "../alpha/alpha.socket";', "void alphaThing;"]);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toEqual([]);
  expect(gate.atomDirs).toHaveLength(2);
  expect(gate.symbols.get(join(root, "src/pages/alpha/alpha.socket.ts"))?.has("alphaThing")).toBe(true);
});

test("checkSocketGate：指向对方内部文件 = 私拉电线", async () => {
  const root = fixture(['import { S } from "../alpha/alpha.service";']);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toHaveLength(1);
  expect(gate.violations[0]!.file).toBe("src/pages/beta/beta.service.ts");
  expect(gate.violations[0]!.message).toContain("绕过了插座");
});

test("checkSocketGate：插座没导出的符号 = 插头插不上", async () => {
  const root = fixture(['import { notThere } from "../alpha/alpha.socket";']);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toHaveLength(1);
  expect(gate.violations[0]!.message).toContain('没有导出 "notThere"');
});

test("checkSocketGate：原子内部的相对 import 不算跨原子", async () => {
  const root = fixture(['import { S } from "./beta.service";']);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toEqual([]);
});

test("checkSocketGate：注释里的 import 不算数，花括号内的行注释不产生假违规", async () => {
  const root = fixture([
    '// import { S } from "../alpha/alpha.service";',
    '/* import { S } from "../alpha/alpha.service";',
    "   跨行块注释同样不算 */",
    "import {",
    "  alphaThing, // 这里只是说明",
    '} from "../alpha/alpha.socket";',
    "void alphaThing;",
  ]);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toEqual([]);
});

test("checkSocketGate：块注释剥离后行首 import 仍可识别（换行保留）", async () => {
  const root = fixture([
    "/* 一段很长的说明",
    "   占两行 */ import { S } from \"../alpha/alpha.service\";",
  ]);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toHaveLength(1);
  expect(gate.violations[0]!.message).toContain("绕过了插座");
});

test("checkSocketGate：动态 import 指向对方内部文件 = 私拉电线", async () => {
  const root = fixture([
    "export async function load() {",
    '  return import("../alpha/alpha.service");',
    "}",
  ]);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toHaveLength(1);
  expect(gate.violations[0]!.message).toContain("绕过了插座");
});

test("checkSocketGate：NodeNext 显式 .js 扩展名指向插座仍合规", async () => {
  const root = fixture([
    'import { alphaThing } from "../alpha/alpha.socket.js";',
    "void alphaThing;",
  ]);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toEqual([]);
});

test("checkSocketGate：NodeNext 显式 .js 扩展名指向内部文件仍违规", async () => {
  const root = fixture(['export { S } from "../alpha/alpha.service.js";']);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toHaveLength(1);
  expect(gate.violations[0]!.message).toContain("绕过了插座");
});

test("checkSocketGate：@/ 别名指向对方原子内部 = 违规", async () => {
  const root = fixture(['import { S } from "@/pages/alpha/alpha.service";']);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toHaveLength(1);
  expect(gate.violations[0]!.message).toContain("绕过了插座");
});

test("checkSocketGate：嵌套原子取最深归属——嵌套原子私拉父原子内部仍违规", async () => {
  const root = fixtureWith({
    "src/pages/alpha/nested/nested.di.ts": "export const di = {};\n",
    "src/pages/alpha/nested/nested.socket.ts": "export {};\n",
    "src/pages/alpha/nested/nested.service.ts": 'export { S } from "../../alpha/alpha.service";\n',
  });
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toHaveLength(1);
  expect(gate.violations[0]!.file).toBe("src/pages/alpha/nested/nested.service.ts");
});

test("checkSocketGate：正则字面量里的 /* 不会吞掉后续真实 import", async () => {
  const root = fixture([
    "const re = /[/*]/;",
    'import { S } from "../alpha/alpha.service";',
  ]);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toHaveLength(1);
});

test("checkSocketGate：模板串里的示例 import 是纯文本，不算引用", async () => {
  const root = fixture([
    "const s = `",
    'import { S } from "../alpha/alpha.service";',
    "`;",
    "void s;",
  ]);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toEqual([]);
});

test("checkSocketGate：模板串里的动态 import 示例同样不算", async () => {
  const root = fixture(["const s = `", 'import("../alpha/alpha.service")', "`;", "void s;"]);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toEqual([]);
});

test("checkSocketGate：JSX 文本里的撇号不会让块注释失效", async () => {
  const root = fixture([
    "export const C = () => <p>It's fine</p>;",
    "/*",
    'import { S } from "../alpha/alpha.service";',
    "*/",
    "export const ok = 1;",
  ]);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toEqual([]);
});

test("checkSocketGate：目录导入（alpha/index.ts）同样是私拉电线", async () => {
  const root = fixtureWith({
    "src/pages/alpha/index.ts": "export const x = 1;\n",
    "src/pages/beta/beta.service.ts": 'import { x } from "../alpha";\nvoid x;\n',
  });
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toHaveLength(1);
  expect(gate.violations[0]!.message).toContain("绕过了插座");
});

test("checkSocketGate：?raw 资源查询串不影响解析判定", async () => {
  const root = fixture(['import raw from "../alpha/alpha.service?raw";', "void raw;"]);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toHaveLength(1);
});

test("checkSocketGate：插座 export type * 与 export * as NS 的出口可被引用", async () => {
  const root = fixtureWith({
    "src/pages/alpha/alpha.model.ts": "export type User = { id: number };\n",
    "src/pages/alpha/alpha.socket.ts":
      'export type * from "./alpha.model";\nexport * as Model from "./alpha.model";\n',
    "src/pages/beta/beta.service.ts":
      'import type { User } from "../alpha/alpha.socket";\nimport { Model } from "../alpha/alpha.socket";\nvoid Model;\nexport type { User };\n',
  });
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toEqual([]);
});

test("checkSocketGate：符号表全量预热（doctor 只增不减对叶子插座也要有出口）", async () => {
  const root = fixture([]);
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.symbols.get(join(root, "src/pages/alpha/alpha.socket.ts"))?.has("alphaThing")).toBe(true);
});

test("socketPurityViolations：named/type 出口纯净，注释/字符串里的示例不算", () => {
  const src = [
    'export type { Todo } from "./todo.model";',
    'export { TodoService } from "./todo.service";',
    "// export default 是禁止的（这里只是注释）",
    'const doc = "export default x";',
    "export const makeTodo = () => new TodoService();",
    "",
  ].join("\n");
  expect(socketPurityViolations(src)).toEqual([]);
});

test("socketPurityViolations：export default 与 { x as default } 都违规", () => {
  expect(socketPurityViolations("export default 1;\n")).toHaveLength(1);
  const asDefault = socketPurityViolations('const s = 1;\nexport { s as default };\n');
  expect(asDefault).toHaveLength(1);
  expect(asDefault[0]).toContain("export default");
});

test("socketPurityViolations：实例出口违规，多声明里夹一个也算", () => {
  const one = socketPurityViolations("export const db = new Container();\n");
  expect(one).toHaveLength(1);
  expect(one[0]).toContain("实例");
  const multi = socketPurityViolations("export const a = 1, b = new Container();\n");
  expect(multi).toHaveLength(1);
});

test("checkSocketGate：purity 单独列出，不与跨原子 violations 混在一起", async () => {
  const root = fixtureWith({
    "src/pages/alpha/alpha.socket.ts": "export const alphaThing = 1;\nexport default 1;\n",
    "src/pages/beta/beta.service.ts": 'import { S } from "../alpha/alpha.service";\n',
  });
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toHaveLength(1);
  expect(gate.purity).toHaveLength(1);
  expect(gate.purity[0]!.file).toBe("src/pages/alpha/alpha.socket.ts");
});

test("checkSocketGate：插座 export * from 的出口可被插头引用（递归解析）", async () => {
  const root = fixtureWith({
    "src/pages/alpha/alpha.partials.ts": "export const Card = 1;\n",
    "src/pages/alpha/alpha.socket.ts": 'export * from "./alpha.partials";\n',
    "src/pages/beta/beta.service.ts": 'import { Card } from "../alpha/alpha.socket";\nvoid Card;\n',
  });
  const gate = await checkSocketGate(root, "src/pages");
  expect(gate.violations).toEqual([]);
});
