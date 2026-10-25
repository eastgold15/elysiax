/** @jsxImportSource solid-js */
/**
 * 画布 client 页根组件：项目解析（?project=<id> / ?path=<本地路径> / 缺省最近项目）
 * + 页头（项目切换）+ Board + DrawerHost（Solid 模态层）。
 */
import { createSignal, Match, onMount, Show, Switch } from "solid-js";
import { canvasApi, unwrap } from "./api";
import { Board } from "./board";
import { DeployLogModal, DomainsModal, EnvDrawer, NewAppWizard, NewDbModal, ServiceDrawer } from "./drawers";
import { emitRefresh, UiContext, type UiBus, type View } from "./ui";

interface ProjectBrief { id: number; name: string }

/** URL → projectId：?project=<id> 直接用；?path=<本地路径> 幂等落库；缺省取最近项目 */
async function resolveProject(): Promise<number | null> {
  const q = new URLSearchParams(location.search);
  const path = q.get("path");
  if (path) {
    const r = await unwrap(canvasApi["resolve-local"].get({ query: { path } }));
    return r.projectId;
  }
  const project = q.get("project");
  if (project) return Number(project);
  try {
    const r = await unwrap(canvasApi.latest.get());
    return r.projectId;
  } catch {
    return null;
  }
}

/** 按 kind 收窄 view（给 Match 的 when 用，顺带带出该分支的字段类型） */
const viewAs = <K extends View["kind"]>(k: K, v: View) => (v.kind === k ? (v as Extract<View, { kind: K }>) : null);

function DrawerHost(props: { view: View }) {
  return (
    <Switch>
      <Match when={viewAs("new-app", props.view)}>{(v) => <NewAppWizard nodeId={v().nodeId} />}</Match>
      <Match when={viewAs("new-db", props.view)}>{(v) => <NewDbModal nodeId={v().nodeId} />}</Match>
      <Match when={viewAs("service", props.view)}>
        {(v) => <ServiceDrawer targetId={v().targetId} svc={v().svc} initialTab={v().tab} />}
      </Match>
      <Match when={viewAs("env", props.view)}>{(v) => <EnvDrawer targetId={v().targetId} />}</Match>
      <Match when={viewAs("domains", props.view)}>{(v) => <DomainsModal targetId={v().targetId} />}</Match>
      <Match when={viewAs("log", props.view)}>{(v) => <DeployLogModal targetId={v().targetId} dep={v().dep} />}</Match>
    </Switch>
  );
}

export function App() {
  const [projectId, setProjectId] = createSignal<number | null>(null);
  const [missing, setMissing] = createSignal(false);
  const [projects, setProjects] = createSignal<ProjectBrief[]>([]);
  const [view, setView] = createSignal<View | null>(null);

  onMount(() => {
    resolveProject().then((id) => {
      if (id) setProjectId(id);
      else setMissing(true);
    });
    unwrap(canvasApi.projects.get()).then(setProjects).catch(() => {});
  });

  // bus 是稳定引用：open/close/refresh 全是 setView 的薄壳，无需 memo
  const bus: UiBus = {
    open: setView,
    close: () => setView(null),
    refresh: emitRefresh,
  };

  return (
    <UiContext.Provider value={bus}>
      {/* 整页 client 壳没有 AppLayout：视口高度从这里开始，h-full 链条才有根 */}
      <div class="h-screen">
      <Show when={missing()}>
        <div class="flex h-full items-center justify-center text-sm text-neutral-500">
          先创建一个项目空间（左侧「项目」）
        </div>
      </Show>
      <Show when={!missing() && !projectId()}>
        <div class="flex h-full items-center justify-center text-sm text-neutral-600">加载中…</div>
      </Show>
      <Show when={projectId()}>
        {(pid) => (
          <>
            <div class="flex h-full flex-col">
              <div class="flex h-14 shrink-0 items-center justify-between border-b border-harbor-800 px-6">
                <div class="flex flex-col">
                  <h1 class="text-sm font-semibold text-neutral-100">
                    {projects().find((p) => p.id === pid())?.name ?? "画布"}
                  </h1>
                  <p class="text-xs text-neutral-500">画布 · 空白处右键添加服务器，拖动行尾圆点连线建依赖</p>
                </div>
                <Show when={projects().length > 1}>
                  <select
                    class="rounded border border-harbor-700 bg-harbor-950 px-2 py-1 text-sm text-neutral-300"
                    value={pid()}
                    onChange={(e) => {
                      const id = Number(e.currentTarget.value);
                      history.replaceState(null, "", `/canvas?project=${id}`);
                      setView(null);
                      setProjectId(id);
                    }}
                  >
                    {projects().map((p) => (
                      <option value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </Show>
              </div>
              <div class="relative flex-1">
                <Board projectId={pid()} />
              </div>
            </div>
            {/* keyed：view 换对象即整体重建抽屉，等价 React 版的 key 状态重置 */}
            <Show when={view()} keyed>
              {(v) => <DrawerHost view={v} />}
            </Show>
          </>
        )}
      </Show>
      </div>
    </UiContext.Provider>
  );
}
