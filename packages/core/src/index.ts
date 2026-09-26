import type { Component } from "@workspace/htmx";

export { moduleAggregator } from "./plugin";
export type { ModuleAggregatorOptions } from "./plugin";
export { elysiaxAPI, elysiaxModule, inferdiElysia } from "./di";
export { codegen, defineModule } from "./codegen";
export type { DiEntry, ModuleDi } from "./codegen";
export { start } from "./start";
export type { ElysiaxGenerated } from "./start";

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
