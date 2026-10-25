# 模块（原子）契约 v1

> 这是多 agent 并行开发的**唯一事实来源**。任何 agent 的实现与本文件冲突时，以本文件为准。

## 1. 原子 = 自含垂直切片

一个原子（atom / 模块）是 `src/pages/<name>/` 下的一个目录，自含数据层、服务层、UI 层。

### 1.1 必选文件

| 文件 | 作用 | 规则 |
|---|---|---|
| `<name>.di.ts` | 模块身份证 | **default export `defineModule({ route, provides })`**，codegen 据此自动发现，无需手工注册 |
| `<name>.socket.ts` | 唯一对外插座 | 见 §3 |

### 1.2 数据层（有持久化时必含）

| 文件 | 作用 |
|---|---|
| `schema.ts` | drizzle 表定义，本原子的表锚点 |
| `migrations.ts` | 本原子的迁移 |
| `<name>.repository.ts` | 数据访问，依赖 `"db"` 值服务 |

### 1.3 UI 层：两种形态，二选一

**形态 A：htmx 模块**（L1-L3，服务端渲染 + 局部刷新）

| 文件 | 作用 |
|---|---|
| `<name>.page.tsx` | default export `definePage(...)`，整页 |
| `<name>.actions.tsx` | htmx action 端点（返回 partial） |
| `<name>.partials.tsx` | 局部模板组件 |

**形态 B：react 模块**（L5 整页 client 模式）

| 文件 | 作用 |
|---|---|
| `client/index.tsx` | React 入口（浏览器包） |
| `client/api.ts` | Eden Treaty 客户端，类型来自 socket 的 API 出口 |
| `<name>.actions.ts` | 纯 API 的 Elysia 实例，**default export**，供 Eden 推导类型 |
| （无 `.page.tsx`） | 壳由 HTMLBundle 服务，不走 htmx |

约束：`client/` 的依赖链**禁止 Node-only 包**（dotenv、bun:sqlite 等），否则浏览器打包 500。

## 2. DI 规则

```ts
import { defineModule, provide, lazy } from "@elysiax/core";

export default defineModule({
  route: "/<name>",
  provides: {
    // 值服务（db 等无类实例）→ 字符串键
    xxxRepository: provide(XxxRepository, ["db"]),
    // 类服务 → 类引用，编译期校验
    xxxService: provide(XxxService, [XxxRepository]),
    // 跨上下文单向依赖 → lazy(Class)，自动生成 xxxLazy 伴随键
    otherService: provide(OtherService, [lazy(ForeignService)]),
  },
});
```

- InferDI **不支持双向 lazy 循环**；依赖必须单向。
- 外部原子需要的服务，由本原子 di 提供并经 socket 导出类。

## 3. socket.ts：唯一对外插座

```ts
// <name> 原子的插座：对外承诺的全部契约。
export { tableA, tableB } from "./schema";        // 表锚点
export type { RowA } from "./schema";              // 行类型
export { XxxService } from "./xxx.service";        // 服务类（供外原子 di 注入）

// react 形态追加：Eden Treaty 的 API 类型出口
import type xxxApi from "./xxx.actions";
export type XxxApi = typeof xxxApi;
```

**规则：**

1. socket.ts 只含 **named export / type export**，不 export default，不含运行时逻辑。
2. 跨原子 import 的**唯一合法形式**：
   ```ts
   import { XxxService } from "../<atom>/<atom>.socket";
   ```
   禁止 `../<atom>/xxx.service` 这类穿透 import（父子原子也走插座）。
3. 原子内部文件之间自由 import，不受限。

## 4. 错误处理约定

- services 抛 `ServiceError`（`@elysiax/core`）；
- actions **零 try/catch** 回显；
- 预期错误 `return status(code, { error })`。

## 5. 并行开发纪律（多 agent）

1. 每个 agent 只新增/修改自己负责的目录，**不碰共享文件**（根配置、`schema.all.ts`、`.elysiax/` 产物）。
2. `.elysiax/` codegen 产物由集成者统一重新生成，agent 不手改、不各自跑 codegen。
3. 新原子只要按 §1.1 放好 `<name>.di.ts`，重新跑 codegen 即自动接入，无需改任何既有文件。

## 6. 两个示例模块（本期目标）

在 `apps/demo` 下做出两种形态的**对照示例**，回答「一个 elysia 后端 + 两种 UI 的模块长什么样」：

| 模块 | 形态 | 目录 |
|---|---|---|
| `todo` | htmx | `apps/demo/src/pages/todo/` |
| `board` | react client | `apps/demo/src/pages/board/` |

两者都按本契约自含 di/socket；demo 层复用现有 `src/shared/db.ts` 的 `"db"` 值服务。
