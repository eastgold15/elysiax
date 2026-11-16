/**
 * InferDI 的 Elysia 请求作用域插件。
 *
 * 为每个 Elysia 请求创建一个 InferDI scope，挂到请求上下文上，并通过
 * 受保护的 error/afterResponse 生命周期钩子释放它。本包只做生命周期胶水。
 *
 * 清理绑定在 `onAfterResponse`：如果运行时没走到这个钩子（连接在响应产生前
 * 中断，或进程中途退出），`dispose()` 不会被调用。每个请求的 scope 记在
 * `WeakMap` 里，`Request` 不可达后记账自动回收；但 scope 持有的资源只有
 * `dispose()` 真正执行时才释放。
 *
 * @module
 */
import { Elysia } from 'elysia'

/** 可释放的 InferDI 请求 scope 的最小结构性契约。 */
export interface InferdiScope {
  /** 释放该 scope 拥有的一切。实现应保持幂等。 */
  dispose(): void | Promise<void>
}

/** 交给插件的根容器的结构性契约。 */
export interface InferdiRoot<Scope extends InferdiScope = InferdiScope> {
  /** 打开一个新的请求 scope。scoped 模式下每个请求调用一次。 */
  createScope(): Scope
}

/**
 * Elysia 上下文片段：在某个上下文键下暴露一个值。
 * 同时用于 scoped 模式（值为 scope）和 root-only 模式（值为根容器）。
 */
export type InferdiElysiaContext<
  T,
  Key extends string = 'di',
> = { [P in Key]: T }

/** 触发请求 scope 清理的生命周期阶段。 */
export type InferdiElysiaLifecyclePhase = 'setup' | 'error' | 'afterResponse'

/**
 * 传给 scope 创建与 setup 钩子的请求期 Elysia 上下文。schema 钉死，
 * 避免放宽成 `Context<any, any>` 后类型塌缩。
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

/** 传给清理相关钩子的窄上下文。 */
export type InferdiElysiaLifecycleContext<
  Scope extends InferdiScope,
  Key extends string = 'di',
> = {
  readonly request: Request
  readonly phase: InferdiElysiaLifecyclePhase
  readonly error?: unknown
} & Partial<InferdiElysiaContext<Scope, Key>>

/** 传给 `setupValidatedScope` 的上下文。 */
export type InferdiElysiaValidatedContext<
  Scope extends InferdiScope,
  Key extends string = 'di',
> = InferdiElysiaRequestContext & InferdiElysiaContext<Scope, Key>

/**
 * 默认 scoped 模式的选项：每个请求一个请求 scope，暴露在 Elysia 上下文上，
 * 并在有界请求工作结束后释放。
 */
export type ScopedOptions<
  Root extends InferdiRoot,
  Key extends string,
  Scope extends InferdiScope = ReturnType<Root['createScope']>,
> = {
  readonly container: Root
  /** Elysia 上下文键，默认 `'di'`。 */
  readonly key?: Key
  /** Scoped 模式标记。省略或设为 `true` 即保持每请求 scope。 */
  readonly scopePerRequest?: true
  /** 覆盖请求 scope 的创建方式，默认 `root.createScope()`。可为异步。 */
  readonly createScope?: (
    root: Root,
    context: InferdiElysiaRequestContext
  ) => Scope | Promise<Scope>
  /** 在路由处理器能读到 scope 之前，给刚创建的 scope 注入数据。 */
  readonly setupScope?: (
    scope: Scope,
    context: InferdiElysiaRequestContext
  ) => void | Promise<void>
  /** 用已校验的请求数据注入 scope。跑在 Elysia 校验之后、处理器之前。 */
  readonly setupValidatedScope?: (
    scope: Scope,
    context: InferdiElysiaValidatedContext<Scope, Key>
  ) => void | Promise<void>
  /** 覆盖请求 scope 的释放，默认 `scope.dispose()`。 */
  readonly disposeScope?: (
    scope: Scope,
    context: InferdiElysiaLifecycleContext<Scope, Key>
  ) => void | Promise<void>
  /** 控制插件是否释放请求 scope。`false` 即把释放责任交给应用代码。 */
  readonly autoDispose?: boolean
  /**
   * 可选谓词：返回 `false` 即把释放责任交给应用代码。与 `autoDispose`
   * 同时出现时，`false` 优先。
   */
  readonly shouldAutoDispose?: (
    context: InferdiElysiaLifecycleContext<Scope, Key>
  ) => boolean | Promise<boolean>
  /** 清理失败的可选接收器。未提供时用 `console.error` 记录。 */
  readonly onDisposeError?: (
    error: unknown,
    context: InferdiElysiaLifecycleContext<Scope, Key>
  ) => void | Promise<void>
}

/**
 * root-only 模式（`scopePerRequest: false`）的选项：通过 Elysia 上下文
 * 暴露根容器，不安装任何请求 scope 钩子。
 */
export type RootOnlyOptions<
  Root extends InferdiRoot,
  Key extends string,
> = {
  readonly container: Root
  readonly key?: Key
  readonly scopePerRequest: false
  readonly createScope?: never
  readonly setupScope?: never
  readonly setupValidatedScope?: never
  readonly disposeScope?: never
  readonly autoDispose?: never
  readonly shouldAutoDispose?: never
  readonly onDisposeError?: never
}

/** 插件选项。对 `scopePerRequest` 的可辨识联合。 */
export type InferdiElysiaOptions<
  Root extends InferdiRoot,
  Key extends string,
  Scope extends InferdiScope = ReturnType<Root['createScope']>,
> =
  | ScopedOptions<Root, Key, Scope>
  | RootOnlyOptions<Root, Key>

/** scoped InferDI 模式返回的 Elysia 插件类型。 */
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

/** root-only InferDI 模式返回的 Elysia 插件类型。 */
export type InferdiElysiaRootPlugin<
  Root extends InferdiRoot,
  Key extends string,
> = Elysia<
  '',
  'local',
  {
    decorator: InferdiElysiaContext<Root, Key>
    store: {}
    derive: {}
  }
>

/* ------------------------------------------------------------------ */
/* 内部实现                                                            */
/* ------------------------------------------------------------------ */

type BaseScope = InferdiScope
type BaseRoot = InferdiRoot<BaseScope>
type BaseOptions = InferdiElysiaOptions<BaseRoot, string, BaseScope>

/** 每请求的记账数据。 */
type RequestState =
  | { readonly scope: BaseScope; readonly status: 'ok' }
  | { readonly scope: BaseScope; readonly status: 'error'; readonly error: unknown }

/*
 * 刻意做成进程全局：以唯一的 `Request` 身份为键，单次
 * `skipInferdiDispose(context)` 调用即可抑制该请求上所有插件实例的释放。
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
    ) => void | Promise<void>)
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
  ) => void | Promise<void>,
  onDisposeError:
    | ((
      error: unknown,
      context: InferdiElysiaLifecycleContext<Scope, Key>
    ) => void | Promise<void>)
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
  ) => void | Promise<void>,
  onDisposeError:
    | ((
      error: unknown,
      context: InferdiElysiaLifecycleContext<Scope, Key>
    ) => void | Promise<void>)
    | undefined
): Promise<never> {
  /* 只向外抛出最初的 setup 错误；清理失败走 onDisposeError 或记日志 */
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
 * 插件在 `onAfterResponse` 释放请求 scope，而 Elysia 在响应产生后就运行
 * 该钩子——对于流式 `Response` 或 `ReadableStream`，那是响应头和第一个
 * chunk 发出之后，而不是流排空之后。任何在 `return` 之后还继续使用
 * scoped 服务的路由（`ReadableStream`、SSE、WebSocket 交接，或后台工作）
 * **必须**先调用它，并在那部分工作结束时自行释放 scope。
 *
 * 跳过只作用于成功的 `afterResponse` 路径：请求失败时记录的错误会强制
 * 释放。跳过以 `Request` 身份记录在进程全局集合里，单次调用抑制该请求
 * 上所有 InferDI 插件实例的释放。
 */
export function skipInferdiDispose(
  context: { readonly request: Request }
): void {
  skippedRequests.add(context.request)
}

/**
 * 创建一个 Elysia 插件：每个请求打开一个 InferDI 请求 scope，
 * 并以 `key`（默认 `di`）暴露；`scopePerRequest: false` 时只暴露根容器。
 */
export function inferdiElysia<
  Root extends InferdiRoot,
  Key extends string = 'di',
>(
  options: Root extends InferdiRoot<infer S>
    ? (ScopedOptions<Root, Key, S> & { readonly key?: Key }) | (RootOnlyOptions<Root, Key> & { readonly key?: Key })
    : never
): Root extends InferdiRoot<infer S>
  ? ScopedOptions<Root, Key, S> extends { scopePerRequest: false }
  ? InferdiElysiaRootPlugin<Root, Key>
  : InferdiElysiaScopedPlugin<S, Key>
  : never

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
   * 默认释放语义（autoDispose 省略或 true、无 shouldAutoDispose、无自定义
   * disposeScope、无 onDisposeError）走同步默认路径。
   */
  const useDefaultDisposePath =
    !hasCustomDisposeScope &&
    typedOptions.autoDispose !== false &&
    typedOptions.shouldAutoDispose === undefined &&
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
  const shouldAutoDispose = typedOptions.shouldAutoDispose
  const onDisposeError = typedOptions.onDisposeError

  function disposeDefaultOnce(
    request: Request
  ): void | PromiseLike<void> {
    const state = requestState.get(request)

    if (state === undefined) return

    const { scope } = state
    const phase = state.status === 'error' ? 'error' as const : 'afterResponse' as const
    const error = state.status === 'error' ? state.error : undefined
    requestState.delete(request)

    if (phase === 'afterResponse' && skippedRequests.has(request)) return

    /*
     * dispose() 同步时保持同步：不用 async，同步拆卸在同一 tick 内完成。
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

    const { scope } = state
    const phase = state.status === 'error' ? 'error' as const : 'afterResponse' as const
    const error = state.status === 'error' ? state.error : undefined
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

    if (shouldDispose && shouldAutoDispose !== undefined) {
      try {
        const result = shouldAutoDispose(disposeContext)
        shouldDispose = isPromiseLike(result)
          ? await result !== false
          : result !== false
      } catch (predicateError) {
        shouldDispose = true
        const handling = handleDisposeError(
          predicateError,
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

    logUnhandledDisposeErrors(errors, disposeContext)
  }

  const plugin = new Elysia({
    name: '@inferdi/elysia',
    seed
  })

  const withScope = !hasCustomCreateScope && !hasSetupScope
    ? plugin.derive('plugin', (context) => {
      const scope = root.createScope()

      requestState.set(context.request, { scope, status: 'ok' })

      return {
        [key]: scope
      }
    })
    : plugin.derive('plugin', async (context) => {
      const scope = await createScope(root, context)

      try {
        requestState.set(context.request, { scope, status: 'ok' })

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
      // any：derive 的 context 泛型在本插件边界不可表达，下方立即收窄
      async (context: any) => {
        const state = requestState.get(context.request)

        /* v8 ignore start -- 不变量：resolve 只在 derive 打开 scope 之后运行 */
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
   * 释放钩子只解构 `request`，从不读整个 context。Elysia 的 Sucrose 会
   * 静态分析生命周期处理器；一旦把完整 context 传给另一个函数，它会把
   * 所有 body/query/cookie/headers 标记为需要，迫使 Elysia 在每个请求上
   * 解析它们。只碰 `request` 能让该推断保持为空。
   */
  return withValidatedScope
    .onError('plugin', ({ request, error }) => {
      const state = requestState.get(request)
      if (state !== undefined) {
        requestState.set(request, { scope: state.scope, status: 'error', error })
      }
    })
    .onAfterResponse('plugin', async ({ request }) =>
      useDefaultDisposePath
        ? disposeDefaultOnce(request)
        : disposeOnce(request)
    )
}