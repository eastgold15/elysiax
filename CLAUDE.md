# DDD 战略设计的核心模式
InferDI 不支持双向 Lazy 循环，我们采用限界上下文，一个词或一个概念，在哪个范围内有唯一、明确的含义。

画布这个场景，@kitajs/html 只适合做外围壳，核心交互必须交给客户端 React——画布已升舱为整页 client 模式（L5），htmx/React 不接触同一 DOM。

## 技术文档
- [页面架构 L0-L5](./apps/website/docs/page-architecture.md)
- [elysiax 框架概念](./apps/website/docs/elysiax.mdx)
- [dockyard 实战](./apps/website/docs/dockyard.mdx)
- [elysia2](./apps/website/docs/elysia2.0.md)
- [drizzle](./apps/website/docs/drizzle/)

## 思考必须中文
