import { Glob } from "bun";
import { resolve } from "node:path";
import type { BunPlugin } from "bun";

export interface ModuleAggregatorOptions {
  /** 模块目录，默认 "modules"（相对 cwd） */
  dir?: string;
}

/**
 * 模块聚合插件：扫描 `<dir>/<name>/module.json`，把每个模块的
 * manifest / <name>.ui.html / <name>.controller.ts 聚合进 `modules.gen`。
 *
 * 注意：Bun 运行时只有「路径形态」的 specifier 会进插件的 onResolve，
 * `virtual:modules` 这类裸包名会被跳过。所以应用侧用真实占位文件
 * `src/modules.gen.ts` 作为导入目标，本插件在运行时/构建时把它替换成聚合产物。
 *
 * 用法（bunfig.toml: preload = ["./src/plugin.ts"]）：
 * ```ts
 * import { plugin } from "bun";
 * import { moduleAggregator } from "@elysiax/core/plugin";
 * plugin(moduleAggregator());
 * ```
 */
export function moduleAggregator(options: ModuleAggregatorOptions = {}): BunPlugin {
  const dir = options.dir ?? "modules";

  return {
    name: "elysiax-module-aggregator",
    setup(build) {
      build.onResolve({ filter: /modules\.gen$/ }, () => ({
        path: "modules.gen",
        namespace: "elysiax-module-aggregator",
      }));

      build.onLoad({ filter: /.*/, namespace: "elysiax-module-aggregator" }, async () => {
        const root = process.cwd();
        // Bun 的 Glob 只匹配文件，不匹配目录 —— 直接扫 module.json 作为模块发现依据
        const manifests: string[] = [];
        for await (const f of new Glob(`${dir}/*/module.json`).scan(".")) {
          manifests.push(f);
        }

        const imports: string[] = [];
        const exports: string[] = [];

        const suffixMap = {
          ui: ".ui.html",
          controller: ".controller.ts",
        } as const;

        for (const manifest of manifests) {
          const name = manifest.split("/")[1]!;
          const base = resolve(root, dir, name, name);
          const varName = name.replace(/-/g, "_");
          const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
          const entries: string[] = [];

          const manifestPath = resolve(root, manifest);
          imports.push(`import ${varName}_manifest from ${JSON.stringify(manifestPath)};`);
          entries.push(`    manifest: ${varName}_manifest,`);

          for (const [key, suffix] of Object.entries(suffixMap)) {
            const filePath = `${base}${suffix}`;
            if (await Bun.file(filePath).exists()) {
              const importName = `${varName}_${key}`;
              if (key === "controller") {
                // controller 约定为具名导出：export const xxxController = new Elysia(...)
                imports.push(
                  `import { ${camel}Controller as ${importName} } from ${JSON.stringify(filePath)};`,
                );
              } else {
                // .ui.html 按纯文本导入（Bun 默认会把 .html 当全栈页面对象）
                imports.push(
                  `import ${importName} from ${JSON.stringify(filePath)} with { type: "text" };`,
                );
              }
              entries.push(`    ${key}: ${importName},`);
            }
          }

          exports.push(`  ${varName}: {`, ...entries, `  },`);
        }

        const contents = `
${imports.join("\n")}

export const modules = {
${exports.join("\n")}
};
`;
        return { contents, loader: "js" };
      });
    },
  };
}
