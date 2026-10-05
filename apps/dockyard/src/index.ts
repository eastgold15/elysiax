// 必须置顶：Elysia 内部惰性 require("typebox/*")，bun --compile 无法静态分析，
// 这里显式 import 强制把 typebox 打进二进制（否则编译产物启动即挂）
import "typebox/type";
import "typebox/system";
import "typebox/value";
import "typebox/schema";
import "typebox/compile";

import index from "./index.html";
import { start } from "@elysiax/core";
import * as gen from "../.elysiax";
import { startUpdatePoller } from "./modules/deploy/update-poller";
import { startContainerPoller } from "./modules/deploy/container-poller";

await start({ port: 3002, index, gen });

// GitHub 更新轮询：只提示不自动部署
startUpdatePoller();
// 容器状态轮询 → 事件总线 → SSE：SSH 频率与前端用户数无关
startContainerPoller();
