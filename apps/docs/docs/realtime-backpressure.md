# SSE 推送队列的背压与溢出语义（决策备忘）

> 状态：**待人体决策**。本文只给事实、判定与选项，不代选。
> 来源：设计体检报告卡 15（`design-health-check-report.md`）。代码位置 `packages/core/src/realtime.ts`。

## 事实

`defineRealtime().stream()` 为每个订阅维护一个 `Item[]` 队列：

- `push()` 只做 `queue.push(d)`，无容量上限；心跳 `ping` 也走同一队列
- 排空只发生在 generator 循环里的 `queue.shift()`——消费速率 = TCP/浏览器排空速度
- 快照整体一次性入队（`queue = [...(await snap()), ...queue]`）
- `ReadableStream` 的 `controller.enqueue` 没有 `desiredSize` 反馈，下游再慢也不反压上游

## 判定

Little 定律 `L = λW`：发布速率 λ 由业务 `rt.publish()` 决定，驻留时间 W 由最慢的消费者决定。W 不可控时，无界队列 ⇒ L 无界 ⇒ 内存随「慢消费者存活时长」线性增长。判定式「存在无界队列 = 病」命中。

实际触发面：dockyard 画布的 SSE 每帧都很小（状态/阶段），正常消费者排空很快；风险主要来自**被挂起的连接**（笔记本合盖、移动网络黑洞、代理半开），此时浏览器不再读但连接未断，队列只增不减。

## 选项

### A. 有界队列 + 丢最旧 + `event: resync`（推荐起点）

- 队列容量默认 256（约 8 KB/帧 × 256 ≈ 2 MB 上界，可按需调）
- 溢出时丢弃最旧的非 ping 帧，置「脏」标记；排空后先发一帧 `event: resync` 再继续
- 客户端收到 `resync` 后重拉当前快照（dockyard `client/live.ts` 已在状态分支合并事件，补一条 resync → 重新 fetch targets 即可）

优点：不丢连接、不丢「最终一致性」，客户端已有 snapshot 通道可复用。
代价：需要客户端配合（不认识 resync 的客户端会静默停在旧状态——但现状本来就会无限积压，不会更好）。

### B. 有界队列 + 直接断开

- 溢出即 `done = true` 并关流，客户端退避重连，重连后走 snapshot 首帧

优点：服务端逻辑最简单，复用既有重连路径；无新事件类型。
代价：重连风暴（多客户端同时溢出时），且客户端需要指数退避（当前 `live.ts` 是否退避需确认）。

### C. 保持无界 + 只在监控上兜底

- 不加容量，靠 `rt.hasSubs()` 跳过无观众的拉取，配合进程内存告警

优点：零改动。代价：把可用性问题推迟给运维；慢消费者仍可拖垮进程。

## 若选 A / B 需要动的地方

1. `packages/core/src/realtime.ts`：队列容量与溢出策略（建议做成 `defineRealtime({ maxQueue, overflow })`，默认值取拍板结果）
2. `packages/core/src/realtime.test.ts`：慢消费者不读时队列不超过上限；溢出后 resync 帧位置正确；心跳不被饿死
3. dockyard `apps/dockyard/src/pages/canvas/client/live.ts`：处理 `resync`（重拉快照）或依赖断线重连
4. `apps/docs/docs/elysiax.mdx`「实时推送」：补溢出语义一句

## 待拍板

选 A 还是 B（还是先保持 C），以及容量默认值。定了之后实现是一小时量级。
