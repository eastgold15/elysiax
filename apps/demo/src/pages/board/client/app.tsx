/** @jsxImportSource solid-js */
/** 看板 client 页根组件（L5 整页 client）：三列 + 新增 + 按钮移动/删除。
 *  Solid 版：组件函数只跑一次，状态变 → 精确更新对应 DOM 节点；
 *  保持最小：不引第三方组件库，样式用内联 style（字符串形式）。 */
import { createSignal, For, onMount, Show } from "solid-js";
import type { Card, Column } from "../board.socket";
import { api, unwrap } from "./api";

const COLUMNS: { key: Column; title: string }[] = [
  { key: "todo", title: "待办" },
  { key: "doing", title: "进行中" },
  { key: "done", title: "完成" },
];

export function App() {
  const [cards, setCards] = createSignal<Card[]>([]);
  const [title, setTitle] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  const refresh = () => {
    unwrap(api.cards.get())
      .then(setCards)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  onMount(refresh);

  /** 统一动作出口：成功后整体重拉（看板数据量小，最简方案） */
  const run = (p: Promise<unknown>) => {
    setError(null);
    void p.then(refresh).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)));
  };

  const add = () => {
    if (!title().trim()) return;
    run(unwrap(api.cards.post({ title: title() })));
    setTitle("");
  };

  /** 左移/右移一列（dir=-1 往 todo，dir=1 往 done）；越界则不动作 */
  const shift = (card: Card, dir: -1 | 1) => {
    const idx = COLUMNS.findIndex((c) => c.key === card.column);
    const next = COLUMNS[idx + dir];
    if (!next) return;
    run(unwrap(api.cards({ id: card.id }).patch({ column: next.key })));
  };

  const remove = (card: Card) => {
    run(unwrap(api.cards({ id: card.id }).delete()));
  };

  /** 按列过滤：普通函数即派生状态，Solid 自动追踪依赖 */
  const inColumn = (key: Column) => cards().filter((c) => c.column === key);

  return (
    <div style="max-width: 960px; margin: 0 auto; padding: 24px; font-family: system-ui">
      <h1>看板（Solid）</h1>
      <div style="display: flex; gap: 8px; margin-bottom: 16px">
        <input
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="新卡片标题"
          style="flex: 1; padding: 6px 8px"
        />
        <button onClick={add}>新增</button>
      </div>
      <Show when={error()}>
        <p style="color: crimson">{error()}</p>
      </Show>
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px">
        <For each={COLUMNS}>
          {(col) => (
            <section style="background: #f4f4f5; border-radius: 8px; padding: 12px; min-height: 200px">
              <h2 style="margin: 0 0 8px; font-size: 16px">
                {col.title}（{inColumn(col.key).length}）
              </h2>
              <For each={inColumn(col.key)}>
                {(card) => (
                  <article style="background: #fff; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.08)">
                    <div style="margin-bottom: 6px">{card.title}</div>
                    <div style="display: flex; gap: 4px">
                      <button onClick={() => shift(card, -1)} disabled={col.key === "todo"}>←</button>
                      <button onClick={() => shift(card, 1)} disabled={col.key === "done"}>→</button>
                      <button onClick={() => remove(card)} style="margin-left: auto">×</button>
                    </div>
                  </article>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}
