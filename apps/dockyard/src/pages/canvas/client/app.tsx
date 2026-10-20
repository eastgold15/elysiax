/** @jsxImportSource react */
/**
 * 画布 client 页根组件：项目解析（?project=<id> / ?path=<本地路径> / 缺省最近项目）
 * + 页头（项目切换）+ Board + DrawerHost（React 模态层，替代 #modal-root + htmx.ajax）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, canvasApi, getJSON } from "./api";
import { Board } from "./board";
import { DeployLogModal, DomainsModal, EnvDrawer, NewAppWizard, NewDbModal, ServiceDrawer } from "./drawers";
import { emitRefresh, UiContext, type UiBus, type View } from "./ui";

interface ProjectBrief { id: number; name: string }

/** URL → projectId：?project=<id> 直接用；?path=<本地路径> 幂等落库；缺省取最近项目 */
async function resolveProject(): Promise<number | null> {
  const q = new URLSearchParams(location.search);
  const path = q.get("path");
  if (path) {
    const r = await getJSON<{ projectId: number }>(`${canvasApi.resolveLocal()}?path=${encodeURIComponent(path)}`);
    return r.projectId;
  }
  const project = q.get("project");
  if (project) return Number(project);
  try {
    const r = await getJSON<{ projectId: number }>(canvasApi.latest());
    return r.projectId;
  } catch {
    return null;
  }
}

function DrawerHost({ view, close }: { view: View; close: () => void }) {
  // 每个 view 一份独立组件实例（key 保证切换 view 时状态重置）
  const key = `${view.kind}-${"nodeId" in view ? view.nodeId : view.targetId}-${"svc" in view ? view.svc ?? "" : ""}`;
  return (
    <div key={key}>
      {view.kind === "new-app" ? <NewAppWizard nodeId={view.nodeId} /> : null}
      {view.kind === "new-db" ? <NewDbModal nodeId={view.nodeId} /> : null}
      {view.kind === "service" ? <ServiceDrawer targetId={view.targetId} svc={view.svc} initialTab={view.tab} /> : null}
      {view.kind === "env" ? <EnvDrawer targetId={view.targetId} /> : null}
      {view.kind === "domains" ? <DomainsModal targetId={view.targetId} /> : null}
      {view.kind === "log" ? <DeployLogModal targetId={view.targetId} dep={view.dep} /> : null}
    </div>
  );
}

export function App() {
  const [projectId, setProjectId] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const [projects, setProjects] = useState<ProjectBrief[]>([]);
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    resolveProject().then((id) => {
      if (id) setProjectId(id);
      else setMissing(true);
    });
    getJSON<ProjectBrief[]>(canvasApi.projects()).then(setProjects).catch(() => {});
  }, []);

  const bus: UiBus = useMemo(() => ({
    open: setView,
    close: () => setView(null),
    refresh: emitRefresh,
  }), []);

  const close = useCallback(() => setView(null), []);

  if (missing) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        先创建一个项目空间（左侧「项目」）
      </div>
    );
  }
  if (!projectId) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-600">加载中…</div>;
  }

  return (
    <UiContext.Provider value={bus}>
      <div className="flex h-full flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-harbor-800 px-6">
          <div className="flex flex-col">
            <h1 className="text-sm font-semibold text-neutral-100">
              {projects.find((p) => p.id === projectId)?.name ?? "画布"}
            </h1>
            <p className="text-xs text-neutral-500">画布 · 空白处右键添加服务器，拖动行尾圆点连线建依赖</p>
          </div>
          {projects.length > 1 ? (
            <select
              className="rounded border border-harbor-700 bg-harbor-950 px-2 py-1 text-sm text-neutral-300"
              value={projectId}
              onChange={(e) => {
                const id = Number(e.target.value);
                history.replaceState(null, "", `/canvas?project=${id}`);
                setView(null);
                setProjectId(id);
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          ) : null}
        </div>
        <div className="relative flex-1">
          <Board projectId={projectId} />
        </div>
      </div>
      {view ? <DrawerHost view={view} close={close} /> : null}
    </UiContext.Provider>
  );
}
