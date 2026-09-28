import { sse } from "elysia";

export interface RealtimeOptions<T> {
  /** 心跳间隔（SSE ping），默认 25s；0 关闭 */
  heartbeatMs?: number;
  /** 订阅建立时的首帧（如状态快照）：订阅即齐，不等下一轮推送 */
  snapshot?: (channel: string) => T[] | Promise<T[]>;
}

/**
 * 进程内事件总线 + SSE 流：服务端 publish，浏览器经路由 handler 订阅。
 * 频道是字符串（约定 `资源:id`，如 `project:3`），轮询器可用 hasSubs 跳过无观众的活。
 *
 * ```ts
 * // shared/realtime.ts
 * export const rt = defineRealtime<CanvasEvent>({
 *   snapshot: (ch) => ch.startsWith("project:") ? snapshotOf(+ch.slice(8)) : [],
 * });
 *
 * // controller
 * .get("/ui/:projectId/events", ({ params }) =>
 *   rt.stream(`project:${params.projectId}`))
 *
 * // service / poller
 * rt.publish(`project:${id}`, { type: "status", ... });
 * ```
 */
export function defineRealtime<T>(options: RealtimeOptions<T> = {}) {
  const subs = new Map<string, Set<(d: T) => void>>();
  const heartbeatMs = options.heartbeatMs ?? 25_000;

  const subscribe = (ch: string, fn: (d: T) => void): (() => void) => {
    const set = subs.get(ch) ?? new Set();
    set.add(fn);
    subs.set(ch, set);
    return () => {
      set.delete(fn);
    };
  };

  return {
    /** 向频道推送一条消息（无订阅者时是空操作，开销可忽略） */
    publish(ch: string, data: T): void {
      subs.get(ch)?.forEach((fn) => fn(data));
    },

    /** 频道是否有订阅者（轮询器据此跳过无观众的 SSH/HTTP 拉取） */
    hasSubs(ch: string): boolean {
      return (subs.get(ch)?.size ?? 0) > 0;
    },

    /** 命令式订阅（非 SSE 场景，如服务间联动）；返回退订函数 */
    subscribe,

    /**
     * Elysia 路由 handler：async generator → text/event-stream。
     * 推送式队列 + 心跳；客户端断开时（generator return）自动退订清心跳。
     * snapshot 可挂在总线上（options.snapshot）或按订阅传（依赖运行时参数时）。
     */
    stream: async function* (
      ch: string,
      snapshot?: () => T[] | Promise<T[]>,
    ) {
      type Item = T | "ping";
      const snap = snapshot ?? (options.snapshot ? () => options.snapshot!(ch) : undefined);
      const queue: Item[] = snap ? await snap() : [];
      let wake: (() => void) | null = null;
      const push = (d: Item) => {
        queue.push(d);
        wake?.();
      };
      const unsub = subscribe(ch, push);
      const hb = heartbeatMs > 0 ? setInterval(() => push("ping"), heartbeatMs) : null;
      try {
        while (true) {
          while (queue.length) {
            const item = queue.shift()!;
            yield item === "ping"
              ? sse({ event: "ping", data: "{}" })
              : sse({ event: "message", data: JSON.stringify(item) });
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      } finally {
        if (hb) clearInterval(hb);
        unsub();
      }
    },
  };
}
