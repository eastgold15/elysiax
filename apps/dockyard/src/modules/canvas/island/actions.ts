import { routes } from "../../../../.elysiax/routes.gen";
/**
 * 岛 → 服务端片段的桥：模态框（变量/域名/日志/新建目标）仍是 htmx 服务端渲染，
 * 岛里按钮只是调全局 htmx.ajax 把片段灌进 #modal-root。
 * 这些请求成功后服务端会 HX-Trigger: refresh，board.tsx 监听 body 的 refresh 事件重拉画布。
 */

interface Htmx {
  ajax(verb: string, url: string, opts: { target?: string; swap: string }): Promise<void>;
}
declare const htmx: Htmx;

export const openModal = (url: string) =>
  htmx.ajax("GET", url, { target: "#modal-root", swap: "innerHTML" });

/** Railway 式体验：点部署即打开日志面板盯进度（modal 内 1s 轮询到终态） */
export const deployTarget = async (targetId: number) => {
  await htmx.ajax("POST", routes.deploy.targetsByIdDeploy(targetId), { swap: "none" });
  await openModal(routes.deploy.uiTargetsByIdLog(targetId));
};

/** NodeResizer 拉伸结束 → 持久化手动尺寸（refetch 后作自动收敛的下限） */
export const persistServerSize = (nodeId: number, w: number, h: number) =>
  fetch(routes.canvas.nodesById(nodeId), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ w: Math.round(w), h: Math.round(h) }),
  });

export const persistTargetSize = (targetId: number, w: number, h: number) =>
  fetch(routes.deploy.targetsByIdLayout(targetId), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ w: Math.round(w), h: Math.round(h) }),
  });

export const removeTarget = async (t: { id: number; name: string; logical: boolean }) => {
  const hint = t.logical
    ? `移除逻辑库「${t.name}」的记录？（远端数据库保留，不会 DROP）`
    : `移除部署目标「${t.name}」？（远端容器不动）`;
  if (!confirm(hint)) return;
  const res = await fetch(routes.deploy.targetsById(t.id), { method: "DELETE" });
  // 例如：实例下还有逻辑库，被阻止（409 + 错误文本）
  if (!res.ok) alert(await res.text());
  document.body.dispatchEvent(new Event("refresh"));
};
