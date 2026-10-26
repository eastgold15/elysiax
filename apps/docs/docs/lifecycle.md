
# Elysia 2 生命周期与 Eden 类型推导完整解析

> 基于 `apps/web/server/docs/lifecycle-verify.ts` 的真实运行输出
> 跑这个验证脚本: `BUN_TMPDIR=.bun-cache bun run apps/web/server/docs/lifecycle-verify.ts`

---

## 1. 三个生命周期 hook 概览

| Hook              | 触发时机                         | 能改 body?      | 典型用途                                      |
| ----------------- | -------------------------------- | --------------- | --------------------------------------------- |
| `afterHandle`   | handler 之后**第一道**     | ✅ 是           | 包装响应、字段映射、envelope 化               |
| `mapResponse`   | afterHandle 之后                 | ✅ 是(类型限制) | 改 status / headers,或在 afterHandle 后再处理 |
| `afterResponse` | 响应已**发送给客户端**之后 | ❌ 否           | logging / metrics / 异步清理                  |

**关键**: 三个 hook 都**能看到 response**,但**只有前两个能改 body**。

---

## 2. 执行顺序(Example 4 实测)

```typescript
const ex4 = new Elysia()
  .afterHandle((ctx) => {
    console.log(`[1.afterHandle] 收到:`, JSON.stringify(ctx.responseValue));
    return { ...(ctx.responseValue as any), step: "afterHandle" };
  })
  .mapResponse((ctx) => {
    console.log(`[2.mapResponse] 收到:`, JSON.stringify(ctx.responseValue));
    return { ...(ctx.responseValue as any), step: "mapResponse" };
  })
  .afterResponse((ctx) => {
    console.log(`[3.afterResponse] 最终:`, JSON.stringify(ctx.responseValue));
  })
  .get("/test", () => ({ origin: "handler" }));
```

**实际输出**:

```
[1.afterHandle] 收到: {"origin":"handler"}
[2.mapResponse] 收到: {"origin":"handler","step":"afterHandle"}
[3.afterResponse] 最终: {"origin":"handler","step":"mapResponse"}
[client] 收到: {"origin":"handler","step":"mapResponse"}
```

**链式累积**: 每个 hook 拿到上一步的结果,最终 client 看到 `mapResponse` 的输出。

---

## 3. afterHandle — 改 body 主力(Example 1)

```typescript
const ex1 = new Elysia()
  .afterHandle((ctx) => {
    // ctx.responseValue 是 handler 的返回值
    console.log(`[afterHandle] 收到:`, JSON.stringify(ctx.responseValue));
    // return 新值 = 新 body
    return { code: 0, message: "ok", data: ctx.responseValue };
  })
  .get("/users/1", () => ({ id: 1, name: "Alice" }));
```

**实测**:

```
[afterHandle] 收到: {"id":1,"name":"Alice"}
[client] 状态: 200, body: {"code":0,"message":"ok","data":{"id":1,"name":"Alice"}}
```

**关键点**:

- `ctx.responseValue` 是 handler 的**实际返回**
- return 什么,client 就收到什么
- 没 return = 不改 body(用 `void`)

---

## 4. mapResponse — 改 headers / status(Example 2)

```typescript
const ex2 = new Elysia()
  .mapResponse((ctx) => {
    // 改 headers
    ctx.set.headers["x-trace-id"] = "trace-12345";
    return ctx.responseValue;  // body 不动
  })
  .get("/products/1", () => ({ id: 1, name: "iPhone" }));
```

**实测**:

```
[client] x-trace-id: trace-12345
[client] body: {"id":1,"name":"iPhone"}
```

**关键点**:

- `ctx.set.headers` / `ctx.set.status` 改响应元数据
- return body(或不 return)改 body
- 名字 "mapResponse" 在 Elysia 2 还是保留,但**实际能改 body**(Elysia 1 时代只能改 Response 对象)

---

## 5. afterResponse — 只读,不能改(Example 3)

```typescript
const ex3 = new Elysia()
  .afterResponse((ctx) => {
    console.log(`[afterResponse] response:`, JSON.stringify(ctx.responseValue));
    // 这里改 body 没用,已经发送了
  })
  .get("/orders/1", () => ({ id: 1, total: 100 }));
```

**实测**:

```
[afterResponse] response: {"id":1,"total":100}
[afterResponse] 试图改 body - 但已经发送了
[client] body: {"id":1,"total":100}
```

**关键点**:

- 这里**只能**做 logging / 异步任务
- 想发 metrics?在这里
- 想清理资源?在这里

---

## 6. TypeBox schema 验证时机(Example 5)

```typescript
const ex5 = new Elysia()
  .get(
    "/users",
    {
      response: t.Object({ id: t.Integer(), name: t.String() }),
    },
    // @ts-expect-error
    () => ({ id: "not-a-number", name: 123 })  // 错误类型
  )
  .get(
    "/users-good",
    {
      response: t.Object({ id: t.Integer(), name: t.String() }),
    },
    () => ({ id: 1, name: "Alice" })  // 正确
  );
```

**实测(`/users` 错误)**:

```
[client] 状态: 422, body: {
  type: "validation",
  title: "Validation Error",
  status: 422,
  detail: "must be integer",
  on: "response",
  property: "/id",
  ...
}
```

**关键点**:

- TypeBox `response` 验证**在所有 hook 之后**跑
- handler 类型不对 → **编译时报错**(`@ts-expect-error` 触发)
- handler 类型对但**值不对** → 运行时 422

**Elysia 返回的 422 是 Elysia 2 的 `application/problem+json` 格式**(RFC 9457),不是 `{message: "..."}`,所以前端 `error.value?.message` 拿不到真实错误。

---

## 7. response schema 与 handler 强绑定(Example 6)

```typescript
const ex6 = new Elysia()
  .get(
    "/profile",
    {
      // response 写 envelope 形式
      response: t.Object({
        code: t.Integer(),
        message: t.String(),
        data: t.Object({ id: t.Integer(), name: t.String() }),
      }),
    },
    // handler 必须 return 完全匹配 response 形状
    () => ({ code: 0, message: "ok", data: { id: 1, name: "Bob" } })
  );
```

**实测**:

```
[client] body: {"code":0,"message":"ok","data":{"id":1,"name":"Bob"}}
```

**关键点**:

- TypeScript **编译期**会强制 handler return 类型 = response schema
- 如果 response 写 envelope,handler 必须 return envelope
- 想要 `return entity` 让 plugin 自动包?—— **不行,类型层会报错**

---

## 8. envelope 自动包装的陷阱(Example 7 关键)

**常见错误尝试**: controller 写 plain response schema,加 afterHandle 包 envelope

```typescript
const ex7 = new Elysia()
  .afterHandle((ctx) => {
    // 把 plain 改成 envelope
    if (typeof ctx.responseValue === "object" && ctx.responseValue !== null) {
      const obj = ctx.responseValue as any;
      if (Array.isArray(obj.items) && typeof obj.total === "number") {
        return { code: 0, message: "ok", data: { items: obj.items, total: obj.total } };
      }
      return { code: 0, message: "ok", data: obj };
    }
    return ctx.responseValue;
  })
  .get(
    "/products",
    {
      // response 写 plain — 假设 Eden 推 plain,handler return plain
      response: t.Object({
        items: t.Array(t.Object({ id: t.Integer(), name: t.String() })),
        total: t.Integer(),
      }),
    },
    () => ({ items: [{ id: 1, name: "iPhone" }], total: 1 })
  );
```

**实测**:

```
[client /products] 状态: 422
[client /products] body: {
  type: "validation",
  detail: "must have required properties items, total",
  on: "response",
  found: {"code":0,"message":"ok","data":{"items":[...],"total":1}}
}
```

**422 错误**!TypeBox 验证发现 afterHandle 改成了 envelope,但 response schema 是 plain → 验证失败。

**结论**:

- **TypeBox response 验证在 afterHandle 之后跑**
- 想自动包装 envelope?response 必须也写 envelope
- response 写 envelope → handler 必须 return envelope → Eden 推 envelope
- "想 return plain,前端拿 envelope" 在 Elysia 2 + TypeBox 验证下**做不到**

---

## 9. Eden 类型推导(Example 8)

```typescript
import type { treaty } from "@elysia/eden";

type Ex7 = typeof ex7;
type Rpc = ReturnType<typeof treaty<Ex7>>;
type ProductsFn = Rpc["products"]["get"];
type ProductsReturn = Awaited<ReturnType<ProductsFn>>;
type ProductsData = NonNullable<ProductsReturn["data"]>;
```

**实测推**:

```typescript
// ProductsData 推 =
{
  items: [{ id: 1, name: "iPhone" }],
  total: 1
}
```

**Eden 推导规则**:

1. **只看 controller `response` schema**(编译时)
2. **不知道 afterHandle / mapResponse 做了什么**(运行时)
3. **类型层独立** — TypeScript 编译时拿到的类型 = 写死的 schema 形状
4. **运行时可能不一样** — 验证脚本 Example 7 显示,运行时 body 可能跟 schema 不匹配(然后 422)

---

## 10. 关键结论图

```
┌─────────────────────────────────────────────────────────┐
│  TypeScript 编译时: Eden 推 controller response schema   │
│  ┌─────────────────────────────────────────────────┐    │
│  │ controller response: t.Object({items, total})    │    │
│  │ Eden 推: data = { items: T[]; total: number }    │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
                          ↓ 不同步
┌─────────────────────────────────────────────────────────┐
│  运行时: handler → afterHandle → mapResponse → TypeBox  │
│  ┌─────────────────────────────────────────────────┐    │
│  │ handler return { items, total }                  │    │
│  │ afterHandle 改成 envelope { code, message, data }│    │
│  │ TypeBox 验证 envelope 跟 response schema 不匹配  │    │
│  │ → 422 Validation Error                           │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## 11. 实际项目里的选择

我们 web 项目用的是 **.NET/Java 风格的"无统一 envelope"** 方案:

| 选择                                                  | 优                           | 劣                                               |
| ----------------------------------------------------- | ---------------------------- | ------------------------------------------------ |
| **不统一 envelope**(我们当前)                   | Eden 推得准,TypeBox 验证一致 | 前端每处自己解构(`data.items` / `data.data`) |
| **统一 envelope 写 response**(全 controller 改) | 前端统一`data.data.items`  | 每个 controller 都要写 envelope return,样板代码  |
| **统一 envelope 不写 response**                 | 代码少                       | 422 验证失败,**不可行**                    |

**当前选择**:

- controller 写 `response: t.Object({ items, total })`(plain)
- handler 直接 `return { items, total }`
- 前端 `const { data } = await rpc.api.products.get(); data?.items`

**错误响应统一**(单独的事):

- Elysia 2 错误响应是 `application/problem+json`:`{type, title, status, detail, ...}`
- 前端用 `extractErrorMessage(error.value)` 适配:从 `detail` / `title` / 状态码默认文案抽出 message
- 不改后端,纯前端工具函数解决 11 个 `Property 'message' does not exist` 错误

---

## 12. 推荐 hook 选择

| 需求                                | 用什么                                                              |
| ----------------------------------- | ------------------------------------------------------------------- |
| 改 response body(包装 / 字段映射)   | **`afterHandle`**(类型友好,return Route['response'])        |
| 改 status / headers / 注入 trace id | `mapResponse` 或 `set.headers / set.status` 在 afterHandle 里改 |
| 改 error 响应格式                   | `onError` (不是这 3 个之一)                                       |
| 记录 metrics / 清理资源             | `afterResponse`(只读)                                             |
| 改请求前参数(权限校验前)            | `beforeHandle`                                                    |
| 类型转换 / 字段重命名               | `transform`                                                       |
| 改 4xx/5xx 响应                     | `onError`                                                         |

---

## 13. 速查

```typescript
const app = new Elysia()
  // 1. 请求前
  .beforeHandle((ctx) => { /* 权限校验,return 抛错 */ })

  // 2. handler
  .get("/", { query: Schema, body: Schema, response: Schema }, ({ query, body }) => {
    return { items: [], total: 0 };  // 必须 match response schema
  })

  // 3. afterHandle - 改 body 主力
  .afterHandle((ctx) => {
    const v = ctx.responseValue;
    // ... 改 v
    return newV;  // 或不 return
  })

  // 4. mapResponse - 改 status / headers(也能改 body,但不推荐)
  .mapResponse((ctx) => {
    ctx.set.headers["x-trace-id"] = "...";
    return ctx.responseValue;
  })

  // 5. afterResponse - 只读,logging
  .afterResponse((ctx) => {
    console.log("done", ctx.responseValue);
  })

  // 6. onError - 改错误响应
  .onError(({ code, error, set }) => {
    if (code === "VALIDATION") return { message: "参数错误" };
  });
```

---

## 14. afterHandle 自动包装 envelope 的真相(关键!)

**常见错误尝试**: controller `response: plain` + `afterHandle` 改成 envelope

**实测 4 种组合**(跑 `apps/web/server/docs/eden-vs-afterhandle.ts`):

| 组合 | response | handler  | afterHandle | Eden 推  | 运行时   | 结果                                       |
| ---- | -------- | -------- | ----------- | -------- | -------- | ------------------------------------------ |
| A    | envelope | plain    | 改 envelope | -        | -        | **422** (handler 类型对不上)         |
| B    | envelope | envelope | 无          | envelope | envelope | ✅ 一致                                    |
| C    | plain    | plain    | 改 envelope | plain    | envelope | **422** (TypeBox 验证失败)+ 类型撒谎 |
| D    | plain    | plain    | 无          | plain    | plain    | ✅ 一致                                    |

**为什么 C 失败**(你想做的方案):

```
1. handler return { users: [...] }            ← plain
2. afterHandle 改成 { code, message, data }   ← envelope
3. TypeBox 验证: 拿改后的 body 跟 response schema 比
   response schema: { users: [...] }          ← 期望 plain
   实际 body:      { code, message, data }    ← 是 envelope
   → 不匹配 → 422
```

**Elysia 2 硬约束**: `afterHandle` 改的 body 必须**仍然 match `response` schema**。

- 改 status、headers、**添加新字段(扩展)** → 没问题
- 改**整个结构**(plain ↔ envelope) → 不行,会 422

**所以"afterHandle 自动包装 envelope"在 Elysia 2 + TypeBox 验证下做不到**。

**唯一可行方案**:`response` 写 envelope + handler 用一行 helper:

```ts
.get("/users", {
  response: PageResultSchema(UserTBSchema.Response),  // envelope
}, async ({ db }) => {
  const users = await service.list(db);
  return ok(users);  // helper: { code: 0, message: "ok", data: users }
})
```

`ok(data)` 一行 helper,不是大样板代码。但**不能完全省略 return 里的 wrapper**。

---

**TL;DR**:

- **`afterHandle` 改 body**
- **`mapResponse` 改 headers / status**
- **`afterResponse` 只读 logging**
- **Eden 推导只读 response schema,不管 hook 改了什么**
- **统一 envelope 的"自动包装"在 TypeBox 验证 + Eden 推导下做不到**——controller 写 envelope,handler 必须 return envelope
