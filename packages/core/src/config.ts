import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** elysiax.config.ts 的形态（ Electrobun 风格：声明要什么，CLI 负责怎么做） */
export interface ElysiaxConfig {
  app?: {
    name?: string;
    version?: string;
    /** 打包元数据用的标识，如 dev.example.my-app */
    identifier?: string;
  };
  /** 模块目录（相对项目根），默认 "src/modules" */
  modules?: string;
  /** API 挂载前缀（start() 与 routes.gen 用），默认 "/api" */
  apiPrefix?: string;
  build?: {
    /** server 入口，默认 "src/index.ts" */
    entry?: string;
    outdir?: string; // 默认 "dist"
    /** server 二进制目标；桌面目标见 desktop + elysiax build --desktop */
    targets?: readonly ("linux-x64" | "windows-x64")[];
  };
  /** 存在即启用桌面应用（webview 窗口）；desktop.gen.ts 由 codegen 生成 */
  desktop?: {
    title?: string;
    width?: number;
    height?: number;
    /** 本地 server 端口（webview 等待与导航用），默认 3000 */
    port?: number;
    /** 256x256 PNG（Windows 的 .ico 由 CLI 现场转换，无需外部工具） */
    icon?: string;
  };
  package?: {
    linux?: {
      /** 生成 PKGBUILD + .desktop + 图标到 outdir/packaging/ */
      pkgbuild?: boolean;
    };
  };
}

export const DEFAULTS = {
  modules: "src/modules",
  entry: "src/index.ts",
  outdir: "dist",
} as const;

export function defineConfig(config: ElysiaxConfig): ElysiaxConfig {
  return config;
}

/** 加载项目根目录的 elysiax.config.ts；没有则返回空配置（全走默认） */
export async function loadConfig(root = process.cwd()): Promise<ElysiaxConfig> {
  for (const ext of ["ts", "js"]) {
    const p = join(root, `elysiax.config.${ext}`);
    if (await Bun.file(p).exists()) {
      return (await import(pathToFileURL(p).href)).default ?? {};
    }
  }
  return {};
}
