下面是一个完整的可运行示例，覆盖用户（`user`）和订单（`order`）两个模块，演示从容器注册、虚拟模块聚合、控制器注入到 htmx UI 的完整链路。

## 项目文件结构

```
project/
├── modules/
│   ├── ui-kit/
│   │   ├── module.json
│   │   └── button.ui.html
│   ├── user/
│   │   ├── module.json
│   │   ├── user.model.ts
│   │   ├── user.repository.ts
│   │   ├── user.service.ts
│   │   ├── user.controller.ts
│   │   └── user.ui.html
│   └── order/
│       ├── module.json
│       ├── order.model.ts
│       ├── order.repository.ts
│
    ├── order.service.ts
│       ├── order.controller.ts
│       └── order.ui.html
├── src/
│   ├── shared/
│   │   ├── db.ts
│   │   └── container.ts
│   ├── plugin.ts
│   ├── index.ts
│   ├── index.html
│   └── global.css
├── bunfig.toml
├── shadcn-htmx.json
└── package.json
```

---

## 1. 安装依赖

```bash
bun add elysia @inferdi/inferdi @inferdi/elysia
bun add tailwindcss bun-plugin-tailwind
```

---

## 2. `bunfig.toml` — 注册虚拟模块插件和 Tailwind

```toml
preload = ["./src/plugin.ts"]

[serve.static]
plugins = ["bun-plugin-tailwind"]
```

---

## 3. `src/plugin.ts` — 虚拟模块插件

扫描 `modules/*/`，聚合每个模块的 `manifest`、`ui` 和 `controller`。

```typescript
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
        const dirGlob = new Glob("modules/*/");
        for await (const dir of dirGlob.scan(".")) dirs.push(dir);

        const imports: string[] = [];
        const exports: string[] = [];

        const suffixMap = {
          ui: ".ui.html",
          controller: ".controller.ts",
        } as const;

        for (const dir of dirs) {
          const name = dir.replace(/^modules\//, "").replace(/\/$/, "");
          const base = `modules/${name}/${name}`;
          const varName = name.replace(/-/g, "_");
          const entries: string[] = [];

          const manifestPath = `modules/${name}/module.json`;
          if (!(await Bun.file(manifestPath).exists())) continue;

          imports.push(`import ${varName}_manifest from "${manifestPath}";`);
          entries.push(`    manifest: ${varName}_manifest,`);

          for (const [key, suffix] of Object.entries(suffixMap)) {
            const filePath = `${base}${suffix}`;
            if (await Bun.file(filePath).exists()) {
              const importName = `${varName}_${key}`;
              imports.push(`import ${importName} from "${filePath}";`);
              entries.push(`    ${key}: ${importName},`);
            }
          }

          exports.push(`  ${varName}: {`, ...entries, `  },`);
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

---

## 4. `src/shared/db.ts` — SQLite 连接

```typescript
import { Database } from "bun:sqlite";

export const db = new Database("app.db");

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);
```

---

## 5. `src/shared/container.ts` — InferDI 容器

**关键点**：`orderService` 注册时传入 `lazyKey: "userServiceLazy"`，生成 `Lazy<UserService>` 伴随键。`userService` 依赖的是 `"orderServiceLazy"`，而不是 `OrderService` 本身，从而打破循环。

```typescript
import { Container } from "@inferdi/inferdi";
import { db } from "./db";
import { UserRepository } from "../../modules/user/user.repository";
import { UserService } from "../../modules/user/user.service";
import { OrderRepository } from "../../modules/order/order.repository";
import { OrderService } from "../../modules/order/order.service";

export function buildRootContainer() {
  return new Container()
    // 基础设施
    .registerValue("db", db)
    // user 模块：单例，同时生成 Lazy 伴随键
    .registerClass("userRepository", UserRepository, ["db"], "singleton")
    .registerClass(
      "userService",
      UserService,
      ["userRepository", "orderServiceLazy"], // ← 依赖 Lazy<OrderService>
      "singleton",
      "userServiceLazy" // ← 生成 'userServiceLazy' 伴随键
    )
    // order 模块：单例
    .registerClass("orderRepository", OrderRepository, ["db"], "singleton")
    .registerClass(
      "orderService",
      OrderService,
      ["orderRepository", "userServiceLazy"], // ← 依赖 Lazy<UserService>
      "singleton",
      "orderServiceLazy" // ← 生成 'orderServiceLazy' 伴随键
    );
}
```

`Lazy<T>` 的规则非常严格：**单例消费者只能注入 `Lazy<singleton>`**。`Lazy<scoped>` 和 `Lazy<transient>` 注入单例，编译器会直接报错。

---

## 6. 模块内部实现

### `modules/user/user.model.ts`

```typescript
export interface User {
  id: number;
  name: string;
}

export interface CreateUserInput {
  name: string;
}
```

### `modules/user/user.repository.ts`

```typescript
import type { Database } from "bun:sqlite";
import type { User, CreateUserInput } from "./user.model";

export class UserRepository {
  constructor(private db: Database) {}

  findAll(): User[] {
    return this.db.query("SELECT id, name FROM users").all() as User[];
  }

  create(input: CreateUserInput): User {
    return this.db
      .query("INSERT INTO users (name) VALUES (?) RETURNING id, name")
      .get(input.name) as User;
  }
}
```

### `modules/user/user.service.ts`

```typescript
import type { Lazy } from "@inferdi/inferdi";
import type { UserRepository } from "./user.repository";
import type { OrderService } from "../order/order.service";
import type { CreateUserInput } from "./user.model";

export class UserService {
  constructor(
    private userRepository: UserRepository,
    private orderServiceLazy: Lazy<OrderService> // ← 延迟解析，打破循环
  ) {}

  listUsers() {
    return this.userRepository.findAll();
  }

  addUser(input: CreateUserInput) {
    if (!input.name.trim()) throw new Error("name required");
    return this.userRepository.create(input);
  }

  getUserOrders(userId: number) {
    // 真正需要时才解析 OrderService 实例
    return this.orderServiceLazy.get().listByUser(userId);
  }
}
```

### `modules/user/user.controller.ts`

```typescript
import { Elysia, t } from "elysia";
import ui from "./user.ui.html";

export const userController = new Elysia({ prefix: "/users" })
  .get("/", ({ di }) => di.get("userService").listUsers())
  .get("/ui", () => ui) // 返回 UI 片段给 htmx
  .post(
    "/",
    ({ di, body }) => di.get("userService").addUser(body),
    { body: t.Object({ name: t.String() }) }
  )
  .get("/:id/orders", ({ di, params }) =>
    di.get("userService").getUserOrders(Number(params.id))
  );
```

### `modules/user/user.ui.html`

```html
<div class="space-y-4">
  <h2 class="text-lg font-semibold">用户列表</h2>
  <ul class="divide-y divide-gray-200">
    <li class="py-2">Alice</li>
    <li class="py-2">Bob</li>
  </ul>
  <button
    class="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
    hx-get="/api/users/1/orders"
    hx-target="#orders"
  >
    查看 Alice 的订单
  </button>
  <div id="orders"></div>
</div>
```

### `modules/user/module.json`

```json
{
  "name": "user",
  "version": "1.0.0",
  "route": "/users",
  "provides": ["userService"],
  "requires": ["orderServiceLazy"]
}
```

---

### `modules/order/order.model.ts`

```typescript
export interface Order {
  id: number;
  userId: number;
  amount: number;
}
```

### `modules/order/order.repository.ts`

```typescript
import type { Database } from "bun:sqlite";
import type { Order } from "./order.model";

export class OrderRepository {
  constructor(private db: Database) {}

  findByUser(userId: number): Order[] {
    return this.db
      .query("SELECT id, user_id as userId, amount FROM orders WHERE user_id = ?")
      .all(userId) as Order[];
  }
}
```

### `modules/order/order.service.ts`

```typescript
import type { Lazy } from "@inferdi/inferdi";
import type { OrderRepository } from "./order.repository";
import type { UserService } from "../user/user.service";

export class OrderService {
  constructor(
    private orderRepository: OrderRepository,
    private userServiceLazy: Lazy<UserService> // ← 延迟解析
  ) {}

  listByUser(userId: number) {
    return this.orderRepository.findByUser(userId);
  }

  getUserName(userId: number) {
    // 延迟解析，仅在真正需要时
    const user = this.userServiceLazy
      .get()
      .listUsers()
      .find((u) => u.id === userId);
    return user?.name ?? "Unknown";
  }
}
```

### `modules/order/order.controller.ts`

```typescript
import { Elysia } from "elysia";
import ui from "./order.ui.html";

export const orderController = new Elysia({ prefix: "/orders" })
  .get("/ui", () => ui)
  .get("/:id/user-name", ({ di, params }) =>
    di.get("orderService").getUserName(Number(params.id))
  );
```

### `modules/order/order.ui.html`

```html
<div class="rounded-lg border p-4">
  <h3 class="font-medium">订单详情</h3>
  <p class="text-sm text-gray-500">订单信息将在此处显示</p>
</div>
```

### `modules/order/module.json`

```json
{
  "name": "order",
  "version": "1.0.0",
  "route": "/orders",
  "provides": ["orderService"],
  "requires": ["userServiceLazy"]
}
```

---

## 7. `src/index.ts` — 入口

`@inferdi/elysia` 插件为每个请求创建一个 DI 作用域，通过 `di` 键暴露在 Elysia 上下文中，并在 `onAfterResponse` 自动清理。

```typescript
import { Elysia } from "elysia";
import { inferdiElysia } from "@inferdi/elysia";
import { serve } from "bun";
import index from "./index.html";
import { modules } from "virtual:modules";
import { buildRootContainer } from "./shared/container";

const root = buildRootContainer();

const app = new Elysia({ prefix: "/api" })
  .use(
    inferdiElysia({
      container: root,
      setupScope: (scope, { request }) => {
        // 可在此注入请求级上下文
      },
    })
  );

// 自动挂载所有模块的 controller
for (const mod of Object.values(modules)) {
  if (mod.controller) app.use(mod.controller);
}

serve({
  port: 3000,
  routes: {
    "/": index,
    "/api/*": (req) => app.handle(req),
  },
  development: true,
});
```

`@inferdi/elysia` 不会全局扩展 Elysia 的上下文类型，**路由必须在 `.use(inferdiElysia(...))` 之后注册**，`di` 才会出现在类型中。

---

## 8. `src/index.html` — 主页面

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>模块化应用</title>
  <link rel="stylesheet" href="./global.css" />
  <script
    src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.11/dist/htmx.min.js"
    integrity="sha384-2OatzQy1H+Zd/IIrjr1TcuDGqLXeHhbooAyJY1KdQMKnr4LZ22k31GBLdYKHmVjg"
    crossorigin="anonymous"
  ></script>
</head>
<body class="p-8">
  <h1 class="text-2xl font-bold mb-6">模块化全栈应用</h1>

  <div
    hx-get="/api/users/ui"
    hx-trigger="load"
    hx-swap="innerHTML"
  ></div>

  <div
    hx-get="/api/orders/ui"
    hx-trigger="load"
    hx-swap="innerHTML"
    class="mt-6"
  ></div>
</body>
</html>
```

---

## 9. `src/global.css`

```css
@import "tailwindcss";
```

---

## 10. 运行与验证

```bash
bun run src/index.ts
```

打开 `http://localhost:3000`，页面加载时 htmx 自动请求 `/api/users/ui` 和 `/api/orders/ui`，分别返回两个模块的 HTML 片段。

**测试循环依赖是否真正被打破**：`UserService` 和 `OrderService` 互相通过 `Lazy<T>` 依赖对方。如果编译通过且运行时无报错，说明循环依赖已被 InferDI 的类型系统正确拦截并允许延迟解析。

**验证编译期检查**：尝试把 `user.service.ts` 中的 `Lazy<OrderService>` 改成直接的 `OrderService`，TypeScript 会立即报错——因为 `OrderService` 尚未注册完成，类型系统拒绝这种前向引用。

---

## 关键设计点总结

| 关注点 | 实现方式 |
|---|---|
| 循环依赖打破 | 双方各注入对方的 `Lazy<T>` 伴随键，延迟到方法调用时才解析 |
| 编译期检查 | InferDI 的 `AllowedDeps` 在类型层面拒绝不合法的依赖组合 |
| 虚拟模块 | `plugin.ts` 扫描 `modules/*/`，聚合 `manifest`、`ui`、`controller` |
| 请求作用域 | `inferdiElysia` 为每个请求创建独立作用域，`onAfterResponse` 自动清理 |
| 源码安装 | 所有模块都是 `modules/` 下的普通源码文件，无运行时依赖 |
| UI 与后端同模块 | `.ui.html` 和 `.controller.ts` 放在同一个文件夹，由虚拟模块统一寻址 |