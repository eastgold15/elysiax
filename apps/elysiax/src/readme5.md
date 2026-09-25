你们正在构建的框架，本质上是一个**微内核+插件化**的架构，这为其带来了极大的灵活性和可扩展性。为了让这个“未来”的模块市场更加稳固，有几个方向值得关注和加强。

### 🧱 引入依赖注入（DI）与生命周期，让模块协作更可控

随着模块数量增长，模块间的依赖关系会变得复杂。目前通过虚拟模块直接调用 `modules.user.service` 的方式，容易产生难以追踪的“隐式依赖”和“循环依赖”风险。

一个值得借鉴的方向是引入**显式的依赖注入（DI）** 模式。Elysia 的插件系统本身就深受 DI 思想影响，它强调每个实例必须显式声明其依赖，这能极大地提升模块的可追踪性和可测试性。社区已有 `elysiajs-di`、`nestelia` 等方案，提供了装饰器、模块化依赖解析和循环依赖检测等能力，可以作为参考。

此外，为模块引入**生命周期管理**（如安装、启动、停止、卸载）也至关重要。这能让宿主在安装新模块时，安全地触发数据迁移、健康检查等逻辑，使模块的安装和运行更加健壮。





### ⚙️ 充分利用 Bun 的开发体验红利

Bun 提供了强大的全栈开发服务器，应充分利用其**内置的热模块替换（HMR）** 能力。这意味着你可以实现“所见即所得”的开发体验：修改 `user.ui.html` 或 `user.controller.ts`，浏览器中的页面状态无需完全刷新即可更新。这能极大缩短反馈循环，是框架“UI 和后端很贴近”理念的绝佳体现。

### 📚 完善契约与文档，构建健康的模块生态

一个繁荣的模块市场离不开清晰的契约。

*   **模块清单（module.json）** 需要像 shadcn 的 `registry-item.json` 那样，**严格遵循 Schema**，并显式声明所有依赖（包括 `registryDependencies`），以确保安装的可重现性。
*   **命名空间（Namespace）** 建议从第一天就支持（如 `myapp add @author/module`），这能避免命名冲突，并为未来私有仓库和团队协作预留空间。
*   **组件质量门禁**：每个可分享的 UI 组件都应**默认无业务耦合**、**暴露清晰的最小化 Props API**，并提供**可访问性说明**（键盘操作、ARIA 属性等），确保生态组件的质量底线。




好的，既然确定了 `@inferdi/elysia`，那我们就来把它完整地集成到你的模块化框架里。它的核心优势在于**零依赖、无装饰器，并且通过编译期类型检查来保证依赖图的健康**，这和你“源码完全可控”的理念是高度一致的。

### 🧱 第一步：安装与初始化

首先，在项目根目录安装核心包和 Elysia 适配器。

```bash
bun add @inferdi/inferdi @inferdi/elysia
```

### 🏗️ 第二步：创建根容器并注册服务

`@inferdi/inferdi` 的核心是 `Container`。你需要创建一个 `container.ts` 文件来构建你的根容器，并在这里注册所有模块的服务。

```typescript
// src/shared/container.ts
import { Container } from '@inferdi/inferdi';
// 假设你的模块服务是这样导出的
import { userService } from '../modules/user/user.service';
import { orderService } from '../modules/order/order.service';
import { db } from './db';

export function buildRootContainer() {
  const container = new Container();

  // 1. 注册基础设施服务（单例）
  container.registerValue('db', db);
  container.registerValue('config', { /* ... */ });

  // 2. 注册业务服务（单例或作用域内）
  // 这里的依赖注入是完全类型安全的
  container.registerClass('userService', UserService, ['db']); // 假设 UserService 是类
  container.registerClass('orderService', OrderService, ['db', 'userService']); // OrderService 依赖 UserService

  // 如果服务是对象字面量，使用 registerValue 或 registerFactory
  // container.registerFactory('userService', (c) => userService(c.get('db')), 'singleton');

  return container;
}
```

**关键点**：
- **依赖数组**：`registerClass` 的第三个参数是依赖键的数组，**顺序必须和构造函数参数完全一致**。这是 InferDI 实现类型安全的核心，顺序错了编译器会直接报错。
- **生命周期**：`registerClass` 的第四个参数是生命周期，默认为 `'singleton'`（单例）。也支持 `'transient'`（瞬态）和 `'scoped'`（作用域）。

### 🔌 第三步：在 Elysia 中接入插件

在你的主 `index.ts` 中，使用 `inferdiElysia` 插件，它会为**每个请求自动创建一个 DI 作用域**。

```typescript
// src/index.ts
import { Elysia } from 'elysia';
import { inferdiElysia } from '@inferdi/elysia';
import { buildRootContainer } from './shared/container';
import { serve } from 'bun';
import index from './index.html';
import { modules } from 'virtual:modules';

const root = buildRootContainer();

const app = new Elysia()
  .use(inferdiElysia({
    container: root,
    // 可选：在作用域初始化时注入请求相关信息
    setupScope: (scope, { request }) => {
      const ctx = scope.get('request');
      ctx.requestId = crypto.randomUUID();
      ctx.userId = request.headers.get('x-user-id') ?? undefined;
    },
  }))
  // 挂载所有模块的控制器
  .use(modules.user.controller)
  .use(modules.order.controller);

serve({
  port: 3000,
  routes: {
    '/': index,
    '/api/*': (req) => app.handle(req),
  },
  development: true,
});
```

**核心行为**：`inferdiElysia` 插件会为每个请求创建一个新的 DI 作用域，并将其暴露在 Elysia 的 `context.di` 上（可通过 `key` 选项自定义键名）。请求结束后，插件会自动调用 `dispose()` 清理作用域，释放资源。

### 🔄 第四步：在控制器中使用服务

现在，你可以在任何路由处理器中通过 `di.get('key')` 获取服务，并且**完全类型安全**。

```typescript
// modules/user/user.controller.ts
import { Elysia } from 'elysia';

export const userController = new Elysia({ prefix: '/users' })
  .get('/', ({ di }) => {
    // di 上自动拥有你在容器中注册的所有服务的类型
    const userService = di.get('userService');
    return userService.listUsers();
  })
  .get('/:id', ({ di, params }) => {
    const userService = di.get('userService');
    return userService.getProfile(params.id);
  });
```

`di.get('userService')` 的返回类型会被编译器自动推断为 `UserService`，并且所有方法都可补全。

### 🌀 第五步：理解并处理循环依赖

这是你选择 InferDI 的关键原因。**InferDI 在编译期就会拒绝真正的循环依赖**。

#### 编译期拒绝

如果 `UserService` 和 `OrderService` 的构造函数互相依赖对方，你在注册时就会看到编译错误，因为类型系统会检测到 `AllowedDeps` 不满足。

#### 运行时检测

对于通过工厂函数等方式**间接引入的循环**，InferDI 的运行时检测器会精确地报告错误，而不是静默失败或自动“打破”循环。

#### 正确的解法：Lazy 注入

对于**两个单例**之间的循环依赖，InferDI 提供了优雅的解决方案：**`Lazy<T>`**。

你可以在注册时为其中一个服务创建一个 `Lazy` 伴随键，然后在另一个服务中注入这个 `Lazy` 包装器，**将依赖解析延迟到实际使用时**。

```typescript
// src/shared/container.ts
import { Container } from '@inferdi/inferdi';

const container = new Container();

// 为 orderService 注册一个 Lazy 伴随键 'orderServiceLazy'
container.registerClass('orderService', OrderService, ['db'], 'singleton', 'orderServiceLazy');

// userService 依赖的是 Lazy<OrderService>，而不是 OrderService 本身
container.registerClass('userService', UserService, ['db', 'orderServiceLazy']);
```

在 `UserService` 的构造函数中：

```typescript
class UserService {
  constructor(
    private db: Database,
    private orderServiceLazy: Lazy<OrderService> // 注入 Lazy 包装器
  ) {}

  async getUserOrders(userId: string) {
    // 在真正需要时才解析 OrderService 实例
    const orderService = this.orderServiceLazy.get();
    return orderService.listByUser(userId);
  }
}
```

**关键点**：
- **生命周期守卫**：`Lazy<singleton>` 只能注入到单例消费者中。`Lazy<scoped>` 或 `Lazy<transient>` 注入到单例中，**编译器会直接报错**。
- **真正打破循环**：通过 `Lazy`，`UserService` 的构造不再需要 `OrderService` 实例，循环在**类型层面**就被打破了。

### 🧩 第六步：与虚拟模块架构融合

将 DI 容器与你的虚拟模块系统结合，可以实现模块的**完全解耦**。你不再需要模块之间直接 `import` 对方的服务文件。

1. **模块声明依赖**：在每个模块的 `module.json` 中，你可以增加一个 `provides` 字段，声明该模块向容器注册的服务键。
2. **插件自动注册**：在虚拟模块插件中，遍历 `modules/*/`，读取每个模块的 `module.json`，**自动将模块的 service 工厂函数注册到根容器中**。

```typescript
// src/plugin.ts (虚拟模块插件中的伪代码)
import { buildRootContainer } from '../shared/container';

const root = buildRootContainer();

for (const dir of dirs) {
  const manifest = await Bun.file(`modules/${dir}/module.json`).json();
  if (manifest.provides) {
    const serviceFactory = (await import(`modules/${dir}/${dir}.service`)).default;
    // 将模块的服务注册到容器
    root.registerFactory(manifest.provides.key, serviceFactory, manifest.provides.lifecycle);
  }
}
```

这样，一个模块只需要在 `module.json` 中声明“我提供 `userService` 键”，另一个模块在它的 `module.json` 中声明“我依赖 `userService` 键”，**两个模块之间没有任何代码依赖**，完全通过 DI 容器解耦。

### 💎 总结

| 步骤 | 关键操作 | 核心价值 |
| :--- | :--- | :--- |
| **1. 安装** | `bun add @inferdi/inferdi @inferdi/elysia` | 零依赖、无装饰器 |
| **2. 创建容器** | `new Container().registerClass(...)` | 显式、类型安全的依赖图 |
| **3. 接入 Elysia** | `.use(inferdiElysia({ container: root }))` | 自动管理请求作用域 |
| **4. 控制器使用** | `di.get('serviceKey')` | 类型安全地获取服务 |
| **5. 处理循环** | 使用 `Lazy<singleton>` 伴随键 | 编译期打破循环，延迟解析 |
| **6. 模块融合** | 模块声明 `provides` / `requires` | 模块间零代码依赖 |

这套方案完美契合了你“源码完全可控、编译期检查、模块化”的框架理念。`@inferdi/elysia` 负责管理请求作用域的生命周期，而 `@inferdi/inferdi` 则通过 `Lazy` 和编译期检查来保证依赖图的健康。两者的结合，为你的模块化框架提供了一个坚实、可扩展的依赖注入基础。