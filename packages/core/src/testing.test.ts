import { expect, test } from "bun:test";
import { Container } from "@inferdi/inferdi";
import { createTestContainer } from "./testing";

// 模拟 socket 导出的服务类与它的替身（契约 §3：跨原子只认类）
class ProjectService {
  list() {
    return "real";
  }
}

class FakeProjectService {
  list() {
    return "fake";
  }
}

// 模拟 .elysiax 的 buildRootContainer：与生产相同的装配路径
const gen = {
  buildRootContainer: () =>
    new Container().registerClass("projectService", ProjectService, [], "singleton"),
};

test("overrides：按字符串键替换服务", () => {
  const di = createTestContainer(gen, {
    projectService: new FakeProjectService(),
  });
  expect(di.get("projectService").list()).toBe("fake");
});

test("substitutes：按 socket 导出的服务类替换（键 = lowerFirst 类名）", () => {
  const di = createTestContainer(gen, undefined, [
    { class: ProjectService, use: new FakeProjectService() },
  ]);
  expect(di.get("projectService").list()).toBe("fake");
});

test("不传替身时容器保持生产装配", () => {
  const di = createTestContainer(gen);
  expect(di.get("projectService").list()).toBe("real");
});
