
源码安装这个约束很关键，它把整套架构从“包管理器”拉回到“代码复制”，安全性、透明性、可审计性全部上一个台阶。但这也意味着前面几节的设计要重新调整。下面按源码安装重新推一遍。

---

## 一、核心转变：模块 = 源码，不是包

shadcn 的本质：

- **没有运行时依赖**。`npx shadcn add button` 把 `button.tsx` 源码复制到你的项目，之后 `shadcn` 和你的项目再无关系。
- **你拥有代码**。可以读、改、审计、提交到 git。
- **没有隐藏层**。没有 node_modules、没有编译产物、没有 postinstall 脚本。
- **版本只是元数据**。安装时记录版本，之后代码就是你项目的一部分。

把这个模型套到你的模块上：

| 传统包管理 | 源码安装（你的方案） |
|---|---|
| `npm install user` | `myapp add user` |
| 装到 `node_modules/` | 复制到 `./modules/user/` |
| 编译产物 | 纯 `.ts` / `.html` 源码 |
| 依赖在 node_modules 里 | 依赖也复制进 `./modules/` |
| 更新是覆盖 | 更新是 diff + 手动合并 |
| 运行时解析 | 编译期相对路径 |

**一句话：安装即复制源码，之后模块就是你的代码。**

---

## 二、目录结构（简化了）

因为不再有“全局安装”，路径从三条收敛为一条：

```
project/
├── modules/                  # 唯一安装位置，所有模块的源码都在这
│   ├── user/
│   │   ├── module.json
│   │   ├── user.ui.html
│   │   ├── user.controller.ts
│   │   ├── user.service.ts
│   │   ├── user.repository.ts
│   │   └── user.model.ts
│   ├── ui-kit/
│   │   ├── module.json
│   │   ├── button.ui.html
│   │   ├── card.ui.html
│   │   └── table.ui.html
│   └── order/
│       ├── module.json
│       ├── order.ui.html
│       └── order.controller.ts
├── src/
│   ├── index.ts
│   ├── index.html
│   └── plugin.ts
└── modules.lock.json
```

**不再有**：

- `~/.myapp/modules/` 全局路径
- `src/modules/` 内置路径
- 路径优先级覆盖规则

**内置模块怎么办？** 项目初始化时，`myapp init` 直接把需要的模块源码复制到 `./modules/`。比如默认带上 `core`、`ui-kit`。之后它们就是你的源码，和用户装的模块没有区别。

---

## 三、虚拟模块插件（大幅简化）

只扫一个路径，不需要优先级、不需要合并：

```ts
// src/plugin.ts
import { plugin, Glob } from "bun";

plugin({
  name: "module-aggregator",
  setup(build) {
    build.onResolve({ filter: /^virtual:modules$/ }, () => ({
      path: "virtual:modules",
      namespace: "module-aggregator",
    }));

    build.onLoad(
      { filter: /.*/, namespace: "module-aggregator" },
      async () => {
        const dirs: string[] = [];
        const dirGlob = new Glob("modules/*/");
        for await (const dir of dirGlob.scan(".")) dirs.push(dir);

        const imports: string[] = [];
        const exports: string[] = [];

        const suffixMap = {
          ui: ".ui.html",
          controller: ".controller.ts",
          service: ".service.ts",
        } as const;

        for (const dir of dirs) {
          const name = dir.replace(/^modules\//, "").replace(/\/$/, "");
          const base = `modules/${name}/${name}`;
          const varName = name.replace(/-/g, "_");
          const entries: string[] = [];

          // 读 manifest
          const manifestPath = `modules/${name}/module.json`;
          if (!(await Bun.file(manifestPath).exists())) continue;

          imports.push(
            `import ${varName}_manifest from "${manifestPath}";`
          );
          entries.push(`    manifest: ${varName}_manifest,`);

          for (const [key, suffix] of Object.entries(suffixMap)) {
            const filePath = `${base}${suffix}`;
            if (await Bun.file(filePath).exists()) {
              const importName = `${varName}_${key}`;
              imports.push(`import ${importName} from "${filePath}";`);
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
      }
    );
  },
});
```

比之前简单很多，因为没有多路径、没有版本冲突、没有优先级。

---

## 四、安装流程（shadcn 风格）

```bash
myapp add user
```

流程：

1. 从 registry 拉取 `user` 的源码包（tarball / zip）
2. 解压到临时目录
3. 读 `module.json`，检查依赖
4. 对每个依赖，递归执行同样的流程
5. 把源码复制到 `./modules/<name>/`
6. 如果目标已存在，**显示 diff，让用户确认是否覆盖**
7. 写 `modules.lock.json`
8. 打印摘要：新增哪些文件、覆盖哪些文件

**没有 postinstall、没有编译、没有脚本执行。** 全程只是复制文件。

### 已存在时的处理

shadcn 的做法是问你“覆盖 / 跳过 / 查看 diff”。你也照做：

```bash
$ myapp add user
! modules/user 已存在
? 如何处理？
  > 查看 diff
    覆盖
    跳过
    重命名到 modules/user-1
```

**这是源码安装最关键的安全点**：用户永远知道什么被改动。

---

## 五、更新流程：diff 驱动

```bash
myapp update user
```

1. 从 registry 拉取最新版
2. 对比本地 `./modules/user/` 和新版
3. 显示逐文件 diff
4. 用户确认后，覆盖对应文件
5. 如果本地有修改（`modified: true`），默认不覆盖，提示用户手动合并

`modules.lock.json` 记录是否被本地改过：

```json
{
  "version": 1,
  "modules": {
    "user": {
      "version": "1.0.0",
      "source": "registry:user",
      "hash": "sha256-...",
      "installedAt": "2026-09-25T...",
      "modified": false
    }
  }
}
```

计算方式：安装时记录文件哈希，更新前重新算一遍，不一致就是被改过。

**好处**：用户改过的模块不会被静默覆盖。升级是显式的、可审计的。

---

## 六、依赖怎么处理

`order` 模块依赖 `user`：

```json
{
  "name": "order",
  "version": "1.0.0",
  "dependencies": {
    "user": "^1.0.0"
  }
}
```

安装 `order` 时：

1. 读 `order/module.json`
2. 检查 `./modules/user/` 是否已存在
3. 不存在 → 递归安装 `user`
4. 存在 → 检查版本是否满足 `^1.0.0`
5. 不满足 → 报错，让用户决定

**没有 npm 那套依赖树。** 每个模块只有一份源码，依赖是扁平的。这带来一个限制：**不能同时装两个版本的 user**。但这也正是源码安装的取舍——简单、可读，牺牲一点灵活性。

如果未来真需要多版本共存，可以把模块名扩展成 `user@1` / `user@2`，但那是后话。

---

## 七、跨模块调用（源码视角）

因为所有模块源码都在 `./modules/` 下，跨模块导入就是**相对路径**：

```ts
// modules/order/order.controller.ts
import { userService } from "../user/user.service";
```

或者用虚拟模块：

```ts
// modules/order/order.controller.ts
import { modules } from "virtual:modules";

export const orderController = new Elysia({ prefix: "/orders" })
  .get("/with-user", async () => {
    return modules.user.service.listUsers();
  });
```

**两者都可以，但推荐相对路径**。原因：

- 相对路径让依赖关系**显式可见**，读代码时一眼看出 order 依赖 user
- 虚拟模块是全局单例，跨模块调用时看不出依赖方向
- 虚拟模块更适合**入口装配**，不适合模块间调用

这和 shadcn 的思路一致：组件之间通过相对路径 import，不用全局注册表。

---

## 八、UI 共享：源码组件

`ui-kit` 就是一个普通模块，只提供 HTML 片段：

```
modules/ui-kit/
├── module.json
├── button.ui.html
├── card.ui.html
└── table.ui.html
```

别的模块用按钮：

```ts
// modules/user/user.controller.ts
import button from "../ui-kit/button.ui.html";
```

或者直接在 HTML 片段里用 htmx：

```html
<!-- modules/user/user.ui.html -->
<button hx-get="/api/users" hx-target="#list">加载</button>
```

**没有“组件库”这个抽象**，就是源码文件，按需 import。shadcn 就是这么干的。

如果你想更细粒度，甚至可以让 `ui-kit` 不是一个模块，而是 `modules/ui/button/`、`modules/ui/card/` 这样拆开。每个组件独立安装、独立更新。这是 shadcn 的原教旨做法。

**建议**：先做粗粒度的 `ui-kit` 模块，等组件多了再拆。

---

## 九、Registry 只需要做一件事：发源码

服务端极其简单：

- 存模块的源码 tarball
- 存 `module.json` 元数据（名字、版本、作者、依赖、描述、哈希）
- 提供下载接口

**没有编译、没有构建、没有签名验证的复杂逻辑**（签名可选，用于验证来源）。它就是“源码 + 元数据”的分发。

发布：

```bash
myapp publish
```

把你的 `./modules/user/` 打包上传。registry 存下来，返回一个可访问的 URL。

安装：

```bash
myapp add user
```

从 registry 下载，解压，复制。

**整个系统没有“运行时”概念**——安装完，registry 就和你无关了。

---

## 十、安全模型对比

| 风险 | 传统包管理 | 源码安装 |
|---|---|---|
| 隐藏代码 | postinstall 脚本、编译产物 | 无，全是源码 |
| 供应链攻击 | 传递依赖不可见 | 依赖也是源码，可审计 |
| 版本混淆 | semver + 锁文件 | 锁文件 + 哈希 + diff |
| 静默更新 | 可能覆盖本地修改 | 更新必须确认 |
| 运行时执行 | 依赖的代码自动执行 | 代码是你的，你决定何时运行 |
| 审计成本 | 需要工具扫描 | `git diff` 就够 |

**唯一的代价**：仓库更大，更新需要手动合并。但对本地工具、桌面应用、内部系统来说，这个代价完全值得。

---

## 十一、修正后的架构总结

| 关注点 | 方案 |
|---|---|
| 模块形式 | 源码文件夹 + `module.json` |
| 安装位置 | 只有 `./modules/` |
| 安装方式 | 复制源码，diff 确认 |
| 依赖 | 递归复制，扁平化，不允许多版本 |
| 更新 | 拉取新版 + diff + 手动合并 |
| 跨模块调用 | 相对路径 import（推荐）或 virtual:modules |
| UI 共享 | `ui-kit` 模块，源码 import |
| 虚拟模块 | 只扫 `./modules/`，聚合 ui + controller + service |
| Registry | 只存源码 + 元数据 |
| 锁文件 | 记录版本、哈希、是否本地修改 |
| 安全 | 源码可读、更新可审计、无隐藏执行 |

---

## 十二、落地顺序（修正版）

1. **`module.json` 规范**：定义名字、版本、依赖、路由前缀
2. **虚拟模块插件**：只扫 `./modules/`，聚合 ui / controller / service / manifest
3. **`myapp add ./local-path`**：先把本地复制跑通，不接 registry
4. **diff 机制**：安装/更新时对比文件，让用户确认
5. **`modules.lock.json`**：记录版本和哈希
6. **`myapp publish` + registry**：等模块稳定了再做
7. **`ui-kit` 模块**：验证 UI 源码共享
8. **`myapp update`**：diff 驱动更新

每一步都能独立跑，不阻塞。最关键的是第 3、4 步——**复制 + diff** 是源码安装的灵魂，先把这两个做好。

---

## 一句话总结

源码安装把“模块市场”变成了“**源码分发 + 本地拥有**”。没有全局路径、没有隐藏代码、没有静默更新。安装就是复制，更新就是 diff，跨模块调用就是相对路径。虚拟模块只扫 `./modules/`，registry 只存源码。这套模型更简单、更安全、更符合“我的代码我做主”的直觉——代价是仓库大一点、更新手动一点，但对本地工具和桌面应用完全值得。