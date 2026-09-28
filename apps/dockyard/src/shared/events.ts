/**
 * 进程内事件总线：画布实时状态的 SSE 上游。
 * 频道约定：`project:<projectId>`——部署状态迁移（deploy.service）与容器状态轮询（container-poller）
 * 往里推，SSE 端点（canvas.controller /ui/:projectId/events）订阅后推给浏览器。
 */
export type CanvasEvent =
  | { type: "status"; targetId: number; status: string }
  | { type: "running"; targetId: number; running: boolean }
  | { type: "state"; targetId: number; service: string; state: "running" | "exited" | "unknown" };

class EventBus {
  private subs = new Map<string, Set<(d: CanvasEvent) => void>>();

  subscribe(ch: string, fn: (d: CanvasEvent) => void): () => void {
    const set = this.subs.get(ch) ?? new Set();
    set.add(fn);
    this.subs.set(ch, set);
    return () => {
      set.delete(fn);
    };
  }

  emit(ch: string, data: CanvasEvent): void {
    this.subs.get(ch)?.forEach((fn) => fn(data));
  }

  /** 频道是否有订阅者（轮询器据此跳过无观众的 SSH） */
  hasSubs(ch: string): boolean {
    return (this.subs.get(ch)?.size ?? 0) > 0;
  }
}

export const events = new EventBus();
