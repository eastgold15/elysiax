import type { Component } from "@workspace/htmx";

export { moduleAggregator } from "./plugin";
export type { ModuleAggregatorOptions } from "./plugin";
export { elysiaxAPI, elysiaxModule, inferdiElysia } from "./di";

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
  controller?: import("elysia").Elysia;
}
