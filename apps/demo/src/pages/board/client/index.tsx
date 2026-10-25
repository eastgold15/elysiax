/** @jsxImportSource solid-js */
/** 看板 client 页入口（L5）：codegen 生成壳 HTML 引这个文件，挂载即全部。
 *  Solid 版：render 挂载真实 DOM，无 VDOM、无 hydration。 */
import { render } from "solid-js/web";
import { App } from "./app";

render(() => <App />, document.getElementById("root")!);
