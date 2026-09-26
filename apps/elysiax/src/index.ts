import { Elysia } from "elysia";
import { serve } from "bun";
import index from "./index.html";
import { modules } from "./modules.gen";
import { buildRootContainer } from "./shared/container";
import { elysiaxAPI } from "@elysiax/core";

const root = buildRootContainer();

// DI 插件实例自己挂载所有模块 controller（Elysia 2.0 的 derive 只沿同一实例链传播）
const api = elysiaxAPI(root, modules);

const app = new Elysia({ prefix: "/api" }).use(api);

serve({
  port: 3000,
  routes: {
    "/": index,
    "/api/*": (req) => app.handle(req),
  },
  development: true,
});

console.log(`✅ elysiax demo: http://localhost:3000`);
console.log(`   已挂载模块: ${Object.keys(modules).join(", ")}`);

export type api = typeof app;
