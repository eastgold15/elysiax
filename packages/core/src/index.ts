import type { Component } from "@workspace/htmx";

export { elysiaxAPI, elysiaxModule, inferdiElysia } from "./di";
export { elysiaxModule as defineRoutes } from "./di";
export type { ElysiaxAPIOptions } from "./di";
export { definePage } from "./pages";
export type { PageCtx, PageEntry, PageHandler, PageMeta, ServiceSpecs } from "./pages";
export { defineLayout, getLayout } from "./layout";

export { elysiaxAuth } from "./auth";
export type { GuardOptions } from "./auth";
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
