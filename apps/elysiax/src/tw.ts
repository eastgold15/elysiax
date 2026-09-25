import { compile } from 'tailwindcss'
import path from 'node:path'

// tailwindcss 包根目录（@import "tailwindcss" → 其根 index.css）
const twRoot = path.dirname(
  Bun.resolveSync('tailwindcss/package.json', process.cwd())
)

// 处理 @import：相对路径相对 base 解析；"tailwindcss" 解析到包内 css 文件
async function loadStylesheet(id: string, base: string) {
  const file = id.startsWith('.')
    ? path.resolve(base, id)
    : path.join(twRoot, id === 'tailwindcss' ? 'index.css' : id.slice('tailwindcss/'.length))
  return {
    path: file,
    base: path.dirname(file),
    content: await Bun.file(file).text()
  }
}

// 朴素的候选类名扫描：切分源码 token，交给 tailwind 编译器自行过滤
async function scanCandidates(root: string): Promise<string[]> {
  const candidates = new Set<string>()
  const glob = new Bun.Glob('**/*.{ts,tsx,html,css}')
  for await (const file of glob.scan({ cwd: root, absolute: true })) {
    if (file.includes('node_modules') || file.includes('/dist/')) continue
    const text = await Bun.file(file).text()
    for (const token of text.split(/[\s"'`{}()[\]<>;,&|!?\\#$%^*=~]+/)) {
      if (token && /[a-zA-Z]/.test(token)) candidates.add(token)
    }
  }
  return [...candidates]
}

// 编译一份 tailwind css：@import 展开 + 按需生成工具类
export async function buildCss(cssPath: string): Promise<string> {
  const compiler = await compile(await Bun.file(cssPath).text(), {
    base: path.dirname(cssPath),
    loadStylesheet
  })
  return compiler.build(await scanCandidates(process.cwd()))
}
