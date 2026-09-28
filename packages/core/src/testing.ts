import type { Container, Lifetime, Spec } from "@inferdi/inferdi";

/**
 * 一行起测试容器：走与生产完全相同的 buildRootContainer() 装配，
 * 再用 InferDI 的 .override() 替换个别服务（mock 必须结构上实现原服务类型，
 * 且必须在任何 .get() 之前 override —— InferDI 会强制这两点）。
 *
 * ```ts
 * import * as gen from "../.elysiax";
 * import { createTestContainer } from "@elysiax/core";
 *
 * const di = createTestContainer(gen, {
 *   projectRepository: new FakeProjectRepository(),
 * });
 * const service = di.get("projectService"); // 注入的是 FakeRepo
 * ```
 */
export function createTestContainer<
  T extends Record<string | symbol, Spec<any, Lifetime>>,
>(
  gen: { buildRootContainer(): Container<T> },
  overrides?: Partial<{ [K in keyof T]: T[K]["type"] }>,
): Container<T> {
  const container = gen.buildRootContainer();
  for (const [key, value] of Object.entries(overrides ?? {})) {
    container.override(key as never, value as never);
  }
  return container;
}
