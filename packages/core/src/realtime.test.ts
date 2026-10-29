/**
 * SSE 流回归点：
 * - 快照是异步的（查库/查服务），它等待期间的推送不能丢——否则客户端停在旧状态等下一条事件
 * - 快照仍必须是首帧，期间事件接在其后（对快照的增量修正）
 * - cancel（客户端断开）与快照抛错都要退订，不能泄漏订阅/心跳
 */
import { expect, test } from "bun:test";
import { defineRealtime } from "./realtime";

type Msg = { type: string; n: number };

/** 读够 n 帧（按 \n\n 切）后断开 */
async function readFrames(res: Response, n: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: string[] = [];
  let buf = "";
  while (frames.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i = buf.indexOf("\n\n");
    while (i >= 0) {
      frames.push(buf.slice(0, i));
      buf = buf.slice(i + 2);
      i = buf.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return frames;
}

/** 等订阅建立（generator 跑到 subscribe 那一行） */
async function waitSubs(rt: { hasSubs: (ch: string) => boolean }, ch: string) {
  for (let i = 0; i < 100 && !rt.hasSubs(ch); i++) await new Promise((r) => setTimeout(r, 0));
  expect(rt.hasSubs(ch)).toBe(true);
}

const dataOf = (frame: string) => frame.split("\n").find((l) => l.startsWith("data: "))!.slice(6);

test("stream：快照等待期间的推送不丢失，且快照排在最前", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const rt = defineRealtime<Msg>({
    snapshot: async () => {
      await gate;
      return [{ type: "snapshot", n: 0 }];
    },
  });

  const res = rt.stream("ch");
  await waitSubs(rt, "ch");
  // 快照还挂着时推一条：旧实现这里没人接，事件直接蒸发
  rt.publish("ch", { type: "event", n: 1 });
  release();

  const frames = await readFrames(res, 2);
  expect(dataOf(frames[0]!)).toBe('{"type":"snapshot","n":0}');
  expect(dataOf(frames[1]!)).toBe('{"type":"event","n":1}');
});

test("stream：无快照时直接收推送", async () => {
  const rt = defineRealtime<Msg>();
  const res = rt.stream("ch");
  await waitSubs(rt, "ch");
  rt.publish("ch", { type: "event", n: 9 });
  const [frame] = await readFrames(res, 1);
  expect(dataOf(frame!)).toBe('{"type":"event","n":9}');
});

test("stream：客户端断开后退订（hasSubs 归零，轮询器可跳过无观众的活）", async () => {
  const rt = defineRealtime<Msg>();
  const res = rt.stream("ch");
  await waitSubs(rt, "ch");
  // 不读帧直接 cancel：generator 正挂在 await 上，wake 必须能把它唤醒跑 finally
  await res.body!.cancel();
  for (let i = 0; i < 100 && rt.hasSubs("ch"); i++) await new Promise((r) => setTimeout(r, 0));
  expect(rt.hasSubs("ch")).toBe(false);
});

test("stream：快照抛错时退订，不泄漏", async () => {
  const rt = defineRealtime<Msg>({
    snapshot: async () => {
      throw new Error("snapshot boom");
    },
  });
  const res = rt.stream("ch");
  await waitSubs(rt, "ch");
  await expect(readFrames(res, 1)).rejects.toThrow(/snapshot boom/);
  for (let i = 0; i < 100 && rt.hasSubs("ch"); i++) await new Promise((r) => setTimeout(r, 0));
  expect(rt.hasSubs("ch")).toBe(false);
});
