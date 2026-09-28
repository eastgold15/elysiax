// hx-* 属性的 JSX 类型增强：在 .d.ts 里副作用导入 @kitajs/html 的 htmx 全局增强，
// 只进类型程序、不进运行时（绕开 @kitajs/html/htmx.js 的 DeprecationWarning）。
// index.ts 顶部用 /// <reference path="./htmx.d.ts" /> 引用本文件，
// 任何 import 过 @workspace/htmx 的项目自动获得 hx-* 类型，无需应用侧再配。
import "@kitajs/html/htmx.js";
