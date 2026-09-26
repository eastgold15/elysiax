import { codegen } from "@elysiax/core";
await codegen();
import tailwind from "bun-plugin-tailwind";
import { rm } from "node:fs/promises";
import path from "node:path";

const outdir = path.join(process.cwd(), "dist");
await rm(outdir, { recursive: true, force: true });

// const entrypoints = [...new Bun.Glob("src/**/*.html").scanSync()];
const entrypoints = [...new Bun.Glob("src/index.ts").scanSync()];
const result = await Bun.build({
  entrypoints,
  outdir,
  target: "bun",
  plugins: [tailwind],
  compile: 'bun-linux-x64',
  minify: true,
  sourcemap: "linked",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

for (const output of result.outputs) {
  console.log(` ${path.relative(process.cwd(), output.path)}  ${(output.size / 1024).toFixed(1)} KB`);
}
