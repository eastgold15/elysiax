## Dockyard



## UI - shadcn-htmx

UI 组件优先用 shadcn-htmx（htmx v4 + Tailwind v4，flavour=html）。组件清单用 `bunx shadcn-htmx list` 现查，添加用 `bunx shadcn-htmx add <组件>`；registry 配置见 `shadcn-htmx.json`。





## 依赖优先原则
实现任何通用功能前，必须先检查是否有现成的成熟库可用：
1. 先查 package.json 已有依赖能否满足
2. 再评估 npm 上的主流包（周下载量、维护状态），优先用 Context7 查其文档
3. 只有确认现成方案不满足需求时才手写实现，并在回复中说明为什么不用现成库
通用功能包括但不限于：日期处理、校验、ID 生成、重试/限流、文件监听、CLI 解析、日志等。




不要让 htmx 和 React 操作同一个 DOM 元素。画布已是整页 client 模式（src/pages/canvas/client/），/canvas 由壳 HTMLBundle 服务、不走 htmx；htmx 页面（servers/projects）与 React 页天然隔离，不存在共享 DOM。client 代码依赖链禁 Node-only 包（dotenv/bun:sqlite → 浏览器打包 500）。

错误处理约定：services 抛 ServiceError（@elysiax/core），actions 不写 try/catch 回显；预期错误 return status(code, { error })。

进行测试，需要询问我