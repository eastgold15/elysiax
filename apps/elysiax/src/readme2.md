好，采用这套命名：

```
modules/user/
├── user.ui.html          # UI 片段（htmx 目标）
├── user.controller.ts    # HTTP 层：Elysia 路由 + 请求处理
├── user.service.ts       # 业务逻辑（按需）
├── user.repository.ts    # 数据访问（按需）
└── user.model.ts         # 数据模型 / 类型 / Schema（按需）
```

去掉 `.api.ts`，`.controller.ts` 同时承担路由定义和请求处理。下面给你一套完整可跑的方案。

---

## 一、命名约定

| 后缀 | 职责 | 是否进虚拟模块 |
|---|---|---|
| `.ui.html` | htmx 目标片段 | ✅ 需要被外部消费 |
| `.controller.ts` | Elysia 路由 + 请求处理 | ✅ 需要被入口挂载 |
| `.service.ts` | 业务逻辑 | ❌ 由 controller 内部 import |
| `.repository.ts` | 数据访问 | ❌ 由 service 内部 import |
| `.model.ts` | 类型 / Schema / 常量 | ❌ 由同模块文件 import |

**原则**：虚拟模块只聚合**需要被外部消费的运行时产物**（UI 和 controller）。service / repository / model 是模块内部实现，通过相对路径直接 import 即可，不聚合。这样避免了类型导入在运行时变成空对象的问题，也让模块边界更清晰。

---

## 二、目录结构

```
src/
├── modules/
│   ├── user/
│   │   ├── user.ui.html
│   │   ├── user.controller.ts
│   │   ├── user.service.ts
│   │   ├── user.repository.ts
│   │   └── user.model.ts
│   └── order/
│       ├── order.ui.html
│       ├── order.controller.ts
│       └── order.repository.ts      # 没有 service / model，按需省略
├── shared/
│   └── db.ts
├── index.html
├── index.ts
└── plugin.ts
```

---

## 三、模块内部示例（user）

### `user.model.ts` — 类型与 Schema

```ts
// src/modules/user/user.model.ts
export interface User {
  id: number;
  name: string;
}

export interface CreateUserInput {
  name: string;
}
```

### `user.repository.ts` — 数据访问

```ts
// src/modules/user/user.repository.ts
import { db } from "../../shared/db";
import type { User, CreateUserInput } from "./user.model";

export const userRepository = {
  findAll(): User[] {
    return db.query("SELECT id, name FROM users").all() as User[];
  },
  create(input: CreateUserInput): User {
    const stmt = db.query("INSERT INTO users (name) VALUES (?) RETURNING id, name");
    return stmt.get(input.name) as User;
  },
};
```

### `user.service.ts` — 业务逻辑

```ts
// src/modules/user/user.service.ts
import { userRepository } from "./user.repository";
import type { CreateUserInput } from "./user.model";

export const userService = {
  async listUsers() {
    return userRepository.findAll();
  },
  async addUser(input: CreateUserInput) {
    if (!input.name.trim()) throw new Error("name required");
    return userRepository.create(input);
  },
};
```

### `user.controller.ts` — 路由 + 请求处理

```ts
// src/modules/user/user.controller.ts
import { Elysia, t } from "elysia";
import { userService } from "./user.service";

export const userController = new Elysia({ prefix: "/users" })
  .get("/", () => userService.listUsers())
  .post(
    "/",
    ({ body }) => userService.addUser(body),
    { body: t.Object({ name: t.String() }) }
  );
```

### `user.ui.html` — UI 片段

```html
<!-- src/modules/user/user.ui.html -->
<ul>
  <li>Alice</li>
  <li>Bob</li>
</ul>
```

---

## 四、虚拟模块插件（支持按需）

```ts
// src/plugin.ts
import { plugin, Glob } from "bun";

plugin({
  name: "module-aggregator",
  setup(build) {
    build.onResolve({ filter: /^virtual:modules$/ }, () => ({
      path: "virtual:modules",
      namespace: "module-aggregator",
    }));

    build.onLoad(
      { filter: /.*/, namespace: "module-aggregator" },
      async () => {
        const dirs: string[] = [];
        const dirGlob = new Glob("src/modules/*/");
        for await (const dir of dirGlob.scan(".")) dirs.push(dir);

        const imports: string[] = [];
        const exports: string[] = [];

        // 只聚合需要被外部消费的运行时产物
        const suffixMap = {
          ui: ".ui.html",
          controller: ".controller.ts",
        } as const;

        for (const dir of dirs) {
          const name = dir.replace(/^src\/modules\//, "").replace(/\/$/, "");
          const base = `src/modules/${name}/${name}`;
          const varName = name.replace(/-/g, "_");

          const entries: string[] = [];

          for (const [key, suffix] of Object.entries(suffixMap)) {
            const filePath = `${base}${suffix}`;
            if (await Bun.file(filePath).exists()) {
              const importName = `${varName}_${key}`;
              imports.push(`import ${importName} from "${filePath}";`);
              entries.push(`    ${key}: ${importName},`);
            }
          }

          if (entries.length > 0) {
            exports.push(`  ${varName}: {`, ...entries, `  },`);
          }
        }

        const contents = `
${imports.join("\n")}

export const modules = {
${exports.join("\n")}
};
`;

        return { contents, loader: "js" };
      }
    );
  },
});
```

**按需的关键**：`await Bun.file(filePath).exists()` 判断文件是否存在，不存在就跳过，不会报错。所以 `order` 模块没有 `service.ts` 也能正常聚合。

---

## 五、入口整合

```ts
// src/index.ts
import { Elysia } from "elysia";
import { serve } from "bun";
import index from "./index.html";
import { modules } from "virtual:modules";

const API = new Elysia({ prefix: "/api" });

for (const mod of Object.values(modules)) {
  if (mod.controller) API.use(mod.controller);
}

serve({
  port: 3000,
  routes: {
    "/": index,
    "/api/*": (req) => API.handle(req),
  },
  development: true,
});
```

`userController` 的 prefix 是 `/users`，外层 `API` 的 prefix 是 `/api`，Elysia 嵌套后最终路由是 `/api/users`。

---

## 六、类型声明

```ts
// src/virtual.d.ts
declare module "virtual:modules" {
  import type { Elysia } from "elysia";

  interface ModuleEntry {
    ui?: string;
    controller?: Elysia;
  }

  export const modules: Record<string, ModuleEntry>;
}
```

---

## 七、注册插件

`bunfig.toml`：

```toml
preload = ["./src/plugin.ts"]
```

这样运行时和 `bun build --compile` 时都会走这个插件，虚拟模块在两种场景下都能解析。

---

## 八、关于“按需”的几点说明

1. **虚拟模块只聚合 ui 和 controller**。service / repository / model 不进虚拟模块，由同模块文件直接相对导入。这样：
   - 避免 `model.ts` 只导出类型时，运行时导入得到空对象
   - 模块内部实现细节不外泄，边界清晰

2. **文件不存在就跳过**。插件用 `Bun.file().exists()` 判断，简单模块可以只有 `ui.html` + `controller.ts`，复杂模块再逐步加 `service.ts`、`repository.ts`、`model.ts`。

3. **命名一致性**。文件名前缀必须和文件夹名一致（`user/user.controller.ts`），插件靠这个规则定位文件。

4. **controller 导出 Elysia 实例**。这样入口可以统一 `API.use(mod.controller)`，无需额外适配。

---

## 九、这套命名和公共约束的对齐情况

| 你的命名 | 生态对应 | 评价 |
|---|---|---|
| `.controller.ts` | NestJS / Spring controller | ✅ 完全一致 |
| `.service.ts` | NestJS / Angular service | ✅ 完全一致 |
| `.repository.ts` | NestJS / DDD repository | ✅ 完全一致 |
| `.model.ts` | NestJS entity / model | ✅ 一致 |
| `.ui.html` | Vue `.vue` / Svelte `.svelte` | ✅ htmx 场景的合理特化 |

去掉 `.api.ts` 后，`controller` 不再和 `api` 抢职责，整套命名和主流后端生态基本对齐，只剩 `.ui.html` 是你技术栈带来的合理差异。

需要我把 `shared/db.ts` 和 `order` 模块的示例也补全，凑成一个可直接 `bun run` 的最小可运行项目吗？