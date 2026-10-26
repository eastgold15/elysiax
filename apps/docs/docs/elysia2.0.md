# elysia2.0

```bash
# 自动迁移工具
bunx @elysia/codemod@latest

# 手动升级
bun add elysia@next
```

## TypeBox

框架内置 TypeBox 版本从0.34升级至1.3，迁移方案请查阅 TypeBox 1.0 迁移指南。

### 独立字段 Cookie 结构校验

现在支持为 Cookie 每个字段单独配置校验规则，不再需要整体定义：

```typescript
new Elysia()
    .get('/', {
        cookie: t.Object({
            a: t.Cookie(t.String(), {
                sign: true
            })
        })
    }, () => 'ok')
```

### t.Accelerate

基于标准JSON Schema将第三方校验结构转换为TypeBox编译器，实现性能最大化。

```typescript
import * as z from 'zod'

new Elysia()
    .post('/', {
        body: t.Accelerate(
            z.object({
                name: z.string()
            })
        )
    }, () => 'ok')
```

该API目前处于测试阶段，谨慎使用。

### Rain（引用抽象层）

框架没有直接重新导出 TypeBox，而是封装了一层轻量化抽象层，内部代号「Rain」。
真实业务场景中，并非所有校验结构都是独立存在的。路由参数、查询参数等结构经常重复复用。
很多基础结构写法如下：

```typescript
t.Object({
    name: t.String(),
    age: t.Number()
})
```

## 预先编译（Ahead of Time Compilation，AOT）

Elysia 内置编译器，会分析业务处理函数，生成最优路由执行代码。
这也是 Elysia 高性能的核心来源，但存在代价：编译在服务启动阶段执行，每条路由都需要编译，带来微小延迟。单次编译速度很快，但业务规模扩大后延迟会持续累积。

我们重构了内置编译器，支持将编译工作前移至构建阶段，也就是预先编译（AOT）。

```typescript
import { aot } from 'elysia/plugin/aot/bun'

const { outputs } = await Bun.build({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'bun',
    plugins: [aot('src/index.ts')]
})
```

你需要导出 Elysia 实例，配置构建脚本并将插件指向主服务实例。

AOT插件完整能力：

1. 编译业务处理代码
2. 编译TypeBox校验结构
3. 编译精确镜像结构
4. 预计算默认属性合并逻辑
5. 静态分析未使用的Elysia模块
6. 为不同目标平台生成优化代码
7. 如果所有TypeBox结构均可预编译，彻底移除TypeBox

启用后，插件会试运行应用，生成最精准的预编译产物。运行时框架直接使用预编译结构，完全跳过实时编译流程。

### 启动耗时

Elysia 1.4 需要在首次拉取请求时编译入口处理函数，第一条请求需要两次编译。
Elysia 2 彻底移除入口请求实时编译，将编译任务交由AOT处理，大幅优化启动耗时。

|版本|耗时|
|----|----|
|Elysia 1.4|0.851 ms|
|Elysia 2 + AOT|0.046 ms|

### 内存占用

测试项目包含十万条独立结构，采用即时编译模式对比：

|版本|启动耗时|内存占用|
|----|----|----|
|Elysia 2|4110 ms|1.65 GB|
|Elysia 2 + AOT|775 ms|400 MB|

### 合成内存基准测试

|版本|完全相同处理函数|独立处理函数（真实业务场景）|
|----|----|----|
|Elysia 1|32.1 KB/路由|36.9 KB/路由|
|Elysia 2（即时编译JIT）|2.3 KB/路由|5.8 KB/路由|
|Elysia 2 + AOT|4.6 KB/路由|4.7 KB/路由|

真实业务中几乎不会出现完全一致的处理函数，该场景仅作为合成基准测试参考。

### 部分默认值合并优化

Elysia 2 支持提前静态分配默认值，局部合并执行速度大幅提升。

|版本|耗时|
|----|----|
|Elysia 1.4|21.6 μs|
|Elysia 2|2.5 μs|

### 构建目标

构建插件不局限于Bun运行时，已完成适配与回归测试的打包工具：

- Bun.build
- vite
- esbuild
- rspack
- unplugin

对应插件可从 `elysia/plugin/aot/<打包工具名称>` 导入，使用方式和普通插件一致。

```typescript
import { aot } from 'elysia/plugin/aot/vite'

export default defineConfig({
    plugins: [aot('src/index.ts')]
})
```

Unplugin 同时兼容更多打包工具：rollup、rolldown、webpack、farm。

### 是否应当启用预先编译（AOT）？

条件允许的情况下推荐启用。
绝大多数项目开启AOT构建模式后都能获得显著收益。
AOT模式的成本：会将所有路由与结构代码内联写入最终产物。打包体积会小幅上升，应用启动常驻内存轻微增加，但峰值内存占用大幅下降。

### 构建环境注意事项

AOT插件会试运行你的应用，两点需要重点留意：

1. 长连接进程：例如Postgres连接池、Redis连接池。
这类进程会阻止构建环境正常退出，推荐打包完成后调用 `process.exit(0)`。

```typescript
Bun.build({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'bun',
    plugins: [aot('src/index.ts')]
}).then(() => {
    process.exit(0)
})
```

1. 环境分支判断
启用AOT的项目，构建阶段与运行阶段调用Elysia接口逻辑必须保持一致，否则会生成无效清单。
框架可以提前检测该问题，在服务启动前抛出提示并给出解决方案。

借助运行时标识，可以区分AOT试运行环境，选择性跳过部分业务逻辑：

```typescript
import { Manifest } from 'elysia'

if (Manifest.isCapturing())
    console.log('在AOT试运行阶段执行逻辑')
```

### Cloudflare Worker 使用建议

如果你使用 Cloudflare Worker，强烈建议开启AOT，避免每次冷启动承担编译耗时。
Cloudflare Worker 不支持动态创建函数，你只能选择启动时一次性完成全部编译，或者将编译前移至构建阶段。
官方本身推荐使用Vite插件打包后再发布Worker代码，只需要在Vite配置额外添加AOT插件即可。

```typescript
import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { aot } from 'elysia/plugin/vite'

export default defineConfig({
    plugins: [cloudflare(), aot('src/index.ts')]
})
```

## 适配器与运行时

Elysia 从诞生之初就采用和 Hono 一致的Web标准请求/响应对象。只要运行环境支持Web标准Request，Elysia就具备和Hono同等的跨平台能力。
对于不支持Web标准的运行环境，Elysia 提供适配器API，可在各类环境运行HTTP服务。

Elysia 的定位是「为Bun优化」，而非「仅能运行在Bun上」。尤其是底层基础设计和主打跨平台的Hono同源，一直都是如此。

### 第二代适配器

适配器完成重构，由内部私有接口改为公开可用。
旧版适配器会将代码序列化交给编译器，二次开发、社区贡献难度很高。
Elysia 2 中所有配置项均改为函数形式：

```typescript
import { createAdapter } from 'elysia/adapter'

const adapter = createAdapter({
    name: 'bangboo',
    response: {
        map: mapResponse
    },
    setup(app: Elysia) {
        // 在服务监听前执行Elysia相关逻辑
    },
    listen() {
        // 绑定运行时HTTP服务
    },
    // 其余配置...
})
```

全部配置具备完善类型提示，返回对象可自由修改、替换。

### Node 运行时

借助第二代适配器，Node适配器底层基于srvx与crossws实现。

```typescript
import { Elysia } from 'elysia'
import { node } from '@elysia/node'

new Elysia({ adapter: node() })
    .listen(3000)
```

srvx升级至0.12版本，配套FastResponse优化，性能大幅提升，接近原生Node HTTP库水平。

每秒请求数横向对比：

- Elysia Bun 2.0.0-exp.60：210411 req/s
- Hono Bun 4.12.28：168275 req/s
- Fastify Node 5.10.0：101360 req/s
- Elysia Node 2.0.0-exp.60：93845 req/s
- Hono Node 4.12.28：86129 req/s
- Effect HTTP Bun 4.0.0-beta.102：88936 req/s
- Effect HTTP Node 4.0.0-beta.102：59958 req/s
- Koa Node 3.2.1：43294 req/s
- Express Node 5.2.1：42974 req/s
- Adonis Node 5.8.0：36557 req/s
- Nest Node 10.2.8：31675 req/s
完整数据参考 HTTP Benchmark。

### Node WebSocket

WebSocket模块从Node适配器中拆分，减少默认打包体积。如需在Node环境使用WebSocket，从websocket子目录导入：

```typescript
import { Elysia } from 'elysia'
import { node } from '@elysia/node/websocket'

new Elysia({ adapter: node() })
    .listen(3000)
```

## 接口性能优化

HTTP吞吐、内存占用、启动速度不是唯一衡量标准。我们同样需要考虑真实业务场景，例如插件、生命周期钩子的性能。
下面是几组Elysia核心接口基准测试，源码存放路径：elysia/example/stress

### 新增十万条路由

循环添加十万条静态路由，统计执行耗时。测试文件：stress/route.ts

|版本|耗时|内存占用|
|----|----|----|
|Elysia 2|7 ms|31 MB|
|Elysia 1.4|23 ms|317 MB|
|Hono 4.12.32|172 ms|203 MB|

### 挂载十万个子路由实例

测试文件：stress/apply-plugin.ts
循环将十万个包含1条路由的Elysia实例挂载至主应用，统计耗时。

|版本|耗时|内存占用|
|----|----|----|
|Elysia 2|5 ms|9 MB|
|Elysia 1.4|116 ms|116 MB|
|Hono 4.12.32|192 ms|503 MB|

### 挂载十万个带钩子的插件

测试文件：stress/lifecycle.ts
循环挂载十万个带有生命周期事件的Elysia实例（作用域隔离插件），等效Hono中间件。

|版本|耗时|内存占用|
|----|----|----|
|Elysia 2|10 ms|15 MB|
|Elysia 1.4|58 ms|126 MB|
|Hono 4.12.32|252847 ms|21558 MB|

Hono数据真实无误。

## Defer（延迟执行）

支持手动注册回调函数，在响应发送完成后执行。

```typescript
new Elysia()
    .get(({ defer }) => {
        const disconnect = connect()

        // 响应发送完毕后执行
        defer(() => {
            disconnect()
        })
    })
```

defer 在 afterResponse 钩子队列之后执行。

## 破坏性变更

本次版本更新调整了部分API，移除多个标记为即将废弃的接口。
为降低迁移成本，我们提供 Elysia 代码转换工具，可自动完成95%代码迁移。

```bash
bunx @elysia/codemod@latest
```

### 路由参数顺序调整

我们发起调研，绝大多数开发者希望钩子、校验结构定义写在处理函数之前。

```typescript
new Elysia()
    .post('/', {
        isAdmin: true,
        body: t.Object({
            name: t.String()
        })
    }, () => {
        // 请求处理函数
    })
```

旧写法需要来回滚动查看路由、配置、处理函数，阅读体验较差。调整后代码阅读更加顺畅。
该改动可以通过codemod全自动迁移。

### @elysia 包命名空间

我们完成域名协商，获得 `@elysia` 包命名空间。
后续官方维护的适配Elysia1.4+插件统一发布至`@elysia`；旧版1.x插件继续保留在`@elysiajs`。

### 生命周期钩子移除 on 前缀

统一钩子与API命名规范，移除生命周期事件前缀`on`。

```typescript
new Elysia()
    .beforeHandle(() => {})
    .guard({
        beforeHandle() {}
    })
    .get('/', {
        beforeHandle() {}
    }, () => {})
```

大部分事件不需要额外标识为拦截器，例如derive、transform、afterResponse等。

新旧API完整对照：

|旧接口|新接口|
|----|----|
|onRequest|request|
|onParse|parse|
|onTransform|transform|
|onBeforeHandle|beforeHandle|
|onAfterHandle|afterHandle|
|onAfterResponse|afterResponse|
|onError|error|
|onStart|setup|
|onStop|cleanup|

### 错误处理API重构

旧版依靠`code`区分错误类型，存在三大痛点：

1. 冗余样板代码
想要注册自定义错误码，需要预先定义错误字典才能获得类型推断。未导入字典的上下文无法正确识别错误类型，同时存在循环依赖限制。
2. 原型污染
旧实现需要向错误类新增原型属性，用于匹配识别。
3. 类型推断局限
静态分析无法完整推导响应类型。

#### 全新错误API

彻底移除错误编码，直接传入错误类进行注册：

```typescript
new Elysia()
    .error(MyError, () => {
        // 错误处理逻辑
    })
```

新方案一次性解决全部旧问题，代码更加简洁，可以理解为专门处理错误场景的mapResponse。
框架能够自动推导路由返回类型，Eden客户端的错误处理表现力大幅提升。

使用框架内置错误（NotFound、ValidationError）示例：

```typescript
import { NotFound, ValidationError } from 'elysia'

new Elysia()
    .error(NotFound, () => {
    })
    .error(ValidationError, () => {
    })
```

#### 兜底错误捕获

对于无法静态识别的错误，使用 `instanceof` 判断：

```typescript
import { NotFound, ValidationError } from 'elysia'

new Elysia()
    .error(({ error }) => {
        if (error instanceof MyError)
            // 处理逻辑
    })
```

### RFC 9457 标准错误格式（Problem Error）

Elysia 采用 RFC 9457：问题详情规范描述错误信息。
所有错误不再返回纯文本，统一返回标准Problem JSON结构；响应头为 `application/problem+json`，而非 `application/json`。
推荐使用 `problem` 函数代替手动设置status，自动适配标准：

```typescript
import { Elysia, problem } from 'elysia'

new Elysia()
    .get('/', () => problem(418, {
        detail: 'I love teapot'
    }))
    .error(MyError, () => problem(418, {
        detail: 'I love teapot'
    }))
```

Eden客户端已经适配新头部与格式，其他前端客户端需要自行兼容。

### 返回错误与抛出错误行为统一

该特性长期困扰大量用户。现在无论是return抛出错误，还是throw抛出错误，都能被onError统一捕获。

### 移除 Macro 相关重载API

`.macro(name, definition)` 被移除。
该接口最初作为兼容resolve与schema的临时方案，相关缺陷现已修复，因此移除临时方案简化API。

```typescript
// Elysia 1.x 旧写法
new Elysia()
    .macro('auth', {
        resolve: ({ headers }) => ({ user: auth(headers) })
    })

// Elysia 2 标准写法
new Elysia()
    .macro({
        auth: {
            derive: ({ headers }) => ({ user: auth(headers) })
        }
    })
```

### WebSocket改为可选特性

WebSocket现在属于按需启用功能，API风格对齐`.get`、`.post`等常规路由：

```typescript
import { websocket } from 'elysia/websocket'

new Elysia()
    // 在应用任意位置只需要启用一次
    .use(websocket())
    .ws('/', ({ params: { id } }) => id)
    .ws('/stream', function* () {
        // 不再使用 ws.send(1)
        yield 1
        yield 2
        yield 3
    })
```

旧WebSocket接口参考Bun原生实现，但是我们认为开发者不需要了解Bun WebSocket底层接口即可开发。新版本替换为开发者更熟悉的Elysia风格API，拥有更好的类型推导。
借助生成器函数与yield，框架可以直接推导WebSocket返回类型，无需额外响应结构。

⚠️ 需要重点关注的改动：

1. `.ws()` 参数支持2~3个入参
2. 两参数形式 `.ws('/ws', 处理函数)`、`.ws('/ws', 配置项)` 保持不变
3. 三参数调整为 `.ws('/ws', 配置项, 处理函数)`
4. ws.data 直接挂载至上下文对象
5. 推荐使用生成器yield发送数据，类型安全性优于ws.send

### resolve 重命名为 derive

很多开发者混淆resolve与derive的使用场景。
经梳理，绝大多数场景需要在beforeHandle阶段执行逻辑，对应旧版resolve。

- derive：在beforeHandle阶段执行（原resolve行为）
- resolve：接口彻底移除

```typescript
// 1.x
app.resolve(({ headers }) => ({ user: auth(headers) }))

// 2.0
app.derive(({ headers }) => ({ user: auth(headers) }))
```

### scoped 作用域重命名为 plugin

- 移除 `{ as: 'scope' }` 对象写法
- `.decorate()` / `.state()` 支持 `{ as: 'append' | 'override' }`

```typescript
// 1.x
app.beforeHandle({ as: 'scoped' }, fn)
app.guard({ as: 'scoped' }, fn)
app.decorate({ as: 'override' }, 'db', db)

// 2.0
app.beforeHandle('plugin', fn)
app.guard('plugin', fn)
app.decorate('override', 'db', db)
```

### guard / group 默认行为改为覆盖

所有`.guard()`、`.group()`默认采用覆盖策略。

- 路由越近，优先级越高，就近结构覆盖继承结构
- 如果需要独立结构，必须显式声明 `schema: 'standalone'`

```typescript
// 1.x：字符串作用域形式隐式独立（累加）
app.guard({ body: t.Object({ a: t.String() }) })

// 2.0：默认覆盖；就近结构优先
app.guard({ schema: 'standalone', body: t.Object({ a: t.String() }) })
```

### 移除 aot: false

动态编译模式完全删除，统一使用AOT模式。

### 默认移除 file-type

Elysia 2 默认不再内置 file-type 包用于识别文件MIME类型。
该模块仅搭配`t.File`、`t.Files`指定类型时使用；不使用文件校验的项目无需携带该依赖。
如需启用，手动注册文件类型检测器：

```typescript
import { setFileTypeDetector } from 'elysia'
import { fileTypeFromFile } from 'file-type'

setFileTypeDetector(fileTypeFromFile)
```

## 稳定性

单元测试规模大幅扩充，断言数量从2800条提升至10000条以上。
每次提交、合并请求都会自动执行性能、内存检测与打包体积硬性校验，监控性能退化。

### 其他变更

更多不影响大多数业务的内部微调，详见迁移指南。

### 行为变更

- context.path 设置为只读
- 校验错误 payload.expected 对象共享且深度冻结
- 结构首次注册时克隆，后续依靠引用复用
- 签名Cookie校验默认策略调整为 verify: 'lazy'
- 钩子提前返回的值会经过mapResponse处理后发送
- parse()、transform()实例层无法继承任何守卫输入结构，上下文类型为原始未校验值（实例前缀路由参数保留）
- afterHandle 提前返回时，终止后续执行
- Error.summary 默认使用TypeBox内置提示文本
- Error.summary 支持标准Schema
- 校验器执行顺序标准化：Convert → Check → DecodeUnsafe
- streamResponse（适配器工具）直接输出原始响应分片
- 不带请求体的GET/HEAD路由，解析生命周期钩子不再执行
- 默认422校验错误响应做内容截断；请求JSON超过4KB时不再完整回显
- 仅静态路由注册至Bun.serve路由表
- 存在error钩子时，不再禁用Bun原生静态路由分发
- 路由结构、mapResponse钩子会正确进入JS处理链路，不再直接由Bun原生路由无校验返回
- 生产环境下，未捕获错误不会向客户端暴露错误消息
- 抛出/返回通用Error、状态码≥500且未自定义响应时，统一返回「服务器内部错误」，保障安全
- 生产环境下，映射错误响应不再携带cause字段，message统一替换为内部错误提示；非生产环境输出不变
- file()响应依据大小写不敏感的文件后缀匹配content-type
- 同步标准Schema校验器不会强制路由转为异步模式
- 路由构建阶段，不会在主Elysia实例长期持有Bun原生静态路由对象

### 功能优化

- t.File({ type }) / t.Files({ type }) 文件类型识别失败时，输出准确字段路径，不再为空路径
- 第二代适配器
- 子类型校验器
- 校验器全局缓存
- 结构引用复用
- Cookie独立字段校验
- 无type参数的t.File()/t.Files()不再强制启用异步校验流程

### Bug修复

- 无法识别Content-Type时，返回415状态码
- socket请求与app.handle()场景，context.server正确绑定活跃Bun服务实例，不再为空
- Node/Web标准适配器，纯字符串响应自动设置Content-Type: text/plain
- Cookie值二次URL解码问题被修复，避免内容失真
- .compile()覆盖WebSocket升级处理器，导致连接失败的问题修复
- normalize: false时默认对象引用共享，请求之间数据互相污染问题修复
- 无200响应结构的独立Schema抛出未定义异常
- strictPath: false模式下，动态路由无法匹配末尾斜杠
- loosePath模式下，/decoded-path缓存无限膨胀，可被恶意请求利用
- FileBlob返回时触发TypeError报错
- 非Bun运行环境，二次流式返回Response时丢失头部
- Bun原生静态路由不会跳过wrap高阶组件
- 非Bun环境下，签名Cookie HMAC比较使用非恒定时间===，存在时序侧信道风险
- 密钥轮换场景，null（允许无签名）配置项包含小数点时报错
- application/xml请求被错误解析为表单编码
- Sucrose：上下文可选链ctx?.query无法正确推导字段类型
- 查询数组解析时，非法JSON触发可控500错误
- 全部静态响应同步时，Bun原生静态路由不会注册
- 错误代码生成声明未定义变量，污染全局this
- 无请求体结构路由优先判断是否存在body，优化分块请求头部处理逻辑

## Elysia 2 可以带来什么预期效果

Elysia 2 不一定能带来吞吐量的大幅提升。
它为Elysia搭建更稳固的底层基座，支撑现有与未来所有功能，目标不止追求单纯的吞吐性能。
你最直观感受到的优化是：峰值内存占用下降、启动速度提升，Cloudflare Worker这类无服务器环境收益尤为明显。
虽然本次版本重构带来大量破坏性变更，升级过程略显繁琐，但后续Elysia迭代体验会更加稳定完善。

## 是否升级至 Elysia 2 Beta？

Elysia 2 在合成基准场景经过充分测试，我们内部多个业务服务已经部署，未出现严重故障。
代码迁移工具覆盖绝大多数场景，我们已经使用它完成全部官方插件迁移，覆盖率约95%，迁移成本很低。

```bash
bunx @elysia/codemod@latest
```

标记Beta版本，主要是为插件开发者留出适配过渡期。
以我们内部的使用情况来看，稳定性足以部署正式业务。但由于是完整重构，相比旧版本可能存在细微行为差异，整体稳定性优于以往任何一个Beta版本。
待大部分社区插件完成适配后，我们将移除Beta标签。
