# @elysiax/elysia

`@inferdi/elysia` 的本地移植版：上游面向 Elysia 1.x，在 Elysia 2.0 下直接崩
（`onError is not a function` 等 API 改名）。本包做了最小适配：

- 生命周期 API 改名（`.error` → `.onError`、`.afterResponse` → `.onAfterResponse` 等）
- 新的 Elysia 类泛型签名
- 结构化 RequestContext 替代 elysia 的 Context 导入

行为与上游一致：每请求一个 InferDI scope，cleanup 挂在响应后钩子上。
用法见 [InferDI 文档](https://inferdi.com/adapters/elysia)。

> 在 elysiax 应用里不直接用本包——`@elysiax/core` 的 `elysiaxAPI` 已内置装配，
> 页面/actions 通过 `di.get("...")` 消费容器。
