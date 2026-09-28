# @elysiax/core

Bun + Elysia + htmx（服务端 TSX）+ React 岛的模块化全栈框架。模块 = 限界上下文，DI 由 InferDI 容器装配。

## 一个模块长什么样

```
src/modules/<name>/
  <name>.di.ts          # 唯一事实源：route + 服务声明（module.json 已废弃）
  <name>.controller.tsx # 路由入口
  <name>.service.ts     # 业务逻辑
  <name>.repository.ts  # 数据访问
  <name>.ui.tsx         # 服务端渲染组件（可选）
  island/               # React 岛（可选，内部全归 React，htmx 只渲染容器）
```

## 声明服务：provide / lazy

```ts
// user.di.ts
import { defineModule, lazy, provide } from "@elysiax/core";

export default defineModule({
  route: "/users",
  provides: {
    // 键 = camelCase 类名。依赖写类引用，类型从构造函数签名推导，写错编译报错
    userRepository: provide(UserRepository, ["db"]), // 值服务（db 等）用字符串键
    userService: provide(UserService, [UserRepository, lazy(OrderService)]),
    //                                              ↑ 懒加载，替代旧的 "orderServiceLazy" 字符串约定
  },
});
```

规则：

- 键与 camelCase 类名不一致会 warn（其他模块按键注入）
- `lazy(X)` 只允许用在 `Lazy<X>` 类型的构造函数参数上
- InferDI 不支持双向 Lazy —— 跨上下文保持单向依赖，组合上移到 controller

## controller

```tsx
import { defineController } from "../../../.elysiax";

export const userController = defineController({ prefix: "/users" })
  // di 默认带全图 ServiceMap；传窄泛型收敛到模块边界（推荐）
  .get("/", ({ di }) => di.get("userService").listUsers());
```

窄类型由 codegen 按模块生成（provides ∪ 直接 deps）：

```tsx
import { defineController, type UserServices } from "../../../.elysiax";

export const userController = defineController<UserServices>({ prefix: "/users" })...
```

返回 JSX 即 `text/html` 响应（框架内置 `html()` autoDetect，无需手动包裹）。

## 测试

```ts
import * as gen from "../.elysiax";
import { createTestContainer } from "@elysiax/core";

const di = createTestContainer(gen, { userRepository: new FakeRepo() });
di.get("userService"); // 注入的是 FakeRepo（override 必须在任何 get 之前）
```

## CLI（@elysiax/cli）

```sh
elysiax init [dir]        # 从模板创建项目
elysiax new module orders # 脚手架模块（di + controller + service），自动重跑 codegen
elysiax new island canvas # 在模块里脚手架 React 岛
elysiax add <path>        # 源码安装模块（module.json 可选，装完自动装配校验）
elysiax dev               # codegen + bun --hot，声明变化自动重生成
elysiax gen               # 手动重生成 .elysiax/
elysiax build [--desktop] # 编译二进制 / webview 桌面应用
```

## htmx JSX 类型

`hx-*` 属性类型由 `@workspace/htmx` 主入口自动引入（type-only），无需任何 `htmx.d.ts` 或 triple-slash 指令。
