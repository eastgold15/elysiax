# ElysiaX 模块化框架 · 完整构想文档

> 本文档由 readme2 → readme6 的思考过程融合而成，以最终形态（readme6）为准。
> 过程脉络：**命名与目录约定（2）→ 源码安装模块市场（3）→ Tailwind + shadcn-htmx 样式体系（4）→ InferDI 依赖注入（5）→ 完整可运行示例（6）**。

---

## 一、核心理念

我们要构建的是一个 **微内核 + 插件化** 的全栈模块化框架，技术底座：

- **Bun**（运行时 + 构建器 + `Bun.serve` 全栈开发服务器）
- **Elysia**（HTTP 框架，嵌套路由、类型安全）
- **htmx**（UI 与后端贴近，HTML 片段即响应）
- **Tailwind CSS v4 + shadcn-htmx**（源码级 UI 组件体系）
- **InferDI（`@inferdi/inferdi` + `@inferdi/elysia`）**（零依赖、无装饰器、编译期类型检查的依赖注入）

四条不可动摇的原则：

1. **源码安装（shadcn 模型）**：安装即复制源码到 `./modules/`，之后模块就是你的代码。没有 node_modules、没有 postinstall、没有运行时依赖。可读、可改、可审计、可提交 git。
2. **模块自治**：一个模块的 UI、路由、业务、数据访问放在同一个文件夹里，UI 和后端零距离。
3. **编译期保证**：依赖图的健康由 InferDI 的类型系统在编译期检查，循环依赖用 `Lazy<T>` 在类型层面打破。
4. **显式优于隐式**：模块间调用通过 DI 容器或相对路径 import，依赖方向一眼可见。

---

## 二、模块命名约定

```
modules/user/
├── module.json           # 模块清单：名字、版本、路由前缀、依赖声明
├── user.ui.html          # UI 片段（htmx 目标）
├── user.controller.ts    # HTTP 层：Elysia 路由 + 请求处理（导出 Elysia 实例）
├── user.service.ts       # 业务逻辑（按需）
├── user.repository.ts    # 数据访问（按需）
└── user.model.ts         # 数据模型 / 类型 / Schema（按需）
```

| 后缀 | 职责 | 是否进虚拟模块 |
|---|---|---|
| `module.json` | 清单：名称/版本/依赖/provides/requires | ✅ 作为 `manifest` 聚合 |
| `.ui.html` | htmx 目标片段 | ✅ |
| `.controller.ts` | Elysia 路由 + 请求处理 | ✅ |
| `.service.ts` | 业务逻辑 | ❌ 由 DI 容器注册，controller 通过 `di.get()` 获取 |
| `.repository.ts` | 数据访问 | ❌ 由 DI 容器注册 |
| `.model.ts` | 类型 / Schema / 常量 | ❌ 由同模块文件相对 import |

**原则**：虚拟模块只聚合**需要被入口消费的运行时产物**（`manifest`、`ui`、`controller`）。service / repository 交给 DI 容器管理；model 多为纯类型，避免运行时导入得到空对象。

**按需**：文件不存在就跳过。简单模块可以只有 `module.json` + `ui.html` + `controller.ts`，复杂模块再逐步加 service / repository / model。

**命名一致性**：文件名前缀必须和文件夹名一致（`user/user.controller.ts`），插件靠这个规则定位文件。

与生态对齐：`.controller.ts` / `.service.ts` / `.repository.ts` / `.model.ts` 与 NestJS / DDD 完全一致；`.ui.html` 是 htmx 场景的合理特化（对应 `.vue` / `.svelte`）。

---

## 三、源码安装模块市场（shadcn 模型）

### 3.1 核心转变：模块 = 源码，不是包

| 传统包管理 | 源码安装（本方案） |
|---|---|
| `npm install user` | `myapp add user` |
| 装到 `node_modules/` | 复制到 `./modules/user/` |
| 编译产物 | 纯 `.ts` / `.html` 源码 |
| 传递依赖不可见 | 依赖也复制进 `./modules/`，可审计 |
| 更新是覆盖 | 更新是 diff + 手动合并 |
| 运行时解析 | 编译期相对路径 |

**一句话：安装即复制源码，之后模块就是你的代码。**

内置模块怎么办？`myapp init` 时直接把需要的模块（如 `core`、`ui-kit`）源码复制到 `./modules/`，之后与用户安装的模块没有区别。

### 3.2 安装流程

```bash
myapp add user
```

1. 从 registry 拉取 `user` 的源码 tarball
2. 解压到临时目录
3. 读 `module.json`，检查依赖
4. 对每个依赖递归执行同样流程（扁平化，不允许多版本共存）
5. 复制到 `./modules/<name>/`
6. 目标已存在 → **显示 diff，让用户确认**（查看 diff / 覆盖 / 跳过 / 重命名）
7. 写 `modules.lock.json`
8. 打印摘要：新增/覆盖了哪些文件

全程只复制文件——**没有 postinstall、没有编译、没有脚本执行**。这是源码安装最关键的安全点：用户永远知道什么被改动。

### 3.3 更新流程：diff 驱动

```bash
myapp update user
```

拉取新版 → 逐文件 diff → 用户确认后覆盖。本地改过的模块（`modified: true`）默认不覆盖，提示手动合并。

```json
// modules.lock.json
{
  "version": 1,
  "modules": {
    "user": {
      "version": "1.0.0",
      "source": "registry:user",
      "hash": "sha256-...",
      "installedAt": "2026-09-25T...",
      "modified": false
    }
  }
}
```

### 3.4 Registry

只做一件事：**发源码**。存 tarball + `module.json` 元数据 + 下载接口。没有编译、没有构建。`myapp publish` 打包上传，`myapp add` 下载复制。安装完，registry 就和你无关。

### 3.5 安全模型对比

| 风险 | 传统包管理 | 源码安装 |
|---|---|---|
| 隐藏代码 | postinstall、编译产物 | 无，全是源码 |
| 供应链攻击 | 传递依赖不可见 | 依赖也是源码，可审计 |
| 静默更新 | 可能覆盖本地修改 | 更新必须确认 + diff |
| 审计成本 | 需要工具扫描 | `git diff` 就够 |

代价：仓库更大、更新手动一点——对本地工具、桌面应用、内部系统完全值得。

---

## 四、样式体系：Tailwind CSS v4 + shadcn-htmx

- **Tailwind v4**：底层样式系统。通过 `bun-plugin-tailwind` 接入 `Bun.serve`，开发时热更新，编译进 exe 时自动打包完整 CSS。
- **shadcn-htmx**：82 个为 htmx v4 + Tailwind v4 设计的组件，`--flavour html` 输出纯 HTML markup。安装即复制源码，与模块市场理念完全一致。

接入步骤：

```bash
bun add tailwindcss bun-plugin-tailwind
npx shadcn-htmx init --flavour html
npx shadcn-htmx add button dialog combobox
mv components/ui/button.html modules/ui-kit/button.ui.html
```

`init` 注入的 CSS 变量（`--background`、`--primary` 等）是组件样式基础，**不要删**。

`ui-kit` 就是一个普通模块，只提供 `.ui.html` 片段。**组件文件名前缀是组件名**（`button.ui.html`），不是模块名，因此不进虚拟模块的命名规则——其他模块用相对路径 import：

```ts
import button from "../ui-kit/button.ui.html";
```

Tailwind v4 自动扫描项目里所有 `.ui.html`，提取 class 生成 CSS，无需额外配置。

---

## 五、依赖注入：InferDI

选择 InferDI 的原因：**零依赖、无装饰器、编译期类型检查**，与"源码完全可控"理念一致。

### 5.1 关键机制

- `Container`：`registerValue` / `registerClass` / `registerFactory`，第三个参数是依赖键数组，**顺序必须与构造函数参数完全一致**（顺序错了编译器直接报错）。
- 生命周期：`'singleton'`（默认）/ `'transient'` / `'scoped'`。
- **`@inferdi/elysia`**：`inferdiElysia` 插件为每个请求创建 DI 作用域，暴露在 `context.di` 上，`onAfterResponse` 自动 `dispose()`。
- **路由必须在 `.use(inferdiElysia(...))` 之后注册**，`di` 才会出现在上下文类型中。

### 5.2 循环依赖：`Lazy<T>`

两个单例互相依赖时，为服务注册 `Lazy` 伴随键，消费者注入 `Lazy<T>` 包装器，**把解析延迟到实际使用时**，循环在类型层面被打破。

守卫规则：`Lazy<singleton>` 只能注入单例消费者；`Lazy<scoped>` / `Lazy<transient>` 注入单例，**编译器直接报错**。

### 5.3 模块解耦：provides / requires

每个模块在 `module.json` 中声明向容器提供什么、需要什么：

```json
{
  "name": "user",
  "version": "1.0.0",
  "route": "/users",
  "provides": ["userService"],
  "requires": ["orderServiceLazy"]
}
```

模块之间**零代码依赖**——一个模块声明"我提供 `userService` 键"，另一个声明"我依赖 `orderServiceLazy` 键"，由容器装配。跨模块调用优先 DI；UI 片段等静态资源用相对路径 import（依赖方向显式可见）。

---

## 六、最终架构：完整可运行示例

> 本节是最终形态，覆盖 `user`、`order`、`ui-kit` 三个模块，演示从容器注册、虚拟模块聚合、控制器注入到 htmx UI 的完整链路。

### 6.1 项目结构

```
project/
├── modules/
│   ├── ui-kit/
│   │   ├── module.json
│   │   └── button.ui.html          # shadcn-htmx 组件源码
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
│       ├── order.service.ts
│       ├── order.controller.ts
│       └── order.ui.html
├── src/
│   ├── shared/
│   │   ├── db.ts
│   │   └── container.ts
│   ├── plugin.ts                   # 虚拟模块插件
│   ├── index.ts                    # 入口
│   ├── index.html
│   └── global.css                  # Tailwind + shadcn CSS 变量
├── bunfig.toml
├── shadcn-htmx.json
├── modules.lock.json
└── package.json
```

### 6.2 安装依赖

```bash
bun add elysia @inferdi/inferdi @inferdi/elysia
bun add tailwindcss bun-plugin-tailwind
```

### 6.3 `bunfig.toml`

```toml
preload = ["./src/plugin.ts"]

[serve.static]
plugins = ["bun-plugin-tailwind"]
```

`preload` 让运行时和 `bun build --compile` 都走虚拟模块插件。

### 6.4 `src/plugin.ts` — 虚拟模块插件

扫描 `modules/*/`，聚合每个模块的 `manifest`、`ui`、`controller`，文件不存在就跳过：

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

类型声明（`src/virtual.d.ts`）：

```ts
declare module "virtual:modules" {
  import type { Elysia } from "elysia";
  interface ModuleEntry {
    manifest: Record<string, unknown>;
    ui?: string;
    controller?: Elysia;
  }
  export const modules: Record<string, ModuleEntry>;
}
```

### 6.5 `src/shared/db.ts` — SQLite

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

### 6.6 `src/shared/container.ts` — InferDI 容器（含循环依赖示例）

`userService` 依赖 `orderServiceLazy`，`orderService` 依赖 `userServiceLazy`——双方各注入对方的 `Lazy<T>` 伴随键，循环在类型层面被打破：

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
      "userServiceLazy"                       // ← 生成 'userServiceLazy' 伴随键
    )
    // order 模块：单例
    .registerClass("orderRepository", OrderRepository, ["db"], "singleton")
    .registerClass(
      "orderService",
      OrderService,
      ["orderRepository", "userServiceLazy"], // ← 依赖 Lazy<UserService>
      "singleton",
      "orderServiceLazy"                      // ← 生成 'orderServiceLazy' 伴随键
    );
}
```

### 6.7 user 模块

```typescript
// modules/user/user.model.ts
export interface User {
  id: number;
  name: string;
}

export interface CreateUserInput {
  name: string;
}
```

```typescript
// modules/user/user.repository.ts
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

```typescript
// modules/user/user.service.ts
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

```typescript
// modules/user/user.controller.ts
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

```html
<!-- modules/user/user.ui.html -->
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

```json
// modules/user/module.json
{
  "name": "user",
  "version": "1.0.0",
  "route": "/users",
  "provides": ["userService"],
  "requires": ["orderServiceLazy"]
}
```

### 6.8 order 模块

```typescript
// modules/order/order.model.ts
export interface Order {
  id: number;
  userId: number;
  amount: number;
}
```

```typescript
// modules/order/order.repository.ts
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

```typescript
// modules/order/order.service.ts
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
    const user = this.userServiceLazy
      .get()
      .listUsers()
      .find((u) => u.id === userId);
    return user?.name ?? "Unknown";
  }
}
```

```typescript
// modules/order/order.controller.ts
import { Elysia } from "elysia";
import ui from "./order.ui.html";

export const orderController = new Elysia({ prefix: "/orders" })
  .get("/ui", () => ui)
  .get("/:id/user-name", ({ di, params }) =>
    di.get("orderService").getUserName(Number(params.id))
  );
```

```html
<!-- modules/order/order.ui.html -->
<div class="rounded-lg border p-4">
  <h3 class="font-medium">订单详情</h3>
  <p class="text-sm text-gray-500">订单信息将在此处显示</p>
</div>
```

```json
// modules/order/module.json
{
  "name": "order",
  "version": "1.0.0",
  "route": "/orders",
  "provides": ["orderService"],
  "requires": ["userServiceLazy"]
}
```

### 6.9 `src/index.ts` — 入口

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
        // 可在此注入请求级上下文（requestId、userId 等）
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

路由前缀嵌套：外层 `/api` + 模块内 `/users` → 最终 `/api/users`。

### 6.10 `src/index.html` 与 `src/global.css`

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

  <div hx-get="/api/users/ui" hx-trigger="load" hx-swap="innerHTML"></div>
  <div hx-get="/api/orders/ui" hx-trigger="load" hx-swap="innerHTML" class="mt-6"></div>
</body>
</html>
```

```css
/* src/global.css */
@import "tailwindcss";

/* shadcn-htmx init 注入的 CSS 变量（--background、--primary 等）不要删 */
```

### 6.11 运行与验证

```bash
bun run src/index.ts
```

打开 `http://localhost:3000`，页面加载时 htmx 自动请求 `/api/users/ui` 和 `/api/orders/ui`。

- **验证循环依赖被打破**：`UserService` ⇄ `OrderService` 互相通过 `Lazy<T>` 依赖，编译通过且运行无报错即成功。
- **验证编译期检查**：把 `user.service.ts` 中的 `Lazy<OrderService>` 改成直接注入 `OrderService`，TypeScript 立即报错。

---

## 七、关键设计点总表

| 关注点 | 方案 |
|---|---|
| 模块形式 | 源码文件夹 + `module.json`，全部在 `./modules/` |
| 安装方式 | 复制源码，存在即 diff 确认 |
| 依赖（包级） | 递归复制，扁平化，不允许多版本 |
| 更新 | 拉取新版 + diff + 手动合并，`modules.lock.json` 记录哈希与 modified |
| Registry | 只存源码 tarball + 元数据 |
| 虚拟模块 | 只扫 `modules/*/`，聚合 `manifest` + `ui` + `controller`，缺文件跳过 |
| 依赖（代码级） | InferDI 容器，`provides` / `requires` 声明，模块间零代码依赖 |
| 循环依赖 | 双方互注 `Lazy<singleton>` 伴随键，延迟到方法调用时解析 |
| 编译期检查 | InferDI `AllowedDeps` 在类型层面拒绝不合法依赖组合 |
| 请求作用域 | `inferdiElysia` 每请求一作用域，`onAfterResponse` 自动清理 |
| UI 共享 | `ui-kit` 模块（shadcn-htmx 组件源码），相对路径 import |
| 样式 | Tailwind v4 经 `bun-plugin-tailwind`，自动扫描 `.ui.html` |
| UI 与后端同模块 | `.ui.html` 与 `.controller.ts` 同文件夹，虚拟模块统一寻址 |

## 八、落地顺序

1. **`module.json` 规范**：名称、版本、路由前缀、`provides` / `requires`
2. **虚拟模块插件**：扫 `modules/*/`，聚合 manifest / ui / controller
3. **InferDI 容器**：`container.ts` + `inferdiElysia`，跑通 `di.get()`
4. **`myapp add ./local-path`**：本地复制先跑通，不接 registry
5. **diff 机制**：安装/更新时对比文件，用户确认（**复制 + diff 是源码安装的灵魂**）
6. **`modules.lock.json`**：版本、哈希、modified
7. **Tailwind + shadcn-htmx**：`ui-kit` 模块，验证 UI 源码共享
8. **`myapp publish` + registry**：模块稳定后再做
9. **`myapp update`**：diff 驱动更新
10. **HMR 体验**：利用 Bun 开发服务器，改 `.ui.html` / `.controller.ts` 浏览器即时更新

## 九、生态远期关注点

- **生命周期管理**：模块的安装/启动/停止/卸载钩子，宿主可在安装时安全触发数据迁移、健康检查
- **命名空间**：从第一天支持 `myapp add @author/module`，避免冲突，预留私有仓库与团队协作空间
- **组件质量门禁**：可分享的 UI 组件默认无业务耦合、暴露最小化 API、附可访问性说明（键盘操作、ARIA）
- **module.json Schema 严格化**：对齐 shadcn `registry-item.json`，显式声明 `registryDependencies`，保证安装可重现

---

**一句话总结**：安装就是复制，更新就是 diff，跨模块调用就是 DI 容器或相对路径。虚拟模块只扫 `./modules/`，registry 只存源码。所有代码可读、可改、可审计——我的代码我做主，代价是仓库大一点、更新手动一点，但对本地工具和桌面应用完全值得。

---

## 十、实现备忘（2026-09-25，demo 落地时的实际修正）

落地时与原构想有四处偏差，均为 Bun / Elysia 2.0 的现实约束：

1. **`virtual:modules` 改为占位文件 `src/modules.gen.ts`**。Bun 运行时（非构建期）只有「路径形态」的 specifier 才会进插件 `onResolve`，裸包名（含 `virtual:` 前缀）直接被跳过。占位文件同时解决了 TS 类型问题（ambient 声明不支持相对路径模块）。
2. **Bun `Glob` 不匹配目录**。`modules/*/` 扫描结果为空，改为直接扫 `modules/*/module.json` 作为模块发现依据。
3. **`.ui.html` 必须 `with { type: "text" }` 导入**。Bun 默认把 `.html` 当全栈页面对象（返回 `{}`），片段需要显式按文本导入。
4. **Elysia 2.0 beta 的 breaking change（已解决，2026-09-25 二轮）**：
   - 路由签名从 `(path, handler, hook)` 改为 `(path, hook, handler)`；
   - 生命周期钩子改名：`onError` → `error`、`onAfterResponse` → `afterResponse`、`resolve` 并入 `derive`；作用域参数从 `{ as: 'scoped' }` 改为字符串 `'plugin'`（`EventScope = 'global' | 'local' | 'plugin'`）；
   - `derive` 不跨 `.use()` 的**兄弟插件**边界传播，但沿**同一实例链**传播。因此挂载模式必须是：DI 插件实例自己 `.use()` 各模块 controller，再整体挂进外层 app（见 `packages/elysiax/src/di.ts` 的 `elysiaxAPI()`）。
   
   **`@inferdi/elysia` 6.1.0 已就地移植到 Elysia 2.0**：源码复制在 `packages/elysia`（源码安装原则对框架自身同样适用），改动了钩子名、作用域参数、泛型参数列表，并把 `Context` 换成结构性最小契约。`tsc --noEmit` 通过，demo 全端点验证通过，`di` 恢复为每请求一个 InferDI scope + `afterResponse` 自动 dispose。

## 十一、当前仓库形态

- `packages/elysiax`（`@elysiax/core`）：框架核心 —— `moduleAggregator()` Bun 插件、`inferdiDI()`、`ModuleManifest`/`ModuleEntry` 类型
- `packages/cli`（`@elysiax/cli`，bin `elysiax`）：基于 visulima **cerebro** 的 CLI —— `init`（模板脚手架）、`add`（源码安装，拒绝静默覆盖）、`list`；错误经 `errorHandlerPlugin({ exitOnError: true, concise })` 干净退出
- `packages/cli/template`：项目模板（= demo 的最小可运行形态）
- `apps/elysiax`：主 demo（user / order / ui-kit，InferDI `Lazy<T>` 循环依赖演示）
- `apps/demo`：`elysiax init` 产物的验证实例（含 CLI `add` 进来的 todo 模块）
