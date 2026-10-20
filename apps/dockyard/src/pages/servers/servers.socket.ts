// servers 原子的插座：对外承诺的全部契约。原子内部随便重构，本文件导出保持稳定。
// 规则：跨原子 import 只允许指向本文件；client（浏览器包）只允许 import type（值会打进浏览器包）。
export { servers } from "./schema";
export type { Server } from "./schema";
export { ServerService } from "./servers.service";
