/** @jsxImportSource react */
/**
 * 容器交互式终端（Console Tab）：xterm.js ←→ WebSocket ←→ docker exec TTY（SSH 中继）。
 * 挂载点是 htmx 片段里的 <div data-console-target data-console-service>，
 * 由 island/index.tsx 发现并挂载/卸载。
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(
      `${proto}://${location.host}/api/deploy/console/${targetId}?svc=${encodeURIComponent(service ?? "")}`,
    );
    sock.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
    sock.onclose = () => term.write("\r\n\x1b[90m[连接已关闭]\x1b[0m\r\n");
    const send = (msg: unknown) => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
    };
    term.onData((d) => send({ type: "input", data: d }));
    sock.onopen = () => send({ type: "resize", cols: term.cols, rows: term.rows });

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
