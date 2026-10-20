# @elysiax/core

Bun + Elysia 2 + htmx（服务端 TSX）+ React 逃生舱的页面架构全栈框架。
一棵目录树 `src/pages/`，URL = 文件夹路径，DI 由 InferDI 容器装配。

## 一个页面长什么样

```
src/pages/<name>/
  <name>.page.tsx      # 整页（definePage → { title, content }）
  <name>.partials.tsx  # hx 片段子路由（defineRoutes，GET）
  <name>.actions.tsx   # 写端点子路由（POST/DELETE）
  <name>.di.ts         # 唯一事实源：服务声明
  client/index.tsx     # 可选：client 模式（整页 React，L5 逃生舱）
```

没有 `.page.tsx` 的文件夹 = 纯服务模块（无路由）。`.controller./.ui.` 旧约定已废除，codegen 检测到报错。

## 页面三件套

```tsx
// <name>.page.tsx
export default definePage(async ({ di }) => ({
  title: "服务器",
  content: <ServerList servers={await di.get("serverService").list()} />,
}));

// <name>.partials.tsx（挂载在 /api/<url>）
export default defineRoutes()
  .get("/:id/card", ({ di, params }) => <ServerCard ... />);

// <name>.actions.tsx
export default defineRoutes()
  .post("/", { body: form }, async ({ di, body, toast }) => {
    await di.get("serverService").create(body);
    toast("已添加");                       // HX-Trigger 头，壳脚本弹 toast
    return <ServerList servers={...} />;  // 写后片段刷新
  });
```

一端点两响应：无 `HX-Request` → AppLayout（`src/app.layout.tsx`，defineLayout）整页；有 → content 片段。校验失败自动 422 + 错误横幅片段。

## 声明服务：provide / lazy

```ts
export default defineModule({
  provides: {
    userRepository: provide(UserRepository, ["db"]),  // 值服务用字符串键
    userService: provide(UserService, [UserRepository, lazy(OrderService)]),
  },
});
```

- 键 = camelCase 类名；依赖写类引用，类型从构造函数签名推导
- InferDI 不支持双向 Lazy——跨上下文单向依赖，组合上移到页面/actions 层

## 错误处理：ServiceError

```ts
throw new ServiceError("用户名不能为空", 422);   // service 抛
return status(404, { error: "不存在" });          // actions 预期错误返回
```

框架统一映射：hx → statusCode + 横幅片段；普通 → JSON `{ error }`。actions 不写 try/catch 回显。

## 类型化路由（routes.gen.ts）

```tsx
hx-get={routes.pages.servers.ByIdCard(s.id)}
```

client 页（浏览器代码）必须直接引 `.elysiax/routes.gen`，不能引 `.elysiax` 桶文件（会把服务端图谱打进 bundle）。

## 实时推送：defineRealtime

```ts
export const rt = defineRealtime<MyEvent>();
.get("/events/:id", ({ params }) => rt.stream(`res:${params.id}`, () => snapshotOf(params.id)))
rt.publish(`res:${id}`, event);
rt.hasSubs(`res:${id}`);
```

## 测试

```ts
const di = createTestContainer(gen, { userRepository: new FakeRepo() });
```

## CLI（@elysiax/cli）

```sh
elysiax init [dir]         # 从模板创建项目
elysiax new page|service|client <name>  # 脚手架
elysiax dev                # codegen + bun --hot（结构变化自动重启）
elysiax gen / doctor       # 重生成 / 体检
elysiax build [--desktop]  # 编译二进制 / webview 桌面应用
```

## htmx JSX 类型

`hx-*` 属性类型由 `@workspace/htmx` 主入口自动引入（type-only），无需 `htmx.d.ts` 或 triple-slash 指令。
