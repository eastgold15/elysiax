import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: false, // rollup-plugin-dts 不兼容 TS7(native);仓库内直接消费 src,无需 dist 类型
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'node20',
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' }
  }
})
