import { Elysia, setupTypebox } from "elysia";
import * as typeboxType from "typebox/type";
import * as typeboxSystem from "typebox/system";
import * as typeboxValue from "typebox/value";
import * as typeboxSchema from "typebox/schema";
import * as typeboxCompile from "typebox/compile";
import { serve } from "bun";
import type { Container } from "@inferdi/inferdi";
import { elysiaxAPI } from "./di";
import type { ModuleEntry } from "./index";

export interface ElysiaxGenerated {
  modules: Record<string, ModuleEntry>;
  buildRootContainer: () => Container<any>;
}

/**
 * 启动 elysiax 应用：根容器 + 模块装配 + 全栈 serve。
 * 生成物全部在 .elysiax/（elysiax dev / gen 生成），app 入口只剩：
 *
 * ```ts
 * import index from "./index.html";
 * import { start } from "@elysiax/core";
 * import * as gen from "../.elysiax";
 *
 * await start({ port: 3000, index, gen });
 * ```
 */
// elysia 惰性加载 typebox 走运行时 req("typebox/type")（dist/type/typebox-type.mjs），
// bun --compile 后在 $bunfs 里解析不到、编译产物一编译路由就死。
// 必须在模块顶层注入：controller 模块在 import 阶段就会调 t.Numeric() 等 stub，
// 等 start() 执行再注入就晚了。静态 import 会被打进产物，注入后跳过运行时解析。
// app 入口约定先 `import { start } from "@elysiax/core"` 再 import gen，本模块先求值。
setupTypebox({
  typebox: {
    type: typeboxType,
    system: typeboxSystem,
    value: typeboxValue,
    schema: typeboxSchema,
    compile: typeboxCompile,
  },
});

export async function start(opts: {
  port?: number;
  /** `import index from "./index.html"` 的页面对象 */
  index: unknown;
  /** `import * as gen from "../.elysiax"` */
  gen: ElysiaxGenerated;
}) {
  const root = opts.gen.buildRootContainer();
  const api = elysiaxAPI(root, opts.gen.modules);
  const app = new Elysia({ prefix: "/api" }).use(api);

  serve({
    port: opts.port ?? 3000,
    routes: {
      "/": opts.index as any,
      "/api/*": (req) => app.handle(req),
    },
    development: true,
  });

  console.log(`✅ elysiax: http://localhost:${opts.port ?? 3000}`);
  console.log(`   已挂载模块: ${Object.keys(opts.gen.modules).join(", ")}`);
}
