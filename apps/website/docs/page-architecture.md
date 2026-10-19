# elysiax 页面架构约定

> 本文沉淀页面组织方式的设计结论。核心命题：**模块按页面划分，而非按功能划分**；前后端在一个模块内聚，模块可分发。

## 一、原子：页面

**原子 = 页面 = 一个 URL 可独立寻址的最小完整渲染单元。**

判定三条（第三条是试金石）：

1. **可寻址**：有自己的 URL。刷新浏览器、从外链进入，都能独立渲染出完整有意义的一屏。
2. **自包含**：打开这一个文件，能看懂这一页的数据从哪来（注入了哪些服务）、长什么样、有哪些交互。
3. **不可再分**：再往下拆出的东西（片段、组件）没有独立存在的意义——离开这个页面就是残缺的。

例：`/projects/:id/settings` 是原子（哪怕内容很少）；"部署抽屉"不是原子（没有独立 URL，离开画布页无意义）——它是所属页面的 partial。

## 二、文件路由：URL 层级 = 文件夹层级

```
src/pages/
├── projects/
│   ├── index.page.tsx          ← GET /projects
│   ├── [id].page.tsx           ← GET /projects/:id
│   └── [id]/
│       ├── deploy.page.tsx     ← GET /projects/:id/deploy
│       └── settings.page.tsx   ← GET /projects/:id/settings
└── servers.page.tsx            ← GET /servers
```

惯例：下划线前缀文件不参与路由（`_layout.tsx`、`_components.tsx`）。

### 核心纪律：目录是路由表，不是组件树

URL 有层级**不代表**逻辑有层级。`/projects/123/deploy` 和 `/projects/123/settings` 在 URL 上是兄弟，在逻辑上毫无关系。

**禁止"父页面"模型**（React Router 式嵌套路由：父层渲染壳 + 查数据 + 状态沿树下传）。原因：服务端渲染没有常驻运行时管理这棵树，刷新、外链、hx 片段每个入口都要手工重放"父→子"链条，复杂度全落在框架里。

做法：

- 每个 `.page.tsx` 是**独立整页**，各自渲染、各自取数
- 共享视觉段（如项目头部导航）→ 各自 `import` **无状态渲染组件**，最多一层 `_layout.tsx`，纯包裹、不传数据
- 取数重复（如两处都查项目）→ 各查各的；嫌重复就下沉服务层一行调用，不为它引入父子数据流

## 三、页面内部结构

```
pages/projects/[id]/deploy/
├── deploy.page.tsx      ← 整页（原子本体）
├── deploy.partials.tsx  ← 该页的 hx 片段（原子的部分，不可独立寻址）
├── deploy.actions.ts    ← 该页的写端点（可选，逻辑薄就直接写 page 里）
└── client/              ← 可选逃生舱：交互超标时整页升舱 React
```

嵌套深度纪律：**页面组装最多两层**（页面 → Section → Field 为止）。出现第三层 = 升舱 client/ 的信号。

片段与页面**同源**：hx 局部刷新 = 重新调用页面内的同一个 Section 函数，天然不重复。

## 四、逻辑复用：复用在服务层，不在 UI 层

页面里有两种逻辑，复用方式完全不同：

| 类型 | 例子 | 复用方式 |
|---|---|---|
| 领域逻辑（无 UI） | 部署前置检查、SSH 连接、镜像构建、共享变量解析 | 下沉为 InferDI provider（`*.di.ts`），页面注入调用 |
| 交互逻辑（有 UI 状态） | 表单校验、抽屉开合、轮询刷新 | **允许重复**，或极薄工具函数 |

跨原子复用只有两条合法通道：

1. **领域逻辑** → 服务层 provider
2. **纯渲染件** → `shared/ui/`（shadcn-htmx snippets + cn.ts），只允许无状态、无业务

**Rule of Three**：相似代码第三次出现才抽。前两次让它重复——页面级模块的价值就是"打开一个文件看懂一整页"，为消除两处相似而抽公共层会回到功能划分的老路。

## 五、两种 UI 模式（一页一栈，由页面自选）

| | htmx 模式（默认） | client 模式（逃生舱） |
|---|---|---|
| 适用 | CRUD、表单、列表 —— htmx 甜区 | 画布、终端、实时仪表盘等高交互页 |
| 渲染 | 服务端出整页 HTML + hx 片段 | controller 出 JSON + shell 页，React 整页接管 |
| 入口 | `*.page.tsx` | `client/index.tsx`（elysiax 构建时自动 bundle） |

**升舱信号**：某区域 hx 属性多到读不懂、或需要 htmx ↔ React 桥接时，**整个区域（或整页）迁 client/**，不要在 htmx 里硬撑第三层嵌套。

client 模式不破坏模块内聚：client/ 就在模块文件夹里，controller 还是这个模块的，分发时一起打包。elysiax 的叙事：**一个模块 = 路由 + DI + UI（两种渲染模式自选）+ 单二进制分发**。



elysiax 作为框架，可以加一条正式约定：

- 模块有 .ui.tsx → 走 htmx 服务端渲染（现状）
- 模块有 client/index.tsx → elysiax 构建时自动 bundle，controller 里用类似 html(shell) 挂载，路由内 fetch 同模块的 API
## 六、分发

- Web 与 exe（webview-bun 桌面包）对两种 UI 模式同等适用，是最后一步的可选项
- exe = Bun 单二进制 + 内嵌前端资源，与架构决策正交
