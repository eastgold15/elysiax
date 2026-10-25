import type { Component } from "@workspace/htmx";
import { routes } from "../../../.elysiax";
import type { Todo } from "./schema";

/** 单条待办（切换/删除后整表刷新，故单项无独立 id 锚点） */
const TodoItem: Component<{ todo: Todo }> = ({ todo }) => (
  <li class="flex items-center gap-3 py-2">
    <button
      hx-post={routes.pages.todo.ByIdToggle(todo.id)}
      hx-target="#todo-list"
      hx-swap="outerHTML"
      class={`rounded-md border px-2 py-0.5 text-xs ${
        todo.done
          ? "border-emerald-600 text-emerald-400"
          : "border-gray-600 text-gray-400"
      }`}
    >
      {todo.done ? "已完成" : "未完成"}
    </button>
    <span class={todo.done ? "text-gray-500 line-through" : ""}>{todo.title}</span>
    <span class="ml-auto text-xs text-gray-600">{todo.createdAt.slice(0, 10)}</span>
    <button
      hx-delete={routes.pages.todo.ById(todo.id)}
      hx-target="#todo-list"
      hx-swap="outerHTML"
      class="rounded-md px-2 py-0.5 text-xs text-red-400 hover:bg-red-950"
    >
      删除
    </button>
  </li>
);

/** 待办列表（整页与所有写操作后的片段刷新共用） */
export const TodoList: Component<{ todos: Todo[] }> = ({ todos }) => (
  <div id="todo-list" class="space-y-4">
    <h2 class="text-lg font-semibold">待办列表</h2>
    {todos.length === 0 ? (
      <p class="text-sm text-gray-500">暂无待办，添加一条吧。</p>
    ) : (
      <ul class="divide-y divide-gray-700">
        {todos.map((todo) => (
          <TodoItem todo={todo} />
        ))}
      </ul>
    )}
    <form
      hx-post={routes.pages.todo.index()}
      hx-target="#todo-list"
      hx-swap="outerHTML"
      class="flex gap-2"
    >
      <input
        name="title"
        required
        placeholder="要做点什么？"
        class="rounded-md border border-gray-700 bg-transparent px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        class="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
      >
        添加
      </button>
    </form>
  </div>
);
