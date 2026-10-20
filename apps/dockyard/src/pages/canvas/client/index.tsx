/** @jsxImportSource react */
/** 画布 client 页入口（L5）：codegen 生成壳 HTML 引这个文件，挂载即全部 */
import { createRoot } from "react-dom/client";
import { App } from "./app";

createRoot(document.getElementById("root")!).render(<App />);
