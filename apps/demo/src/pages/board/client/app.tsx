/** @jsxImportSource react */
/** 看板 client 页根组件（L5 整页 client）：三列 + 新增 + 按钮移动/删除。
 *  保持最小：不引第三方组件库，样式用内联 style。 */
import { useCallback, useEffect, useState } from "react";
import type { Card, Column } from "../board.socket";
import { api, unwrap } from "./api";

const COLUMNS: { key: Column; title: string }[] = [
  { key: "todo", title: "待办" },
  { key: "doing", title: "进行中" },
  { key: "done", title: "完成" },
];

export function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    unwrap(api.cards.get())
      .then(setCards)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(refresh, [refresh]);

  /** 统一动作出口：成功后整体重拉（看板数据量小，最简方案） */
  const run = (p: Promise<unknown>) => {
    setError(null);
    void p.then(refresh).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)));
  };

  const add = () => {
    if (!title.trim()) return;
    run(unwrap(api.cards.post({ title })));
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

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24, fontFamily: "system-ui" }}>
      <h1>看板</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="新卡片标题"
          style={{ flex: 1, padding: "6px 8px" }}
        />
        <button onClick={add}>新增</button>
      </div>
      {error ? <p style={{ color: "crimson" }}>{error}</p> : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        {COLUMNS.map((col) => (
          <section
            key={col.key}
            style={{ background: "#f4f4f5", borderRadius: 8, padding: 12, minHeight: 200 }}
          >
            <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>
              {col.title}（{cards.filter((c) => c.column === col.key).length}）
            </h2>
            {cards
              .filter((c) => c.column === col.key)
              .map((card) => (
                <article
                  key={card.id}
                  style={{
                    background: "#fff",
                    borderRadius: 6,
                    padding: "8px 10px",
                    marginBottom: 8,
                    boxShadow: "0 1px 2px rgba(0,0,0,.08)",
                  }}
                >
                  <div style={{ marginBottom: 6 }}>{card.title}</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button onClick={() => shift(card, -1)} disabled={col.key === "todo"}>←</button>
                    <button onClick={() => shift(card, 1)} disabled={col.key === "done"}>→</button>
                    <button onClick={() => remove(card)} style={{ marginLeft: "auto" }}>×</button>
                  </div>
                </article>
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}
