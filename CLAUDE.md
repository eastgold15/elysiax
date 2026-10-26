# DDD 战略设计的核心模式
InferDI 不支持双向 Lazy 循环，我们采用限界上下文，一个词或一个概念，在哪个范围内有唯一、明确的含义。

画布这个场景，@kitajs/html 只适合做外围壳，核心交互必须交给客户端 Solid——画布已升舱为整页 client 模式（L5），htmx/Solid 不接触同一 DOM。

## 文档约束

文档统一放本仓库 `apps/docs/docs/`（blume 文档站），AI 读写文档都去这里，不散落在别处。
dockyard 的文档在 dockyard 仓库的 `apps/docs/docs/`，各放各的。

## 技术文档
- [页面架构 L0-L5](./apps/docs/docs/page-architecture.md)
- [elysiax 框架概念](./apps/docs/docs/elysiax.mdx)
- [elysia2](./apps/docs/docs/elysia2.0.md)
- [drizzle](./apps/docs/docs/drizzle/)

## 思考必须中文
