/**
 * 全局 toast 与 htmx 响应处理配置（page-architecture.md 7.2/7.3/7.6）。
 * AppLayout 默认包含 ToastScripts + <div id="toast-root">，应用可覆盖。
 *
 * 脚本是"一次性初始化"的零星 JS（<50 行）：监听 HX-Trigger 带出的
 * toast 事件与 htmx:responseError，不持有业务状态。
 */

/** htmx 全局响应处理：422 也参与 swap（写操作失败回显表单片段），4xx/5xx 不 swap */
export const responseHandlingScript = `
if (window.htmx) htmx.config.responseHandling = [
  { code: '204', swap: false },
  { code: '[23]..', swap: true },
  { code: '422', swap: true },
  { code: '[45]..', swap: false, error: true }
];`

const toastScript = `
(function () {
  var root = document.getElementById('toast-root');
  if (!root) return;
  function show(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast toast-' + (kind || 'info');
    el.setAttribute('role', 'status');
    el.textContent = message;
    root.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }
  document.body.addEventListener('toast', function (e) {
    var d = e.detail || {};
    // 消息经 encodeURIComponent 进响应头（latin1 限制），此处解码；解码失败按原文显示
    (Array.isArray(d) ? d : [d]).forEach(function (t) {
      var m = t.message;
      try { m = decodeURIComponent(m); } catch (_) {}
      show(m, t.kind);
    });
  });
  document.body.addEventListener('htmx:responseError', function (e) {
    // 优先展示服务端 { error } 文本（ServiceError 约定），兜底状态码
    var msg = '请求失败（' + e.detail.xhr.status + '）';
    try {
      var j = JSON.parse(e.detail.xhr.responseText);
      if (j && typeof j.error === 'string') msg = j.error;
    } catch (_) {}
    show(msg, 'error');
  });
})();`

/**
 * hx-confirm 的样式化确认框（替代原生 confirm）：拦截 htmx:confirm（仅带
 * hx-confirm 属性的请求），用 layout 里的全局 <dialog id="hx-confirm-dialog">
 * 单例展示。原生 <dialog>.showModal() 自带 Esc（closedby="closerequest"）、
 * 焦点约束、::backdrop 遮罩——行为语义与 Solid 侧 Kobalte Dialog 对齐。
 * 确认 → issueRequest(true) 放行原请求；取消/Esc → 关闭，请求中止。
 */
export const confirmScript = `
(function () {
  var dlg = document.getElementById('hx-confirm-dialog');
  if (!dlg) return;
  var q = dlg.querySelector('[data-confirm-question]');
  var okBtn = dlg.querySelector('[data-confirm-ok]');
  var pending = null;
  document.body.addEventListener('htmx:confirm', function (e) {
    var elt = e.detail && e.detail.elt;
    if (!elt || !elt.hasAttribute('hx-confirm')) return;
    e.preventDefault();
    pending = e.detail;
    q.textContent = e.detail.question || '确认操作？';
    dlg.showModal();
  });
  okBtn.addEventListener('click', function () {
    var d = pending; pending = null;
    dlg.close();
    if (d) d.issueRequest(true);
  });
  dlg.addEventListener('close', function () { pending = null; });
})();`

/** AppLayout 里 <ConfirmScript /> 一次引入（需配合 #hx-confirm-dialog 单例 markup） */
export function ConfirmScript() {
  return (
    <script>
      {confirmScript}
    </script>
  )
}

/** AppLayout 里 <ToastScripts /> 一次引入两段启动脚本 */
export function ToastScripts() {
  return (
    <script>
      {responseHandlingScript + toastScript}
    </script>
  )
}

/** toast 容器：放在 body 尾部，样式由应用 L4 提供（.toast / .toast-*） */
export function ToastRoot() {
  return <div id="toast-root" aria-live="polite" />
}
