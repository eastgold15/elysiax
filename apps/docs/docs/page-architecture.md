# elysiax 页面架构约定

> 核心命题：**模块按页面划分，而非按功能划分**。层与层之间单向依赖、同层零耦合；任何一层可整体替换而不波及其他层。

## 〇、分层总览

六个层，每层一句话定义，依赖只能向下：

```
L0 路由层   文件即路由：URL ↔ 页面文件的映射，无代码
L1 页面层   原子：一个 URL 的完整渲染单元
L2 片段层   partial：属于且只属于一个页面的局部渲染函数
L3 服务层   领域逻辑：DI provider，无 UI
L4 渲染件层 shared/ui：无状态、无业务的纯渲染函数
L5 client层 页面内逃生舱：整页 Solid client，仅交互超标时存在
```

**依赖规则（写死）：**

- 只允许向下依赖：L1 → L3/L4；L2 → L3/L4；L5 → 本页面的 JSON 端点
- **同层之间禁止 import**：page 不 import 别的 page；partial 不 import 别的页面的 partial；service 之间只通过 DI 注入协作，不直接 import 实现
- 跨层反向禁止：service 不知道 page 的存在；shared/ui 不知道任何业务

满足这三条，任何一层都可整体替换：换掉某个 service 的实现（DI 换绑定）、把某页从 htmx 升舱 client、重写 shared/ui 组件库——其他层不动。

## 一、L1 原子：页面

**原子 = 页面 = 一个 URL 可独立寻址的最小完整渲染单元。**

判定三条（第三条是试金石）：

1. **可寻址**：有自己的 URL。刷新、外链进入，都能独立渲染出完整一屏。
2. **自包含**：打开这一个文件，能看懂这页的数据从哪来、长什么样、有哪些交互。
3. **不可再分**：再拆出的东西离开这页就是残缺的。

例：`/projects/:id/settings` 是原子；"部署抽屉"不是原子（无独立 URL）——它是所属页面的 L2 partial。

**宁可 URL 变长，也不让页面产生关系。** 两个页面视觉再像，也是两份独立代码；需要更长更具体的 URL 来表达一个独立页面时就用长 URL（如 `/projects/:id/env/shared`），不为省字符合并页面或造父子关系。

## 二、L0 文件路由

URL 层级 = 文件夹层级：

```
src/pages/
├── projects/
│   ├── index.page.tsx          ← GET /projects
│   └── [id]/
│       ├── deploy.page.tsx     ← GET /projects/:id/deploy
│       └── settings.page.tsx   ← GET /projects/:id/settings
└── servers.page.tsx            ← GET /servers
```

**目录是路由表，不是组件树。** 文件夹层级只表达 URL，不表达任何组合、继承、数据流关系：

- 没有"父页面"：每个 `.page.tsx` 是独立整页，各自渲染、各自取数
- **允许且只允许一个全局壳** `AppLayout`：全站唯一的外框（`<html><head>`、导航栏、页脚、主题），每页显式包裹。准入条件：纯视觉边框，不查业务数据、不感知 URL 属于哪个模块
- **导航归壳，不归任何业务页面**：侧边栏/顶栏是跨页面长驻的 chrome，没有自己的 URL，不属于任何业务上下文。壳准入三条：
  1. 壳可以放静态导航链接（`<a href>` 是纯视觉，不违规）
  2. 导航需要动态数据时（「部署中 ●3」badge、在线数），壳只留挂载点（`<span hx-get="/api/servers/nav-badge" hx-trigger="load, every 30s">`），片段端点由对应业务页面的 partials 提供——数据 ownership 仍在业务模块，壳不越界查库
  3. 壳永不 import 业务 service
- **根 URL `/` 也是页面**：`src/pages/index.page.tsx`，职责是门户。无跨模块聚合需求时handler 直接返回 `Response` 重定向（definePage 透传 Response）；做真 dashboard 时数据走各业务 partials 的挂载点，不造聚合 service 层
- **禁止目录级布局**（不设 `_layout.tsx`）：只覆盖部分页面的"中间层布局"必然带业务语义（查当前项目、管 Tab 高亮），是事实上的父页面。兄弟页面的公共段（如项目头部）→ 各自 import L4 渲染件自己拼，布局相同是视觉巧合，不是结构关系
- 下划线前缀文件不参与路由（`_utils.ts` 等本页面私有辅助）

**禁止嵌套路由模型**（父层渲染壳 + 查数据 + 状态下传）：服务端渲染没有常驻运行时管理树，刷新、外链、hx 片段每个入口都要重放"父→子"链条，复杂度全落在框架里。

## 三、页面文件内部

```
pages/projects/[id]/deploy/
├── deploy.page.tsx      ← L1 整页（原子本体）
├── deploy.partials.tsx  ← L2 该页的 hx 片段
├── deploy.actions.ts    ← 该页写端点（可选，逻辑薄就写进 page）
└── client/              ← L5 可选逃生舱
```

- 页面组装最多两层（页面 → Section → Field）。出现第三层 = 升舱 L5 的信号
- 片段与页面**同源**：hx 局部刷新 = 重新调用本文件的同一个 Section 函数
- 页面私有的东西（Section、常量、类型）写在本文件或同目录，**不进 shared/**

## 四、L3 服务层：唯一的逻辑复用通道

| 逻辑类型 | 例子 | 去处 |
|---|---|---|
| 领域逻辑（无 UI） | 部署检查、SSH、镜像构建、变量解析 | DI provider（`*.di.ts`），页面注入 |
| 交互逻辑（有 UI 状态） | 表单校验、抽屉开合、轮询 | 留在页面里，**允许重复** |

- 复用发生在服务层，不在 UI 层。两页都要"部署"→ 调同一个 `DeployService`；两页表单再像 → 各写各的
- service 之间协作只走 DI 注入（类引用依赖），不 import 对方实现
- **Rule of Three**：相似代码第三次出现才下沉；前两次让它重复

## 五、L4 渲染件层

`shared/ui/`（shadcn-htmx snippets + cn.ts）。准入条件：**无状态、无业务、无路由感知**——给它 props 出 HTML，仅此而已。任何带业务语义的组件不许进这层（带业务语义 = 它知道自己渲染的是"项目"还是"服务器"）。

## 六、L5 client 逃生舱

当某页 hx 属性多到读不懂、或出现 htmx ↔ client 桥接需求时，**整页升舱**为 Solid client 页（渲染器单选，见 module-contract §1.3），不在 htmx 里硬撑：

- `client/index.tsx` 为入口，elysiax 构建时自动 bundle
- controller 变为：出 JSON API + 一个 shell 页（`<div id="root">` + script 标签）
- client/ 物理上仍在页面文件夹内，模块内聚不变
- 升舱只改本页面目录，L3 服务、路由结构、其他页面零改动——这是单向依赖换来的可替换性

## 七、请求与交互约定

前面六章定义"代码放哪"，本章定义"请求怎么走"。

### 7.1 一个端点，两种响应

页面端点同时服务整页和片段：用 `HX-Request` 头区分——

- 普通请求 → 返回整页（`AppLayout` + 内容）
- hx 请求 → 只返回被请求区域的 L2 片段函数

判定逻辑由 elysiax 的 `html()` 统一处理，页面函数本身**只写一份渲染代码**，不手动 if/else——这是"片段与页面同源"在协议层的落地。

### 7.2 写操作三态

L1 的写端点（POST/PUT/DELETE）只有三种合法返回：

| 结果 | 普通表单 | hx 请求 |
|---|---|---|
| 成功 | 303 redirect 到目标页（PRG） | 返回更新后的片段，或 `HX-Redirect` 整页跳转 |
| 校验失败 | 重渲染整页，表单带错误回显 | 只返回表单片段（含错误），状态码 422 |
| 需要提示 | — | `HX-Trigger` 头携带 toast 事件，全局壳统一弹 |

**禁止**返回 200 + 空白、禁止前端拼跳转 URL。

### 7.3 页面三态：加载 / 空 / 错误

- **加载态**：首屏由服务端同步渲染，无 loading；hx 交互的加载指示用 `hx-indicator`，样式归 L4
- **空态**：每个列表/数据区域必须有空态分支，写在 L2 片段里（片段同源，空态自然被 hx 刷新复用）
- **错误态**：service 抛 `ServiceError`（带 statusCode）→ 框架统一映射（hx → statusCode + 错误横幅片段；普通 → JSON `{ error }`），端点不写 try/catch 回显，预期错误 `return status(422, { error })`；hx 请求失败（5xx/断网）→ 全局壳监听 `htmx:responseError` 弹 toast，页面不各自处理

### 7.4 URL 是唯一状态源

分页、筛选、排序、搜索词、Tab 切换——**全部进 URL query**，hx 交互带 `hx-push-url`。禁止把这类状态藏在前端内存里。收益：刷新、分享链接、浏览器后退全部免费正确。

### 7.5 认证与守卫

- 守卫挂在 L0 路由注册处（按目录前缀声明公开/受保护），页面函数**假设已登录**，不写鉴权 if
- 普通请求未登录 → 302 登录页；hx 请求未登录 → 401 + `HX-Redirect` 头（htmx 对 302 只会在局部区域跳转，必须特殊处理，这是 htmx 经典坑）

### 7.6 零星 JS 的界限

htmx 页面允许极少量"启动型"脚本（如初始化 xterm、复制按钮），约定：

- 必须是**一次性初始化**，不持有状态、不做数据流
- 写在页面文件内的 `<script>` 或公共 `app.js`，体量超过 ~50 行 = 升舱 L5 信号
- 需要 JS 与 htmx 互相调用（桥）= 直接升舱，不协商

### 7.7 meta 与 title

页面函数返回 `{ title, meta }`，`AppLayout` 消费。页面不直接操作 `<head>`。

## 八、凹凸插座：跨原子契约

垂直切片砍断了上下分层，但原子之间还有**左右连线**（跨原子依赖：画布要查服务器、部署要查画布）。砍断的线两头各留半个接口——一凸一凹，插头插座：

- **凹（插座）**：概念的所有者，放一个显式文件 `<name>.socket.ts`，集中 re-export 对外承诺——表锚点、行类型、服务类。**无承诺不开插座**：没有别人要用的东西，就不建这个文件。
- **凸（插头）**：引用方在自己的 di 里声明依赖，并且 import 只指向对方的 socket 文件。数据库物理外键（`.references(() => socket表.id)`）是插头的正当形态——外键就是"我的表插进你的表"。

三条机械规则（`elysiax doctor` 插座门禁强制第 1 条）：

1. 跨原子 import 只允许指向对方的 `<name>.socket.ts`——否则就是私拉电线（type import 也算）。
2. di 依赖必须经插座引入，不允许穿透到对方的 repository / 内部文件。
3. 无承诺不开插座。

豁免：`shared/` 基建（ui / paths / crypto / env-text / db 连接）无业务语义，任意 import。

**数据层随原子走**：每个原子自带 `schema.ts`（自己的表）与 `migrations.ts`（自己的 journal 片段）；db 连接由 infra 统一提供——"连接是电，schema 是家具"。`shared/db.ts` 聚合全部片段按 timestamp 稳定排序、重排连续序号后重放。

## 九、原子嵌套

- **身份证判定**：文件夹里有 `<name>.di.ts` 或 `<name>.socket.ts`，它才是原子；否则只是所属原子的内部抽屉（如 `client/`）。
- **嵌套 = 归属**：拷父带子；子原子也可单飞复制。父子之间**无特权**——父 import 子也走子的 socket。
- **层数按需**：一个弹窗也可以是原子（partials + actions + di + socket，无 schema 也行）；约定深度两层，再深先质疑拆分。

## 十、分发

Web 与 exe（webview-bun）对两种 UI 模式同等适用，是与本架构正交的最后一步：Bun 单二进制 + 内嵌前端资源。
