# 设计体检报告：elysiax monorepo  2026-10-26（第二轮复查）· 2026-10-30 修复批更新

透镜组：全量五组（结构 1–9 / 过程 10–12 / 不确定 13–15 / 演化 16–18 / 语义 19–21，用户明确要求完整体检）。
被检范围：`packages/{core,cli,htmx,solid,flow,elysia}` 源码 + `apps/demo` 应用形态；排除 node_modules/dist/.git。
判据基线：仓库自身契约（原子页面分发、socket 唯一门、no-any、ServiceError、渲染器单选）+ 各卡数学判定式。
与上一轮关系：本轮按新 agent 定义（先判实例再判病、证据纪律、给不出证据降级数据不足）**独立重验**。结论：**6 处旧病灶全部仍在，代码未改动**（行号已逐一比对）；未检出新增病灶；上一轮"健/不适用/数据不足"判定本轮复核维持，仅一处数值修正（di.ts 的 as any 从 4 处降为 3 处）。

**2026-10-30 更新**：修复批已落地，逐卡复验：卡 5（A/B）、卡 6、卡 10、卡 14 **已修复**；卡 20 先加运行期构造拒绝、随后补上类型级可辨识联合，**已闭合**；卡 15 仍开（溢出语义需人体决策）。原始病灶描述与证据行号保留供追溯，每节末尾补「现状」段记录修复方式与验证点。另补路由表旁产物（`.elysiax/routes.table.json` + `elysiax routes`），为卡 7 的可达性审计提供数据面，并修掉 doctor 路由冲突检查在页面时代恒 0 条的假通过。

## 统计

修复批前：病 6 / 健 9 / 不适用 4 / 数据不足 2
修复批后：病 1（卡15，待人体决策）/ 已修复 5 / 健 9 / 不适用 4 / 数据不足 2（合计 21）

病占比 1/21 ≈ 5%。卡 20 已随第二批闭合：`PageEntry` 改为可辨识联合，非法组合在类型层写不出来。

## 病灶清单（按信息债/影响面排序）

### [病] 卡15 · 排队论 — SSE 推送队列无界【旧病灶，仍在】
- 病灶：`defineRealtime().stream()` 的每订阅推送队列无容量上限，慢消费者场景内存无界增长。
- 数学依据：Little 定律 L = λW。发布速率 λ 由 `rt.publish()` 驱动，消费速率受 TCP/浏览器排空速度约束；W 不可控时，无界队列 ⇒ L 无界 ⇒ 积压雪崩。判定式"存在无界队列 = 病"命中。
- 证据：`packages/core/src/realtime.ts:74-77`（`queue.push(d)` 无任何 cap，snapshot 亦整体入队）；排空只在 generator 循环里 `queue.shift()`；ReadableStream 默认内部队列同样无界（`:104` controller.enqueue 无背压处理）。
- 治疗方向：给每订阅队列加容量上限（溢出策略：丢弃最旧帧并发 `event: resync` 让客户端重拉快照，或断开让客户端重连走 snapshot）。溢出语义由人定，本卡不代改。
- **现状（2026-10-30）**：仍开。已加握手帧 + 先订阅后快照 + `idleTimeout` 修正（见 elysiax.mdx「实时推送」），但这只是首帧与空闲存活，**不改变队列无界**。溢出语义（丢最旧帧发 resync / 直接断开重连）是产品决策，选项与代价已整理成决策备忘：[SSE 推送队列的背压与溢出语义](./realtime-backpressure.md)，待拍板后实现。

### [已修复] 卡6 · 非法组合可写性 — socket 门禁只在手动 doctor 强制【2026-10-30 修复】
- 病灶：契约"跨原子 import 只能走 `<name>.socket.ts`"是约束谓词，但强制点仅在 `elysiax doctor`（手动命令）；`dev / gen / build` 路径（codegen）不拦，私拉电线写得出来、跑得起来。
- 数学依据：约束 A⇒¬B（跨原子 ⇒ 必须经插座）可构造出违反它的合法类型值（普通相对 import 在任何构建路径都合法）⇒ 约束未进强制层 = 病。
- 证据：强制逻辑在 `packages/cli/src/index.ts:864-946`（doctor 检查 4 插座门禁）；codegen 侧只校验 socket **存在性**（`packages/core/src/codegen.ts:431-439`），不校验引用方向；dev 轮询循环（`cli/src/index.ts:1290-1315`）只跑 codegen，不含门禁。
- 治疗方向：把插座门禁前移到 codegen（或 dev 轮询循环），让 dev/build 失败而非靠人记得跑 doctor；doctor 保留为全面体检。
- **现状（2026-10-30）**：判定逻辑抽到 `packages/core/src/socket-gate.ts`（`checkSocketGate`，导出 `stripComments`/`splitDeclarators`/`socketExports` 共用原语），**codegen 页面扫描前强制执行**：任一处违规即 `throw`，dev/gen/build/add 全部失败；doctor 改为共用同一实现（口径唯一，不再各写一份）。回归点：`packages/core/src/socket-gate.test.ts`（经插座合规 / 私拉电线 / 插座未导出符号 / 原子内相对 import 不算跨原子）。附带把 demo 跨原子组合视图改为经 socket 再导出，顺带暴露并修掉了「被插座再导出的 partials 引 `.elysiax` 桶文件 ⇒ 循环初始化」的坑。**插座纯度**（§3.1：不 `export default`、不导出实例）也一并前移到 codegen（`socketPurityViolations`，结果挂在 `SocketGateResult.purity`），doctor 只打印同一份判定。

### [已修复] 卡5 · 零点维度（两处，各欠 1 比特）【2026-10-30 修复】
- 病灶 A：`elysiax add` 的装配校验失败只 `logger.error`，进程仍以 0 退出。
  - 数学依据：下游（CI / 脚本 / 调用方 shell）需区分 n=2 种情况（装配通过 / 失败），上游产出（进程退出码）布尔维数 m=0；⌈log₂2⌉ = 1 > 0 ⇒ 病，信息债 1 比特 ≈ 调用方要补的"grep 日志猜成败" if 数。
  - 证据：`packages/cli/src/index.ts:728-735`（`catch` 里只 `logger.error('装配校验失败: ...')`，不 throw、不置退出码；`errorHandlerPlugin({ exitOnError: true })` 只兜未捕获异常，catch 住了就到不了）。
  - 治疗方向：装配失败时 throw（走既有 errorHandlerPlugin 非零退出），或显式在命令契约里声明"add 不担保装配"。
- 病灶 B：client 页编译管线探测静默吞错。
  - 数学依据：下游需区分 n=3 种情况（未装 @elysiax/solid / 装了且正常 / 装了但 import 炸），上游断言只有"包能否 import" m=1 比特；⌈log₂3⌉ = 2 > 1 ⇒ 病，信息债 1 比特。装了但坏（babel 依赖缺失等）被 `catch {}` 静默归入"未装"，产出走错管线而零日志。
  - 证据：`packages/core/src/codegen.ts:737-745`（`try { import(...) } catch { /* 应用未装 → 走 Bun 内置 JSX */ }`——注释把两种失败折叠成一种）。对比同文件 tailwind 分支（`:909-916`）编译失败有 warn，此处没有。
  - 治疗方向：catch 里区分 MODULE_NOT_FOUND（未装，合法静默）与其他错误（装了但坏，必须 warn/throw）。
- **现状（2026-10-30）**：A 已修——`elysiax add` 结尾改为跑 `codegen()`，装配失败直接抛出走 `errorHandlerPlugin` 非零退出，注释已写明「只打日志等于静默放行」。B 已修——探测拆成两步：`Bun.resolveSync("@elysiax/solid")` 失败（未装，合法静默）与 `import`/`solidPlugin()` 构造失败（装了但坏，自然抛出）不再折叠，注释标注「两种失败必须分开」。

### [已修复] 卡20 · ADT — PageEntry 非法组合可写且静默丢路由【2026-10-30 修复】
- 病灶：`PageEntry` 是积类型（各字段可选），"结构上可能但语义非法"的组合写得出来：`{ url, client: true }` 无 `shell`、或 `{ url }` 四件全空。前者在 `start()` 两个分支都不命中，该 URL 静默不进路由表（运行期 404，无任何报错）。
- 数学依据：合法类型值空间 ⊃ 语义合法空间，差集非空（至少上述两组合），且无构造期拒绝 ⇒ 病。
- 证据：`packages/core/src/pages.ts:59-72`（字段全可选）；`packages/core/src/start.ts:94-97`（`if (p.client && p.shell) … else if (p.page) …`，两者皆空时静默跳过）。codegen 目前总是成对生成 client+shell，但 `ElysiaxGenerated` 是公开入口（`start({ gen })` 手写 gen 合法），缺口真实可达。
- 治疗方向：把 PageEntry 改成可辨识联合（`{ client: true, shell } | { page, … } | { partials/actions only }`），make illegal states unrepresentable；或在 start() 对空条目 throw。
- **现状（2026-10-30）**：两步落地。（1）运行期：`start()` 曾对 `client` 缺 `shell`、对四件全空条目启动即抛；（2）类型级：`PageEntry` 改为可辨识联合——`ClientPageEntry`（`client: true` + `shell`，`page?: never`）/ `SsrPageEntry`（`page`，无 client/shell）/ `PartialPageEntry`（`partials` 必有）/ `ActionPageEntry`（`actions` 必有），非法组合在类型层写不出来。配套：codegen 在页面扫描期拒绝「同目录既有 `client/index` 又有整页 handler」（二者互斥，静默挑一个会让另一份成死代码），`start()` 的两个运行期 throw 因类型不可达而删除。回归点：`codegen.test.ts` 的「client 页同时有整页 handler：报错」。

### [已修复] 卡10 · 偏序/并发 — flow 画布多指针无 happens-before 保护【2026-10-30 修复】
- 病灶：第二根指针的 pointerdown 可直接覆盖进行中的拖拽/平移状态，无"已有捕获则拒绝"的顺序声明。
- 数学依据：并行事件源（pointerId A 拖拽中 ∩ pointerId B down）之间无显式偏序 ⇒ 竞争：B 覆盖 `panStart`/`dragStart` 后，A 的 pointermove 以 B 的起点为基准 ⇒ 画布/节点跳变。
- 证据：`packages/flow/src/index.tsx:258-276`（`onPanePointerDown` 不检查 `panStart` 非空即覆写）；`:349-357`（NodeShell `onDown` 同样不检查 `dragStart`）；`setPointerCapture(e.pointerId)` 按指针捕获但状态变量是单例。
- 治疗方向：进入拖拽/平移/拖线态时记录 owner pointerId，非 owner 的 down/move/up 一律早退（显式偏序：第一指针 ≺ 其余）。
- **现状（2026-10-30）**：三种交互态（平移 `panStart`、拖节点 `dragStart`、拖线 `connSource`）均记录 owner `pointerId`；已有 owner 时后续 `pointerdown` 早退，`move/up/cancel` 按 `pointerId` 比对（非 owner 不写状态）。`pointercancel` 只清自己拥有的状态，不会误清他指拖拽中的状态。偏序显式化为「首指针 ≺ 其余」，第二根手指不再扰动第一根。

### [已修复] 卡14 · 马尔可夫链 — desktop 启动等待循环存在吸收态【2026-10-30 修复】
- 病灶：desktop.gen 等待 server 就绪的 `for (;;)` 轮询，在"server 进程活着但永不就绪"（端口被占、handler 挂起但进程未退）时进入永久等待——吸收态，进去出不来，且零诊断输出。
- 数学依据：状态 {等待中, 就绪, server 死亡} 中，转移条件只有 `fetch ok`（→就绪）与 `exitCode !== null`（→server 死亡）；"活着但不就绪"无任何出边 ⇒ 吸收态 = 病。
- 证据：`packages/core/src/codegen.ts:955-962`（`for (;;) { try { if ((await fetch(...)).ok) break; } catch {} if (server.exitCode !== null) throw ...; await Bun.sleep(100); }`，无超时、无最大重试、无日志）。
- 治疗方向：加超时上限（如 30s）后带着 server 的 stderr 摘要 throw；或按指数退避并周期性打印等待状态。
- **现状（2026-10-30）**：desktop.gen 模板加 30s 截止时间，超时抛出「进程仍在运行但 / 无响应」并提示去看已继承的启动日志；状态图新增 {等待中} → {超时失败} 出边，吸收态消除。

## 健（各一行带过，本轮已复核）

- 卡1 连续性：新增原子 = 目录扫描自动发现 + CLI 脚手架单点；触及范围有界。
- 卡2 轴独立性：modules/ 与 pages/ 并存是文档明示的迁移期共存（codegen 对旧形态直接报错拒绝，`codegen.ts:314-318`），有废弃路径，非冗余绑定。
- 卡3 合并安全：页面组 page+partials+actions 的 join 在 codegen 有 URL 冲突校验（`codegen.ts:303-312`），冲突即炸不硬焊。
- 卡4 跨空间通信：core→htmx 接口只搬运 PageResult 品牌与 layout 签名；client/ 边界由 doctor 检查 3 强制，未夹带。
- 卡9 收敛：近期修复批 severity 单调不增（HIGH→MEDIUM→LOW，`5c38a65→2f4600d→2db5f3c`），b ≤ k 趋势成立。
- 卡11 状态机：realtime stream 的 wake/done 双变量已修复在案（cancel 先唤醒再 return）；flow 拖线态 connSource 在 up/cancel 路径清零，无停不下来的状态；CLI dev 轮询有 running 守卫防 codegen 并发写（`cli/src/index.ts:1288-1293`）。
- 卡13 概率/降级：SSE 心跳 + snapshot 首帧 + hasSubs 跳过无观众拉取，降级策略与风险匹配。
- 卡18 对偶：订阅即 snapshot（pull）+ 之后 publish（push），方向一致不混用。
- 卡19 Curry-Howard：DI 键经 services.gen 类型级推导；`as any` 全仓 3 处（均在 `di.ts:83,167,168`，Elysia 泛型边界，已批准保留清单范畴；较上轮 4 处减 1）。
- 卡21 SAT：约束集合（socket 存在性、route 唯一、表名前缀、迁移只追加）可满足且互不矛盾。注：`htmx/src/actions.ts:64` 的 `catch {}` 是窄意图（非 JSON 头则覆盖事件对象），非吞错，不计病。

## 不适用（附理由）

- 卡8 代价择优：无任何多选路/选址逻辑（构建 targets 是全部构建非择优）。
- 卡12 Petri 网：无多角色抢共享资源的并发结构（单进程事件总线，发布即遍历）。
- 卡16 版本代数：`version` 字段仅是元数据，无多版本共存/兼容判定需求（modules.lock.json 在 DESIGN.md 里但未实现，属未做而非做错）。
- 卡17 单调性：当前不在迭代重构过程中（与卡9 同源，见其判定）。

## 数据不足（缺什么、去哪补）

- 卡5 第三点疑似：htmx autoDetect 的 `isHtml` 启发式（`<` 开头 `>` 结尾，`packages/htmx/src/utils.ts:7-`）对"用户返回以 < 开头的 JSON/文本"的误判面——需统计应用侧 handler 实际返回值分布才能定 n，建议从 dockyard 真实页面抽样。
  - **抽样（2026-10-30）**：dockyard 全部 actions/partials 里唯一返回裸字符串的是 runtime.service 的中文提示（如「容器未运行（先部署）」），命中误判面 **0 例**；JSON 以 `{`/`"`/`[` 开头天然不命中。结论：启发式保留，误判面已由 `packages/htmx/src/handler.test.ts` 钉住（`<pending>` 这类形似文本仍判 HTML，属可接受误判）。
- 卡7 设计缺口：合法配置全集（PageEntry × auth × apiPrefix × layout 组合）无枚举工具，无法证伪"本该可达却不可达"的组合；如关心，可给 start() 加启动期路由表 dump 后再跑本卡。
  - **现状（2026-10-30）**：路由面已可导出审计——codegen 落 `.elysiax/routes.table.json`（kind/method/path/source，页面+client 壳+片段+actions+controller），`elysiax routes [--json]` 打印；demo 14 条、dockyard 66 条实测无冲突。顺带修掉 doctor 的一项**假通过**：旧冲突检查只扫 `modules/*.controller.tsx`，页面时代恒为 0 条也报「路由无冲突」，现改为读路由表、按「方法 + 归一化路径 + 源文件」判重。卡 7 的「配置组合枚举」仍缺，但路由可达面不再是黑盒。

## 收敛确认

本次非重构后复查；卡 9 判定见上（健）。修复批（2026-10-30）两批共 5 修：单批触及 core/cli/flow/demo 四包但改动性质同源（门禁前移 + owner 定序 + 退出码/超时补齐 + 可辨识联合），无新增病灶；下轮只重跑卡 9。卡 15 需人先定溢出语义，再进实现。
