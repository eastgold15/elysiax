/**
 * 插座门禁回归点（契约 §3）：跨原子 import 只能指向对方 <name>.socket.ts，
 * 且引用的符号必须真实存在。门禁现在挂在 codegen（dev/gen/build/add 都会经过），
 * doctor 共用同一实现——这里同时保证判定口径本身。
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkSocketGate } from "./socket-gate";

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
