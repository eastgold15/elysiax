import type { Component } from "@workspace/htmx";

/** @deprecated 死代码：module.json 约定已删、codegen 对 .ui/.controller 文件直接报错，勿用（待移除） */
export { moduleAggregator } from "./plugin";
/** @deprecated 同上 */
export type { ModuleAggregatorOptions } from "./plugin";
export { elysiaxAPI, elysiaxModule, inferdiElysia } from "./di";
export { elysiaxModule as defineRoutes } from "./di";
export type { ElysiaxAPIOptions } from "./di";
export { definePage } from "./pages";
export type { PageCtx, PageEntry, PageHandler, PageMeta, ServiceSpecs } from "./pages";
export { defineLayout, getLayout } from "./layout";
/** @deprecated 死代码且语义过期：只护页面 URL、不护 /api 写端点；鉴权请用 start({ auth }) 宏方案（待移除） */
export { elysiaxGuard } from "./guard";
/** @deprecated 同上 */
export type { GuardOptions } from "./guard";
export { elysiaxAuth } from "./auth";
export { ServiceError, errorBanner } from "./errors";
export { codegen, defineModule, provide, lazy, extractRoutes } from "./codegen";
export type { DiEntry, DiEntryInput, LazyRef, ModuleDi, ModuleDiInput, ProvideOptions } from "./codegen";
export { createTestContainer } from "./testing";
export type { Substitute } from "./testing";
export { defineRealtime } from "./realtime";
export type { RealtimeOptions } from "./realtime";
export { start } from "./start";
export type { ElysiaxGenerated } from "./start";
export { defineConfig, loadConfig } from "./config";
export type { ElysiaxConfig } from "./config";

/** 模块清单（modules/<name>/module.json） */
export interface ModuleManifest {
  name: string;
  version: string;
  route?: string;
  provides?: string[];
  requires?: string[];
}

/** 聚合产物 modules.gen 中每个模块的形态 */
export interface ModuleEntry {
  manifest: ModuleManifest;
  ui?: Component<any>;
  // any 泛型：模块 controller 由 elysiaxModule<S> 创建，derive 类型各不相同
  controller?: import("elysia").Elysia<any, any, any, any, any, any, any, any>;
}
