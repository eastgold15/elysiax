import { Elysia } from "elysia";
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
