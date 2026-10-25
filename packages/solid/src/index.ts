/**
 * @elysiax/solid：elysiax 框架自造的 Solid 构建插件。
 *
 * 职责：把 client 原子的 .tsx（Solid JSX）经 babel-preset-solid 编译成
 * 纯 JS（template 克隆 + insert 响应式绑定），交给 Bun.build 打包成
 * 落盘产物 .elysiax/shells/<slug>.client.js。
 *
 * 设计约定（见 docs/lowering.md 逐级降级哲学）：
 * - babel 三件套是本包的内部实现细节，应用侧零配置、无感知；
 * - 将来换内核（手写 transform / Bun 原生支持 Solid）只动本包，应用零改动；
 * - core 只按包名探测本包存在与否，不认识 Solid 的任何细节。
 *
 * Babel 8 注意：preset-typescript 已删除 isTSX/allExtensions，
 * JSX 解析必须显式挂 @babel/plugin-syntax-jsx。
 */
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import syntaxJsx from "@babel/plugin-syntax-jsx";
import solidPreset from "babel-preset-solid";

export function solidPlugin(): Bun.BunPlugin {
  return {
    name: "elysiax-solid",
    setup(build) {
      build.onLoad({ filter: /\.tsx$/ }, async (args) => {
        const code = await Bun.file(args.path).text();
        const out = await transformAsync(code, {
          filename: args.path,
          presets: [
            [solidPreset as never, { generate: "dom" }],
            [tsPreset as never, {}],
          ],
          plugins: [syntaxJsx as never],
        });
        return { contents: out?.code ?? "", loader: "js" };
      });
    },
  };
}
