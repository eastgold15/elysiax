import type { Container, Lifetime, Spec } from "@inferdi/inferdi";

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * 按 socket 导出的服务类做替身注册（契约 §3：跨原子只会 import 类，拿不到字符串键）。
 * 键推导与 codegen 归一化规则一致：`lowerFirst(类名)`。
 */
export interface Substitute {
  /** socket 导出的原服务类（仅用于推导容器键，不会实例化它） */
  class: abstract new (...args: never[]) => unknown;
  /** 替身实例：必须结构上实现原服务类型（InferDI override 会强制） */
  use: unknown;
}

/**
 * 一行起测试容器：走与生产完全相同的 buildRootContainer() 装配，
 * 再用 InferDI 的 .override() 替换个别服务（mock 必须结构上实现原服务类型，
 * 且必须在任何 .get() 之前 override —— InferDI 会强制这两点）。
 *
 * 两种替身声明方式：
 * 1. `overrides`：按字符串键替换（本原子内部服务，键就在眼前）；
 * 2. `substitutes`：按 socket 导出的服务类替换（跨原子场景只知道类），
 *    键由类名推导，与 defineModule/provide 的归一化规则一致。
 *
 * ```ts
 * import * as gen from "../.elysiax";
 * import { createTestContainer } from "@elysiax/core";
 * import { ProjectService } from "../pages/projects/projects.socket";
 *
 * const di = createTestContainer(
 *   gen,
 *   { projectRepository: new FakeProjectRepository() },       // 按键
 *   [{ class: ProjectService, use: new FakeProjectService() }], // 按类
 * );
 * const service = di.get("deployService"); // 注入的都是替身
 * ```
 */
export function createTestContainer<
  // Spec<any,>：既有保留——泛型约束要兼容所有具体 Spec<T> 图谱，any 是拓扑可赋值点
  T extends Record<string | symbol, Spec<any, Lifetime>>,
>(
  gen: { buildRootContainer(): Container<T> },
  overrides?: Partial<{ [K in keyof T]: T[K]["type"] }>,
  substitutes?: readonly Substitute[],
): Container<T> {
  const container = gen.buildRootContainer();
  for (const [key, value] of Object.entries(overrides ?? {})) {
    container.override(key as never, value as never);
  }
  for (const s of substitutes ?? []) {
    container.override(lowerFirst(s.class.name) as never, s.use as never);
  }
  return container;
}
