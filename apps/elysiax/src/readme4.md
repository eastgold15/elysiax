把 shadcn-htmx 和 Tailwind CSS 引入你现在的模块化架构，思路很清晰：**用 Tailwind 做底层样式系统，用 shadcn-htmx 做可复制粘贴的 UI 组件源码**。两者都遵循“源码安装、你的代码你做主”的原则，和你的虚拟模块系统天然契合。

---

## 🧩 shadcn-htmx 是什么

`productdevbook/shadcn-htmx` 是一个专为 **htmx v4 + Tailwind v4** 设计的组件库，提供 **82 个组件**，支持 **5 种模板风格**：Hono JSX、Jinja2、Go template、Phoenix 和 **raw HTML**。它遵循 shadcn 的核心理念：**没有运行时依赖，复制源码进你的项目，组件就是你的**。

对你来说，**用 `--flavour html` 或 `--flavour jsx`** 最合适：

- 如果模块的 `.ui.html` 是纯 HTML 片段，用 `html` flavour，直接复制 markup 进去。
- 如果后续想用 Bun 的 JSX 渲染，用 `jsx` flavour，得到类型安全的 `.tsx` 组件。

---

## 🎨 第一步：集成 Tailwind CSS v4

你的项目用 `Bun.serve`，Tailwind 官方推荐用 `bun-plugin-tailwind`，在 `bunfig.toml` 里配置即可。

### 1. 安装依赖

```bash
bun add tailwindcss bun-plugin-tailwind
```

### 2. 配置 `bunfig.toml`

```toml
[serve.static]
plugins = ["bun-plugin-tailwind"]
```

如果之后要编译成 exe，**Tailwind 会在构建时自动处理**，编译产物里会包含完整的 CSS。

### 3. 创建 Tailwind 入口 CSS

在 `src/` 下创建 `global.css`：

```css
@import "tailwindcss";

/* shadcn-htmx 需要的 CSS 变量，稍后从 init 生成的文件里复制过来 */
```

### 4. 在主 HTML 里引入

```html
<!-- src/index.html -->
<link rel="stylesheet" href="./global.css">
```

Bun 的 HTML imports 会自动打包这个 CSS，开发时热更新，构建时压缩。

**验证**：在 `index.html` 里写一个 `<div class="text-red-500">test</div>`，看是否变红。如果成功，Tailwind 已经跑起来了。

---

## 🧱 第二步：初始化 shadcn-htmx

在你项目根目录执行：

```bash
npx shadcn-htmx init --flavour html
# 或 --flavour jsx（如果要用 Bun JSX 渲染）
```

这会：

1. 生成 `shadcn-htmx.json` 配置文件，指向官方 registry
2. 写入 Tailwind 需要的 CSS 变量（在 `global.css` 里）
3. 生成 `cn()` 工具函数（class 合并工具，shadcn 的灵魂）

生成的 `shadcn-htmx.json` 大概长这样：

```json
{
  "flavour": "html",
  "registry": "https://shadcn-htmx.productdevbook.com/r",
  "tailwind": {
    "css": "src/global.css"
  }
}
```

**重要**：`init` 会把 CSS 变量注入你的 `global.css`，比如 `--background`、`--foreground`、`--primary` 等。这些变量是 shadcn-htmx 组件样式的基础，**不要删掉**。

---

## 📦 第三步：把组件安装到模块里

shadcn-htmx 的 `add` 命令会把组件源码写入指定目录：

```bash
npx shadcn-htmx add button dialog combobox
```

默认会写到 `components/ui/` 下。**但你要写进 `modules/ui-kit/`**，所以有两种做法：

### 方案 A：手动指定输出路径（如果 CLI 支持）

```bash
npx shadcn-htmx add button --path modules/ui-kit/
```

### 方案 B：安装后手动移动（更可靠）

```bash
npx shadcn-htmx add button
# 生成在 components/ui/button.html
mv components/ui/button.html modules/ui-kit/button.ui.html
```

**统一命名**：把 `button.html` 重命名为 `button.ui.html`，和你现有的 `.ui.html` 约定一致。

最终 `modules/ui-kit/` 结构：

```
modules/ui-kit/
├── module.json
├── button.ui.html
├── dialog.ui.html
├── combobox.ui.html
└── ui-kit.controller.ts    # 可选：提供片段接口
```

---

## 🔗 第四步：让虚拟模块识别 ui-kit

你现有的虚拟模块插件扫描 `modules/*/`，只聚合 `.ui.html` 和 `.controller.ts`。ui-kit 的组件本身就是 `.ui.html` 文件，**但文件名前缀是组件名（`button`），不是模块名（`ui-kit`）**。

你的插件靠 `base = modules/${name}/${name}` 定位文件，对 `ui-kit` 来说会去找 `ui-kit.ui.html`，找不到。

**两种调整方式**：

### 方式一：ui-kit 作为普通模块，组件通过相对路径导入

修改插件，对 `ui-kit` 特殊处理，或者更简单——**不让 ui-kit 进虚拟模块**。别的模块直接相对路径导入：

```ts
// modules/user/user.controller.ts
import button from "../ui-kit/button.ui.html";
import dialog from "../ui-kit/dialog.ui.html";

export const userController = new Elysia({ prefix: "/users" })
  .get("/", () => button);
```

**推荐这种方式**。组件之间用相对路径导入，依赖关系显式可见，和 shadcn 的理念一致。

### 方式二：改造插件，支持“多组件模块”

插件扫描 `modules/ui-kit/` 下**所有 `.ui.html` 文件**，而不只是 `ui-kit.ui.html`：

```ts
// plugin.ts 中 ui-kit 的特殊处理
if (name === "ui-kit") {
  const componentGlob = new Glob(`modules/ui-kit/*.ui.html`);
  for await (const file of componentGlob.scan(".")) {
    const compName = file.replace(/.*\//, "").replace(".ui.html", "").replace(/-/g, "_");
    imports.push(`import ${compName} from "${file}";`);
    entries.push(`    ${compName}: ${compName},`);
  }
}
```

这样在别处可以：

```ts
import { modules } from "virtual:modules";
const button = modules["ui-kit"].button;
```

**方式一更简单，方式二更统一**。建议先用方式一跑通，等组件多了再考虑方式二。

---

## 🖥️ 第五步：在模块里使用组件

假设 `modules/user/user.ui.html` 想用 shadcn-htmx 的 Button：

```html
<!-- modules/user/user.ui.html -->
<button
  class="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
  hx-get="/api/users"
  hx-target="#list"
>
  加载用户
</button>
<div id="list"></div>
```

这些 class 是 shadcn-htmx 组件自带的，复制过来就能用。**不需要 import 任何东西**，因为 Tailwind 在编译时扫描所有 `.ui.html` 文件，自动生成对应 CSS。

**关键**：Tailwind v4 会自动扫描项目里的 HTML/TSX 文件，提取用到的 class。所以你的 `.ui.html` 文件只要在项目里，Tailwind 就能找到。

---

## ⚙️ 第六步：处理 `cn()` 工具函数

shadcn-htmx 的 `init` 会生成一个 `cn()` 函数（基于 `clsx` + `tailwind-merge`），用于合并 class。如果你的组件用 JSX 渲染，需要它：

```ts
// 如果 init 生成在 lib/utils.ts
import { cn } from "../lib/utils";
```

**HTML flavour 不需要 `cn()`**，因为 class 是直接写在 markup 里的。

---

## 📁 最终项目结构

```
project/
├── modules/
│   ├── ui-kit/
│   │   ├── module.json
│   │   ├── button.ui.html          # shadcn-htmx 组件
│   │   ├── dialog.ui.html
│   │   ├── combobox.ui.html
│   │   └── ui-kit.controller.ts
│   ├── user/
│   │   ├── user.ui.html            # 使用 ui-kit 的组件
│   │   ├── user.controller.ts      # import button from "../ui-kit/button.ui.html"
│   │   ├── user.service.ts
│   │   └── user.repository.ts
│   └── order/
│       └── ...
├── src/
│   ├── global.css                  # Tailwind + shadcn CSS 变量
│   ├── index.html
│   ├── index.ts
│   └── plugin.ts
├── shadcn-htmx.json
├── bunfig.toml
└── package.json
```

---

## 💎 总结

| 步骤 | 做什么 |
|---|---|
| 1 | `bun add tailwindcss bun-plugin-tailwind`，配置 `bunfig.toml` |
| 2 | 创建 `src/global.css`，`@import "tailwindcss"` |
| 3 | `npx shadcn-htmx init --flavour html`，生成配置和 CSS 变量 |
| 4 | `npx shadcn-htmx add button dialog`，把组件移到 `modules/ui-kit/` |
| 5 | 其他模块通过相对路径 `import button from "../ui-kit/button.ui.html"` |
| 6 | Tailwind 自动扫描 `.ui.html`，编译时生成 CSS |

**和你的架构完美契合**：shadcn-htmx 提供源码组件，Tailwind 提供样式系统，虚拟模块负责聚合。ui-kit 是第一个“共享模块”的实战验证，组件安装进来就是你的源码，可以改、可以审计、可以提交到 git。这和整个源码安装的安全模型完全一致。