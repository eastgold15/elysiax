/** @jsxImportSource react */
/**
 * 容器交互式终端（Console Tab）：xterm.js ←→ WebSocket ←→ docker exec TTY（SSH 中继）。
 * client 模式下直接挂在 ServiceDrawer 的 Console Tab 里，组件卸载即断开。
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "./api";

export function ConsoleView({ targetId, service }: { targetId: number; service?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: "#0b0f14" },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    // Eden Treaty WS：路径/params/query 类型安全（协议 ws/wss 由 treaty 自动推导）
    const sock = api.console({ id: targetId }).subscribe({ query: { svc: service || undefined } });
    sock.on("message", ({ data }) => term.write(typeof data === "string" ? data : ""));
    sock.on("close", () => term.write("\r\n\x1b[90m[连接已关闭]\x1b[0m\r\n"));
    const send = (msg: { type: string } & Record<string, unknown>) => sock.send(msg);
    term.onData((d) => send({ type: "input", data: d }));
    sock.on("open", () => send({ type: "resize", cols: term.cols, rows: term.rows }));

    const ro = new ResizeObserver(() => {
      fit.fit();
      send({ type: "resize", cols: term.cols, rows: term.rows });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      sock.close();
      term.dispose();
    };
  }, [targetId, service]);

  return <div ref={ref} className="h-full w-full" />;
}
