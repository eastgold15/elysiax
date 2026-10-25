// bun test 预加载（bunfig.toml [test].preload）：happy-dom 全局 DOM +
// Solid JSX 预编译（client/ 下的 .tsx 经 babel-preset-solid，与构建同一套）。
import { setupClientTest } from "@elysiax/solid/testing";

setupClientTest();
