import type { Component } from "@workspace/htmx";

// ── 基础组件（无状态，纯渲染；模块间通过 import 复用） ──

export const Button: Component<{
  label?: string;
  variant?: "primary" | "ghost" | "danger";
  type?: string;
  small?: boolean;
  hxGet?: string;
  hxPost?: string;
  hxDelete?: string;
  hxTarget?: string;
  hxSwap?: string;
  hxConfirm?: string;
}> = ({ label, variant = "primary", type = "button", small, hxGet, hxPost, hxDelete, hxTarget, hxSwap, hxConfirm }) => {
  const cls = {
    primary: "bg-brass-500 text-harbor-950 font-semibold hover:bg-brass-600",
    ghost: "border border-harbor-700 text-neutral-400 hover:bg-harbor-800 hover:text-neutral-200",
    danger: "text-signal-500 border border-transparent hover:bg-signal-500/10",
  }[variant];
  return (
    <button
      class={`inline-flex items-center justify-center rounded transition-colors ${small ? "px-2 py-0.5 text-xs" : "px-3 py-1.5 text-sm"} ${cls}`}
      type={type}
      hx-get={hxGet}
      hx-post={hxPost}
      hx-delete={hxDelete}
      hx-target={hxTarget}
      hx-swap={hxSwap}
      hx-confirm={hxConfirm}
    >
      {label ?? "按钮"}
    </button>
  );
};

export const Badge: Component<{
  label: string;
  tone?: "ok" | "warn" | "err" | "muted";
}> = ({ label, tone = "muted" }) => {
  const cls = {
    ok: "bg-tide-400/10 text-tide-400",
    warn: "bg-brass-500/15 text-brass-500",
    err: "bg-signal-500/15 text-signal-500",
    muted: "bg-harbor-800 text-neutral-500",
  }[tone];
  return <span class={`rounded px-1.5 py-0.5 text-[11px] font-medium mono ${cls}`}>{label}</span>;
};

/** 视图页头：标题 + 副标题 + 右侧操作区 */
export const PageHeader: Component<{ title: string; sub?: string }> = ({ title, sub, children }) => (
  <div class="flex h-14 shrink-0 items-center justify-between border-b border-harbor-800 px-6">
    <div class="flex items-baseline gap-3">
      <h2 class="text-sm font-semibold tracking-wide text-neutral-100">{title}</h2>
      {sub ? <span class="text-xs text-neutral-500">{sub}</span> : null}
    </div>
    <div class="flex items-center gap-2">{children}</div>
  </div>
);

export const Field: Component<{ label: string; name: string; type?: string; placeholder?: string; value?: string; required?: boolean }> = ({
  label, name, type = "text", placeholder, value, required,
}) => (
  <label class="flex flex-col gap-1 text-sm">
    <span class="text-xs text-neutral-500">{label}</span>
    <input
      class="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-brass-500"
      type={type}
      name={name}
      placeholder={placeholder ?? ""}
      value={value ?? ""}
      {...(required ? { required: true } : {})}
    />
  </label>
);

export const Empty: Component<{ text: string }> = ({ text }) => (
  <div class="flex flex-1 items-center justify-center text-sm text-neutral-600">
    {text}
  </div>
);

// 默认导出保持模块约定（无 controller 时 GET /ui-kit/ui 渲染）
const UiKit: Component = () => <div class="text-sm text-neutral-400">ui-kit 组件库（无独立页面）</div>;
export default UiKit;
