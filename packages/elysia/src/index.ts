/**
 * InferDI 的 Elysia 请求作用域插件。
 *
 * 为每个 Elysia 请求创建一个 InferDI scope，把它挂到请求上下文上，并通过
 * 受保护的 success/error 生命周期钩子释放它。本包只做「生命周期胶水」：
 * 不做装饰器、反射、路由扫描，也不做 handler 参数注入。
 *
 * 清理与生命周期绑定：scope 在 `afterResponse`（Elysia 2.0 之前叫
 * `onAfterResponse`）中释放。如果运行时没走到这个钩子（连接在响应产生前
 * 就中断，或进程在处理请求中途退出），`dispose()` 不会被调用。
 * 每个请求的 scope 记在一个 `WeakMap` 里，所以一旦 `Request` 不可达，
 * 记账本身会被回收；但 scope 持有的资源（连接、句柄）只有 `dispose()`
 * 真正执行时才释放。
 *
 * @example
 * ```ts
 * import { Elysia } from 'elysia'
 * import { inferdiElysia } from '@inferdi/elysia'
 *
 * const root = buildRootContainer()
 *
 * const app = new Elysia()
 *   .use(inferdiElysia({ container: root }))
 *   .get('/users/:id', ({ di, params }) =>
 *     di.get('users').profile(params.id),
 *   )
 * ```
 *
 * @module
 */

// 已从 @inferdi/elysia 6.1.0（面向 Elysia 1.x）移植到 Elysia 2.0：
// - 钩子改名：onError → error、onAfterResponse → afterResponse、resolve 并入 derive
// - 作用域参数从 { as: 'scoped' } 改为字符串 'plugin'（EventScope = 'global' | 'local' | 'plugin'）
// - Elysia 泛型参数列表重排（BasePath, Scope, Singleton, ...）
// - Context 类型不再从 elysia 导入，改为结构性最小契约（避免与 Elysia 内部 RouteSchema 耦合）
import { Elysia } from 'elysia'

/**
 * 类型 `T` 的值，或解析为它的 Promise。scope 钩子用它来同时接受
 * 同步和异步实现。
 *
 * @template T - 解析后的值类型。
 */
export type MaybePromise<T> = T | Promise<T>

/**
 * 可释放的 InferDI 请求 scope 的最小结构性契约。任何 `Container`
 * 实例都满足它。
 */
export interface InferdiScope {
  /**
   * 释放该 scope 拥有的一切。InferDI 的 `Container.dispose()` 是幂等的；
   * 自定义 scope 实现也应保持这一行为。
   */
  dispose(): MaybePromise<void>
}

/**
 * 交给插件的根容器的结构性契约。
 *
 * @template Scope - `createScope()` 产出的每请求 scope 类型。
 */
export interface InferdiRoot<Scope extends InferdiScope = InferdiScope> {
  /** 打开一个新的请求 scope。scoped 模式下每个请求调用一次。 */
  createScope(): Scope
}

/**
 * 从根容器中提取它创建的请求 scope 类型。
 *
 * @template Root - 带 `createScope()` 的结构性根容器。
 */
export type InferdiScopeOf<Root extends InferdiRoot> =
  ReturnType<Root['createScope']>

/**
 * Elysia 上下文片段：在某个上下文键下暴露一个具体的 scope。
 *
 * @template Scope - 暴露在 Elysia 请求上下文上的 scope。
 * @template Key   - Elysia 上下文键，默认 `'di'`。
 */
export type InferdiElysiaContext<
  Scope extends InferdiScope,
  Key extends string = 'di',
> = {
    [P in Key]: Scope
  }

/**
 * Elysia 上下文片段：在某个上下文键下暴露根容器。
 *
 * @template Root - 在 root-only 模式下暴露的根容器。
 * @template Key  - Elysia 上下文键，默认 `'di'`。
 */
export type InferdiElysiaRootContext<
  Root extends InferdiRoot,
  Key extends string = 'di',
> = {
    [P in Key]: Root
  }

/** 触发请求 scope 清理的生命周期阶段。 */
export type InferdiElysiaLifecyclePhase = 'setup' | 'error' | 'afterResponse'

/**
 * 传给 scope 创建与 setup 钩子的请求期 Elysia 上下文。`unknown` 的路由形状
 * 对应 Elysia `scoped` 插件的可见性——某些生命周期阶段下 params 可能不可用。
 *
 * 这里刻意把 schema 钉死，而不是放宽成 `Context<any, any>`：这样钩子拿到
 * 一个稳定、有类型的表面（`request`、`headers`、`query`、`params`），
 * 与具体路由的泛型无关，而不是全部塌缩成 `any`。代价是耦合 Elysia
 * `Context` 的元数——未来某个大版本改了 `Context` 的泛型参数，这里可能要
 * 跟着改；但 `Context<any, any>` 会带来同样的暴露面，类型安全却更差。
 *
 * `body`、`cookie`、`response` 刻意保持 `unknown`：在 scoped 插件层面，
 * 路由的 body/response 类型未知；`cookie` 不标注类型，是为了避免耦合
 * Elysia 内部的 `Cookie<T>` 形状。要在 `setupValidatedScope` 里读它们，
 * 请自行 cast 成你的路由 schema。
 */
export type InferdiElysiaRequestContext = {
  readonly request: Request
  readonly headers: Record<string, string | undefined>
  readonly query: Record<string, string | undefined>
  readonly params: Record<string, string | undefined>
  readonly body: unknown
  readonly cookie: unknown
  readonly response?: unknown
}

/**
 * 传给 `disposeScope`、`autoDispose`、`onDisposeError` 的窄清理上下文。
 * 刻意只暴露 Elysia success/error 钩子共享的稳定字段。
 *
 * @template Scope - 请求 scope 类型。
 * @template Key   - 携带 scope 的上下文键。
 */
export type InferdiElysiaLifecycleContext<
  Scope extends InferdiScope,
  Key extends string = 'di',
> = {
  readonly request: Request
  readonly phase: InferdiElysiaLifecyclePhase
  readonly error?: unknown
} & Partial<InferdiElysiaContext<Scope, Key>>

/**
 * 传给 `setupValidatedScope` 的上下文。它跑在 Elysia `resolve` 中，
 * 在校验完成之后，并包含已创建、挂在所配置上下文键下的请求 scope。
 *
 * @template Scope - 请求 scope 类型。
 * @template Key   - 携带 scope 的上下文键。
 */
export type InferdiElysiaValidatedContext<
  Scope extends InferdiScope,
  Key extends string = 'di',
> = InferdiElysiaRequestContext & InferdiElysiaContext<Scope, Key>

/**
 * {@link skipInferdiDispose} 接受的上下文片段。任何 Elysia 上下文对象
 * 都满足这个契约。
 */
export type InferdiElysiaSkipContext = {
  readonly request: Request
}

/**
 * 默认 scoped 模式的选项：每个请求一个请求 scope，暴露在 Elysia 上下文上，
 * 并在有界请求工作结束后释放。
 *
 * @template Root  - 根容器类型。
 * @template Key   - 上下文键。
 * @template Scope - 每请求 scope 类型。
 */
export type ScopedOptions<
  Root extends InferdiRoot,
  Key extends string,
  Scope extends InferdiScope = InferdiScopeOf<Root>,
> = {
  /** 根容器。 */
  readonly container: Root
  /** Elysia 上下文键，默认 `'di'`。 */
  readonly key?: Key
  /** Scoped 模式标记。省略或设为 `true` 即保持每请求 scope。 */
  readonly scopePerRequest?: true
  /**
   * 覆盖请求 scope 的创建方式，默认 `root.createScope()`。可为异步。
   */
  readonly createScope?: (
    root: Root,
    context: InferdiElysiaRequestContext
  ) => MaybePromise<Scope>
  /**
   * 可选钩子：在路由处理器能从 Elysia 上下文读到 scope 之前，
   * 给刚创建的 scope 注入数据（hydrate）。
   */
  readonly setupScope?: (
    scope: Scope,
    context: InferdiElysiaRequestContext
  ) => MaybePromise<void>
  /**
   * 可选钩子：用已校验的请求数据注入 scope。跑在 Elysia 校验之后、
   * 路由处理器之前。
   */
  readonly setupValidatedScope?: (
    scope: Scope,
    context: InferdiElysiaValidatedContext<Scope, Key>
  ) => MaybePromise<void>
  /** 覆盖请求 scope 的释放，默认 `scope.dispose()`。 */
  readonly disposeScope?: (
    scope: Scope,
    context: InferdiElysiaLifecycleContext<Scope, Key>
  ) => MaybePromise<void>
  /**
   * 控制插件是否释放请求 scope。返回 `false` 即把释放责任交给应用代码。
   */
  readonly autoDispose?:
  | boolean
  | ((
    context: InferdiElysiaLifecycleContext<Scope, Key>
  ) => MaybePromise<boolean>)
  /**
   * 清理失败的可选接收器。正常返回即视为清理错误已处理；未提供时，
   * 失败会用 `console.error` 记录。
   */
  readonly onDisposeError?: (
    error: unknown,
    context: InferdiElysiaLifecycleContext<Scope, Key>
  ) => MaybePromise<void>
}

/**
 * root-only 模式（`scopePerRequest: false`）的选项：通过 Elysia 上下文
 * 暴露根容器，不安装任何请求 scope 钩子。
 *
 * @template Root - 根容器类型。
 * @template Key  - 上下文键。
 */
export type RootOnlyOptions<
  Root extends InferdiRoot,
  Key extends string,
> = {
  /** 根容器。 */
  readonly container: Root
  /** Elysia 上下文键，默认 `'di'`。 */
  readonly key?: Key
  /** Root-only 模式标记。 */
  readonly scopePerRequest: false
  /** root-only 模式下禁止。 */
  readonly createScope?: never
  /** root-only 模式下禁止。 */
  readonly setupScope?: never
  /** root-only 模式下禁止。 */
  readonly setupValidatedScope?: never
  /** root-only 模式下禁止。 */
  readonly disposeScope?: never
  /** root-only 模式下禁止。 */
  readonly autoDispose?: never
  /** root-only 模式下禁止。 */
  readonly onDisposeError?: never
}

/**
 * 插件选项。对 `scopePerRequest` 的可辨识联合：
 * - 省略 / `true` -> {@link ScopedOptions}。
 * - `false` -> {@link RootOnlyOptions}。
 *
 * @template Root  - 根容器类型。
 * @template Key   - 上下文键。
 * @template Scope - 每请求 scope 类型。
 */
export type InferdiElysiaOptions<
  Root extends InferdiRoot,
  Key extends string,
  Scope extends InferdiScope = InferdiScopeOf<Root>,
> =
  | ScopedOptions<Root, Key, Scope>
  | RootOnlyOptions<Root, Key>

/**
 * scoped InferDI 模式返回的 Elysia 插件类型。
 *
 * @template Scope - 暴露在 Elysia 上下文上的请求 scope。
 * @template Key   - 携带请求 scope 的上下文键。
 */
export type InferdiElysiaScopedPlugin<
  Scope extends InferdiScope,
  Key extends string,
> = Elysia<
  '',
  'local',
  {
    decorator: {}
    store: {}
    derive: InferdiElysiaContext<Scope, Key>
  }
>

/**
 * root-only InferDI 模式返回的 Elysia 插件类型。
 *
 * @template Root - 暴露在 Elysia 上下文上的根容器。
 * @template Key  - 携带根容器的上下文键。
 */
export type InferdiElysiaRootPlugin<
  Root extends InferdiRoot,
  Key extends string,
> = Elysia<
  '',
  'local',
  {
    decorator: InferdiElysiaRootContext<Root, Key>
    store: {}
    derive: {}
  }
>

type BaseScope = InferdiScope
type BaseRoot = InferdiRoot<BaseScope>
type BaseOptions = InferdiElysiaOptions<BaseRoot, string, BaseScope>

/**
 * 每请求的记账数据。`derive` 打开 scope 时创建一条记录，
 * 请求失败时在 `onError` 中被改写。`hasError` 用来区分「没有错误」和
 * 「错误值恰好是 `undefined`」。
 */
type RequestState = {
  readonly scope: BaseScope
  hasError: boolean
  error?: unknown
}

/*
 * 刻意做成进程全局：以唯一的 `Request` 身份为键，所以永远不会把请求搞混，
 * 且单次 `skipInferdiDispose(context)` 调用就能抑制该请求上所有插件实例的
 * 释放（见 `skipInferdiDispose` 文档）。如果做成每个工厂一个 `WeakSet`，
 * 跳过就变成按实例生效，挂载的每个插件都要各调一次。
 */
const skippedRequests = new WeakSet<Request>()
let pluginInstanceId = 0

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function lifecycleContext<
  Scope extends InferdiScope,
  Key extends string,
>(
  key: Key,
  scope: Scope,
  request: Request,
  phase: InferdiElysiaLifecyclePhase,
  error?: unknown
): InferdiElysiaLifecycleContext<Scope, Key> {
  const result = {
    request,
    phase,
    [key]: scope
  } as InferdiElysiaLifecycleContext<Scope, Key>

  if (error !== undefined) {
    ; (result as { error?: unknown }).error = error
  }

  return result
}

function handleDisposeError<
  Scope extends InferdiScope,
  Key extends string,
>(
  error: unknown,
  context: InferdiElysiaLifecycleContext<Scope, Key>,
  onDisposeError:
    | ((
      error: unknown,
      context: InferdiElysiaLifecycleContext<Scope, Key>
    ) => MaybePromise<void>)
    | undefined,
  errors: unknown[]
): void | PromiseLike<void> {
  if (onDisposeError === undefined) {
    errors.push(error)
    return
  }

  try {
    const handling = onDisposeError(error, context)
    if (isPromiseLike(handling)) {
      return handling.then(undefined, (handlerError) => {
        errors.push(error)
        errors.push(handlerError)
      })
    }
  } catch (handlerError) {
    errors.push(error)
    errors.push(handlerError)
  }
}

function disposeWithErrors<
  Scope extends InferdiScope,
  Key extends string,
>(
  scope: Scope,
  context: InferdiElysiaLifecycleContext<Scope, Key>,
  disposeScope: (
    scope: Scope,
    context: InferdiElysiaLifecycleContext<Scope, Key>
  ) => MaybePromise<void>,
  onDisposeError:
    | ((
      error: unknown,
      context: InferdiElysiaLifecycleContext<Scope, Key>
    ) => MaybePromise<void>)
    | undefined,
  errors: unknown[]
): void | PromiseLike<void> {
  try {
    const disposing = disposeScope(scope, context)
    if (isPromiseLike(disposing)) {
      return disposing.then(
        undefined,
        (error) => handleDisposeError(error, context, onDisposeError, errors)
      )
    }
  } catch (error) {
    return handleDisposeError(error, context, onDisposeError, errors)
  }
}

function logUnhandledDisposeErrors<
  Scope extends InferdiScope,
  Key extends string,
>(
  errors: unknown[],
  context: InferdiElysiaLifecycleContext<Scope, Key>
): void {
  if (errors.length === 0) return

  const err = errors.length === 1
    ? errors[0]
    : new AggregateError(errors, 'InferDI Elysia request cleanup failed')

  try {
    console.error('Failed to dispose InferDI Elysia request scope', {
      err,
      phase: context.phase
    })
  } catch {
    // 响应清理不能因为兜底 logger 自己挂了而失败
  }
}

async function disposeAfterSetupFailure<
  Scope extends InferdiScope,
  Key extends string,
>(
  scope: Scope,
  request: Request,
  setupError: unknown,
  key: Key,
  disposeScope: (
    scope: Scope,
    context: InferdiElysiaLifecycleContext<Scope, Key>
  ) => MaybePromise<void>,
  onDisposeError:
    | ((
      error: unknown,
      context: InferdiElysiaLifecycleContext<Scope, Key>
    ) => MaybePromise<void>)
    | undefined
): Promise<never> {
  /*
   * 发现 2：只向外抛出最初的 setup 错误；清理失败走 `onDisposeError`，
   * 否则记录日志——绝不聚合进抛出的错误里
   */
  const errors: unknown[] = []
  const disposeContext = lifecycleContext(
    key,
    scope,
    request,
    'setup',
    setupError
  )
  const disposing = disposeWithErrors(
    scope,
    disposeContext,
    disposeScope,
    onDisposeError,
    errors
  )

  await disposing

  logUnhandledDisposeErrors(errors, disposeContext)
  throw setupError
}

/**
 * 把当前 Elysia 请求标记为「由应用代码手动释放」。
 *
 * 插件会在 `onAfterResponse` 中释放请求 scope，而 Elysia 在响应产生后
 * 就运行该钩子——对于用户自建的流式 `Response` 或 `ReadableStream`，
 * 那是响应头和第一个 chunk 发出之后，而不是流排空之后。任何在 `return`
 * 之后还继续使用 scoped 服务的路由（`ReadableStream`、SSE、WebSocket
 * 交接，或后台工作）**必须**先调用它，并在那部分工作结束时自行释放 scope；
 * 否则 scope 会在流中途被拆掉。在普通请求上调用它会导致 scope 泄漏，
 * 因为插件不再拥有释放权。
 *
 * 跳过只作用于成功的 `afterResponse` 路径：如果请求失败，记录的错误会
 * 强制释放，所以半途而废的流仍会释放它的 scope。
 *
 * 跳过以 `Request` 身份记录在进程全局集合里，所以单次调用会抑制该请求上
 * 所有 InferDI 插件实例的释放——且只影响该请求。这是刻意的：无论挂载了
 * 多少插件都只需调用一次，又不必污染 Elysia 上下文。
 *
 * @param context - 当前 Elysia 上下文。
 */
export function skipInferdiDispose(
  context: InferdiElysiaSkipContext
): void {
  skippedRequests.add(context.request)
}

/**
 * 创建一个 Elysia 插件：每个请求打开一个 InferDI 请求 scope，
 * 并以 `di` 暴露。
 *
 * @template Root  - 根容器类型。
 * @template Scope - 请求 scope 类型。
 */
export function inferdiElysia<
  Root extends InferdiRoot,
  Scope extends InferdiScope = InferdiScopeOf<Root>,
>(
  options: Omit<ScopedOptions<Root, 'di', Scope>, 'key'> & {
    readonly key?: 'di'
  }
): InferdiElysiaScopedPlugin<Scope, 'di'>

/**
 * 创建一个 Elysia 插件：每个请求打开一个 InferDI 请求 scope，
 * 并以自定义上下文键暴露。
 *
 * @template Root  - 根容器类型。
 * @template Key   - Elysia 上下文键。
 * @template Scope - 请求 scope 类型。
 */
export function inferdiElysia<
  Root extends InferdiRoot,
  Key extends string,
  Scope extends InferdiScope = InferdiScopeOf<Root>,
>(
  options: ScopedOptions<Root, Key, Scope> & {
    readonly key: Key
  }
): InferdiElysiaScopedPlugin<Scope, Key>

/**
 * 创建一个 root-only 的 Elysia 插件：以 `di` 暴露根容器，
 * 不安装任何请求 scope 生命周期钩子。
 *
 * @template Root - 根容器类型。
 */
export function inferdiElysia<
  Root extends InferdiRoot,
>(
  options: Omit<RootOnlyOptions<Root, 'di'>, 'key'> & {
    readonly key?: 'di'
  }
): InferdiElysiaRootPlugin<Root, 'di'>

/**
 * 创建一个 root-only 的 Elysia 插件：以自定义上下文键暴露根容器，
 * 不安装任何请求 scope 生命周期钩子。
 *
 * @template Root - 根容器类型。
 * @template Key  - Elysia 上下文键。
 */
export function inferdiElysia<
  Root extends InferdiRoot,
  Key extends string,
>(
  options: RootOnlyOptions<Root, Key> & {
    readonly key: Key
  }
): InferdiElysiaRootPlugin<Root, Key>

export function inferdiElysia(options: unknown): unknown {
  const typedOptions = options as BaseOptions
  const root = typedOptions.container
  const key = typedOptions.key ?? 'di'
  const scoped = typedOptions.scopePerRequest !== false
  const instanceId = ++pluginInstanceId
  const seed = {
    key,
    scopePerRequest: scoped,
    instanceId
  }

  if (!scoped) {
    return new Elysia({
      name: '@inferdi/elysia',
      seed
    }).decorate(key, root)
  }

  const requestState = new WeakMap<Request, RequestState>()
  const hasCustomCreateScope = typedOptions.createScope !== undefined
  const hasSetupScope = typedOptions.setupScope !== undefined
  const hasCustomDisposeScope = typedOptions.disposeScope !== undefined
  const hasDisposeErrorHandler = typedOptions.onDisposeError !== undefined
  /*
   * `autoDispose: true` 就是默认释放语义，所以它和省略 `autoDispose` 一样
   * 走同步默认路径，与 Fastify/Hono 一致。只有 `false` 值、谓词函数、
   * 自定义 `disposeScope`，或 `onDisposeError` 接收器才需要 `disposeOnce` 路径
   */
  const useDefaultDisposePath =
    !hasCustomDisposeScope &&
    (typedOptions.autoDispose === undefined ||
      typedOptions.autoDispose === true) &&
    !hasDisposeErrorHandler
  const createScope =
    typedOptions.createScope ??
    ((root: BaseRoot) => root.createScope())
  const setupScope = typedOptions.setupScope
  const setupValidatedScope = typedOptions.setupValidatedScope
  const disposeScope =
    typedOptions.disposeScope ??
    ((scope: BaseScope) => scope.dispose())
  const autoDispose = typedOptions.autoDispose
  const onDisposeError = typedOptions.onDisposeError

  function disposeDefaultOnce(
    request: Request
  ): void | PromiseLike<void> {
    const state = requestState.get(request)

    if (state === undefined) return

    const scope = state.scope
    const phase = state.hasError ? 'error' as const : 'afterResponse' as const
    const error = state.error
    requestState.delete(request)

    if (phase === 'afterResponse' && skippedRequests.has(request)) return

    /*
     * dispose() 同步时保持同步：这里不用 `async`，这样同步拆卸会在同一
     * tick 内完成，不额外排微任务。只有真正异步的 dispose 才返回 promise
     * 让 Elysia 去 await
     */
    try {
      const disposing = scope.dispose()
      if (isPromiseLike(disposing)) {
        return disposing.then(undefined, (disposeError) => {
          logUnhandledDisposeErrors(
            [disposeError],
            lifecycleContext(key, scope, request, phase, error)
          )
        })
      }
    } catch (disposeError) {
      logUnhandledDisposeErrors(
        [disposeError],
        lifecycleContext(key, scope, request, phase, error)
      )
    }
  }

  async function disposeOnce(request: Request) {
    const state = requestState.get(request)

    if (state === undefined) return

    const scope = state.scope
    const phase = state.hasError ? 'error' as const : 'afterResponse' as const
    const error = state.error
    requestState.delete(request)

    if (phase === 'afterResponse' && skippedRequests.has(request)) return

    const disposeContext = lifecycleContext(
      key,
      scope,
      request,
      phase,
      error
    )
    const errors: unknown[] = []
    let shouldDispose = autoDispose !== false

    if (typeof autoDispose === 'function') {
      try {
        const autoDisposeResult = autoDispose(disposeContext)
        shouldDispose = isPromiseLike(autoDisposeResult)
          ? await autoDisposeResult !== false
          : autoDisposeResult !== false
      } catch (autoDisposeError) {
        shouldDispose = true
        const handling = handleDisposeError(
          autoDisposeError,
          disposeContext,
          onDisposeError,
          errors
        )
        if (isPromiseLike(handling)) {
          await handling
        }
      }
    }

    if (shouldDispose) {
      const disposing = disposeWithErrors(
        scope,
        disposeContext,
        disposeScope,
        onDisposeError,
        errors
      )
      if (isPromiseLike(disposing)) {
        await disposing
      }
    }

    /*
     * Elysia 在响应产生之后才调度 `onAfterResponse`；清理失败必须保持
     * 可观测，又不能破坏响应
     */
    logUnhandledDisposeErrors(errors, disposeContext)
  }

  const plugin = new Elysia({
    name: '@inferdi/elysia',
    seed
  })

  const withScope = !hasCustomCreateScope && !hasSetupScope
    ? plugin.derive('plugin', (context) => {
      const scope = root.createScope()

      requestState.set(context.request, { scope, hasError: false })

      return {
        [key]: scope
      }
    })
    : plugin.derive('plugin', async (context) => {
      const scope = await createScope(root, context)

      try {
        requestState.set(context.request, { scope, hasError: false })

        if (setupScope !== undefined) {
          await setupScope(scope, context)
        }

        return {
          [key]: scope
        }
      } catch (error) {
        requestState.delete(context.request)
        skippedRequests.delete(context.request)
        await disposeAfterSetupFailure(
          scope,
          context.request,
          error,
          key,
          disposeScope,
          onDisposeError
        )
      }
    })

  let withValidatedScope = withScope as Elysia

  if (setupValidatedScope !== undefined) {
    const setupValidatedScopeHook = setupValidatedScope

    withValidatedScope = withValidatedScope.derive(
      'plugin',
      async (context: any) => {
        const state = requestState.get(context.request)

        /* v8 ignore start -- 不变量：resolve 只在 derive 打开 scope 之后运行；
           除非 Elysia 改变钩子顺序，否则不可达 */
        if (state === undefined) {
          throw new Error(
            '@inferdi/elysia: request scope is unavailable in ' +
            'setupValidatedScope; the derive hook did not open a scope ' +
            'before resolve ran'
          )
        }
        /* v8 ignore stop */

        await setupValidatedScopeHook(
          state.scope,
          context as InferdiElysiaValidatedContext<BaseScope, string>
        )

        return {}
      }
    )
  }

  /*
   * 释放钩子只读 `request`（解构出来的），从不读整个 context。
   * Elysia 的 Sucrose 会静态分析每个生命周期处理器；一旦某个处理器把
   * 完整 `context` 传给另一个函数，它就会把 *所有* `body`/`query`/
   * `cookie`/`headers` 标记为需要——迫使 Elysia 在本插件作用域的每个
   * 请求上都解析它们。只碰 `request` 能让该推断保持为空，于是适配器对
   * 没有主动索要这些字段的路由不增加任何请求期解析开销。`request`
   * 本身不是受推断门控的字段。
   */
  return withValidatedScope
    .error('plugin', ({ request, error }) => {
      const state = requestState.get(request)
      if (state !== undefined) {
        state.hasError = true
        state.error = error
      }
    })
    .afterResponse('plugin', async ({ request }) =>
      useDefaultDisposePath
        ? disposeDefaultOnce(request)
        : disposeOnce(request)
    )
}