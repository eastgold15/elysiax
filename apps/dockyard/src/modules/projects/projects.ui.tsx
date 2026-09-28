import type { Component } from "@workspace/htmx";
import type { Project } from "../../shared/schema";
import { configFile } from "../../shared/config";
import type { RepoBrief } from "../github/github.service";
import type { LocalProject } from "./local.service";
import { Button, Empty, PageHeader } from "../ui-kit/ui-kit.ui";

export interface ProjectListModel {
  local: LocalProject[];
  /** 绑定了 GitHub 仓库但不在本地扫描结果里的项目空间 */
  remote: Project[];
  editors: string[];
  defaultEditor: string;
  lazygit: boolean;
}

/** 编辑器 split-button：主按钮 = 默认编辑器直接开；下拉换一个（服务端会把它记为新默认） */
const EditorPicker: Component<{ path: string; editors: string[]; defaultEditor: string }> = ({
  path,
  editors,
  defaultEditor,
}) => {
  if (editors.length === 0) return <></>;
  const current = editors.includes(defaultEditor) ? defaultEditor : editors[0]!;
  const vals = `js:{path:${JSON.stringify(path)}}`;
  return (
    <div class="flex items-center" {...{ onclick: "event.stopPropagation()" }}>
      <button
        class="rounded-l border border-harbor-700 px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:bg-harbor-800 hover:text-brass-500"
        hx-post="/api/projects/open"
        hx-vals={`js:{path:${JSON.stringify(path)},tool:${JSON.stringify(current)}}`}
        hx-swap="none"
        {...{ "hx-on::response-error": "alert(event.detail.xhr.responseText)" }}
      >
        {current} 打开
      </button>
      <select
        class="-ml-px rounded-r border border-harbor-700 bg-harbor-900 px-1 py-1 text-xs text-neutral-500 outline-none hover:text-neutral-300"
        name="tool"
        hx-post="/api/projects/open"
        hx-trigger="change"
        hx-vals={vals}
        hx-swap="none"
        title="选择编辑器（选中即设为默认）"
        {...{ "hx-on::response-error": "alert(event.detail.xhr.responseText)" }}
      >
        {editors.map((e) => (
          <option value={e} selected={e === current}>
            {e}
          </option>
        ))}
      </select>
    </div>
  );
};

const ProjectList: Component<ProjectListModel> = ({ local, remote, editors, defaultEditor, lazygit }) => (
  <div class="flex h-full flex-col">
    <PageHeader title="项目" sub={`本地 ${local.length} · 远程 ${remote.length}`}>
      <Button label="⚙ 扫描目录" variant="ghost" hxGet="/api/projects/ui/config" hxTarget="#modal-root" hxSwap="innerHTML" />
      <Button label="＋ 从 GitHub 创建" hxGet="/api/projects/ui/new" hxTarget="#modal-root" hxSwap="innerHTML" />
    </PageHeader>

    {local.length === 0 && remote.length === 0 ? (
      <Empty text="扫描目录下没有发现项目——点右上角「⚙ 扫描目录」检查配置" />
    ) : (
      <div class="flex-1 overflow-auto">
        {local.map((p) => (
          <div
            class="group flex h-12 cursor-pointer items-center gap-4 border-b border-harbor-800/60 px-6 hover:bg-harbor-900"
            hx-get={`/api/canvas/ui/local?path=${encodeURIComponent(p.path)}`}
            hx-target="#main"
            hx-swap="innerHTML"
          >
            <span class="text-sm font-medium text-neutral-100 group-hover:text-brass-500">{p.name}</span>
            <span class="mono text-xs text-neutral-600">{p.path}</span>
            {p.hasGit ? (
              <span class="rounded bg-harbor-800 px-1.5 py-0.5 text-[11px] text-neutral-500 mono">git</span>
            ) : null}
            {p.remote ? <span class="mono text-xs text-brass-500/80">⌥ {p.remote}</span> : null}
            <div class="ml-auto flex items-center gap-2">
              {lazygit ? (
                <button
                  class="rounded border border-harbor-700 px-2.5 py-1 text-xs text-neutral-400 transition-colors hover:bg-harbor-800 hover:text-neutral-200"
                  hx-post="/api/projects/open"
                  hx-vals={`js:{path:${JSON.stringify(p.path)},tool:"lazygit"}`}
                  hx-swap="none"
                  {...{
                    onclick: "event.stopPropagation()",
                    "hx-on::response-error": "alert(event.detail.xhr.responseText)",
                  }}
                >
                  lazygit
                </button>
              ) : null}
              <EditorPicker path={p.path} editors={editors} defaultEditor={defaultEditor} />
              {p.registeredId ? (
                <span
                  {...{ onclick: "event.stopPropagation()" }}
                >
                  <Button
                    label="删除"
                    variant="danger"
                    small
                    hxDelete={`/api/projects/${p.registeredId}`}
                    hxTarget="#main"
                    hxSwap="innerHTML"
                    hxConfirm={`删除项目「${p.name}」及其画布与部署配置？（不会删除本地文件）`}
                  />
                </span>
              ) : null}
            </div>
          </div>
        ))}

        {remote.length > 0 ? (
          <div class="px-6 pt-5 pb-1 text-xs font-medium tracking-wide text-neutral-600">GitHub 项目空间（本地未检出）</div>
        ) : null}
        {remote.map((p) => (
          <div
            class="group flex h-12 cursor-pointer items-center gap-4 border-b border-harbor-800/60 px-6 hover:bg-harbor-900"
            hx-get={`/api/canvas/ui/${p.id}`}
            hx-target="#main"
            hx-swap="innerHTML"
          >
            <span class="text-sm font-medium text-neutral-100 group-hover:text-brass-500">{p.name}</span>
            <span class="mono text-xs text-neutral-600">{p.slug}</span>
            {p.repoUrl ? <span class="mono text-xs text-brass-500/80">⌥ {p.repoUrl}</span> : null}
            <span class="mono ml-auto text-xs text-neutral-600">{p.createdAt.toLocaleDateString("zh-CN")}</span>
            <span {...{ onclick: "event.stopPropagation()" }}>
              <Button
                label="删除"
                variant="danger"
                small
                hxDelete={`/api/projects/${p.id}`}
                hxTarget="#main"
                hxSwap="innerHTML"
                hxConfirm={`删除项目「${p.name}」及其画布与部署配置？`}
              />
            </span>
          </div>
        ))}
      </div>
    )}
  </div>
);

export default ProjectList;

// ── 扫描目录配置弹窗：一行一个目录，支持 ~/ ──
export const ConfigModal: Component<{ scanDirs: string[] }> = ({ scanDirs }) => (
  <div class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onclick="if(event.target===this)this.remove()">
    <div class="fixed top-1/2 left-1/2 flex w-[26rem] max-w-full -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-harbor-700 bg-harbor-900 shadow-2xl">
      <div class="flex items-start justify-between border-b border-harbor-800 px-5 py-4">
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-semibold text-neutral-100">扫描目录</h3>
          <p class="text-xs text-neutral-500">浅扫一级子目录，含 .git 或 package.json 即识别为项目</p>
        </div>
        <button class="text-neutral-500 hover:text-neutral-200" onclick="this.closest('.fixed.inset-0').remove()">✕</button>
      </div>
      <form class="flex flex-col gap-3 px-5 py-4" hx-post="/api/projects/config" hx-target="#main" hx-swap="innerHTML">
        <textarea
          class="h-28 rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none mono focus:border-brass-500"
          name="scanDirs"
          spellcheck="false"
        >
          {scanDirs.join("\n")}
        </textarea>
        <p class="mono text-[11px] text-neutral-600">{configFile}</p>
        <button
          type="submit"
          class="inline-flex items-center justify-center rounded bg-brass-500 px-3 py-1.5 text-sm font-semibold text-harbor-950 transition-colors hover:bg-brass-600"
        >
          保存并重新扫描
        </button>
      </form>
    </div>
  </div>
);

// ── 新建项目弹窗：项目 = 仓库，gh CLI 列出账号仓库直接选；也可跳过绑定纯数据库项目 ──
export const NewProjectModal: Component<{ repos: RepoBrief[]; error?: string }> = ({ repos, error }) => (
  <div class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onclick="if(event.target===this)this.remove()">
    <div class="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[30rem] max-w-full -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-harbor-700 bg-harbor-900 shadow-2xl">
      <div class="flex items-start justify-between border-b border-harbor-800 px-5 py-4">
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-semibold text-neutral-100">新建项目</h3>
          <p class="text-xs text-neutral-500">项目 = 仓库：项目画布就是这个仓库的部署视图</p>
        </div>
        <button class="text-neutral-500 hover:text-neutral-200" onclick="this.closest('.fixed.inset-0').remove()">✕</button>
      </div>

      <form
        class="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4"
        hx-post="/api/projects"
        hx-target="#main"
        hx-swap="innerHTML"
        {...{ "hx-on::response-error": "alert(event.detail.xhr.responseText)" }}
      >
        <input
          id="np-name"
          class="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-brass-500"
          type="text"
          name="name"
          placeholder="项目名"
          required
          {...{ oninput: "this.dataset.touched='1'" }}
        />
        <input
          class="rounded border border-harbor-700 bg-harbor-950 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-brass-500"
          type="text"
          placeholder="筛选仓库…"
          {...{ oninput: "const q=this.value.toLowerCase();this.closest('form').querySelectorAll('[data-repo]').forEach(el=>el.classList.toggle('hidden',!el.dataset.repo.includes(q)))" }}
        />
        <div class="min-h-0 flex-1 overflow-y-auto rounded border border-harbor-800">
          <label class="flex cursor-pointer items-center gap-2 border-b border-harbor-800/60 px-3 py-2 text-sm text-neutral-400 hover:bg-harbor-800/60 has-checked:bg-harbor-800">
            <input type="radio" name="repoUrl" value="" checked class="accent-brass-500" />
            跳过，不绑定仓库（纯数据库项目）
          </label>
          {repos.map((r) => (
            <label
              data-repo={r.fullName.toLowerCase()}
              class="flex cursor-pointer items-center gap-2 border-b border-harbor-800/60 px-3 py-2 text-sm text-neutral-200 hover:bg-harbor-800/60 has-checked:bg-harbor-800"
              {...{ onclick: `const n=document.getElementById('np-name');if(!n.dataset.touched)n.value='${r.fullName.split("/")[1]}'` }}
            >
              <input type="radio" name="repoUrl" value={r.fullName} class="accent-brass-500" />
              <span class="mono truncate">{r.fullName}</span>
              {r.private ? <span class="rounded bg-harbor-800 px-1 py-0.5 text-[10px] text-neutral-500">private</span> : null}
              <span class="mono ml-auto shrink-0 text-[11px] text-neutral-600">{r.branch}</span>
            </label>
          ))}
        </div>
        {error ? <p class="text-xs text-brass-500">{error}</p> : null}
        <button
          type="submit"
          class="inline-flex items-center justify-center gap-2 rounded bg-brass-500 px-3 py-1.5 text-sm font-semibold text-harbor-950 transition-colors hover:bg-brass-600 [.htmx-request_&]:pointer-events-none [.htmx-request_&]:opacity-70"
        >
          <span class="htmx-indicator animate-spin">◌</span>
          <span class="[.htmx-request_&]:hidden">创建项目</span>
          <span class="htmx-indicator">创建中…</span>
        </button>
      </form>
    </div>
  </div>
);
