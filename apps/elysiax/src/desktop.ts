import { Webview, SizeHint } from "webview-bun";

// server 用独立进程跑：webview.run() 是阻塞式 FFI 事件循环，
// 与 Bun 的 HTTP 事件循环不能同线程共存（Worker 里模块聚合插件不生效）。
// 开发时 spawn `bun src/index.ts`；编译后的单文件二进制则 spawn 自身 + --server。
if (process.argv.includes("--server")) {
  await import("./index");
} else {
  const isCompiled = !import.meta.path.endsWith(".ts");
  const server = Bun.spawn(
    isCompiled
      ? [process.execPath, "--server"]
      : [process.execPath, "src/index.ts"],
    { stdout: "inherit", stderr: "inherit" },
  );

  // 等 server 就绪再开窗
  for (;;) {
    try {
      if ((await fetch("http://localhost:3000/")).ok) break;
    } catch {}
    if (server.exitCode !== null) throw new Error("server 进程提前退出");
    await Bun.sleep(100);
  }

  const webview = new Webview(false, {
    width: 1100,
    height: 720,
    hint: SizeHint.NONE,
  });
  webview.title = "elysiax";
  webview.navigate("http://localhost:3000/");
  webview.run(); // 阻塞直到窗口关闭
  server.kill();
  process.exit(0);
}
