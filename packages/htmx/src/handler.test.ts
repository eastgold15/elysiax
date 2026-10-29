/**
 * HTML 响应处理的回归点：isHtml 是启发式（`<` 开头 `>` 结尾），
 * 这里把它决定的三种外部可见行为钉住——
 * 1) 普通字符串响应的 content-type
 * 2) `<!doctype html>` 何时补、何时不补（只补以 <html 开头的）
 * 3) 流式响应只检查第一块，且不会重复补
 */
import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { handleHtml } from "./handler";
import { isHtml, isTagHtml } from "./utils";

const CT = "text/html; charset=utf8";
const opts = { contentType: CT, autoDoctype: true };

test("isHtml：< 开头 > 结尾且长度 ≥ 7 才算（最短 <a></a> 恰为 7）", () => {
  expect(isHtml("<a></a>")).toBe(true);
  expect(isHtml("  <div></div> ")).toBe(true);
  // 最短 HTML 不足 7 字符 → 不认（避免把 <b>x</b> 之外的碎片当 HTML）
  expect(isHtml("<b>x</b>")).toBe(true); // 8 字符
  expect(isHtml("<b>x</b>".slice(0, 6))).toBe(false);
  expect(isHtml("<pending>")).toBe(true); // 已知启发式：非 HTML 但形似，属可接受误判面
  expect(isHtml("plain text >")).toBe(false);
  expect(isHtml('{"a":1}')).toBe(false);
  expect(isHtml(undefined)).toBe(false);
  expect(isHtml(42)).toBe(false);
});

test("isTagHtml：忽略前导空白与大小写，只认 <html", () => {
  expect(isTagHtml("  <HTML lang=\"zh\">")).toBe(true);
  expect(isTagHtml("<head>")).toBe(false);
  expect(isTagHtml("<!doctype html><html>")).toBe(false); // 已经带 doctype 的不算，避免重复补
});

test("handleHtml：普通字符串照原样返回并带 content-type", async () => {
  const res = handleHtml("<p>hi</p>", opts, false) as Response;
  expect(res.headers.get("content-type")).toBe(CT);
  expect(await res.text()).toBe("<p>hi</p>");
});

test("handleHtml：调用方已设 content-type 时不覆盖", async () => {
  const res = handleHtml("<p>hi</p>", opts, true) as Response;
  expect(res.headers.get("content-type")).toBe(null);
});

test("handleHtml：autoDoctype 只给 <html 开头的补 doctype", async () => {
  const page = handleHtml("<html><body></body></html>", opts, false) as Response;
  expect(await page.text()).toBe("<!doctype html><html><body></body></html>");
  const frag = handleHtml("<div>x</div>", opts, false) as Response;
  expect(await frag.text()).toBe("<div>x</div>");
  const off = handleHtml("<html><body></body></html>", { contentType: CT, autoDoctype: false }, false) as Response;
  expect(await off.text()).toBe("<html><body></body></html>");
});

test("handleHtml：Promise 入参解包后走同一路径", async () => {
  const res = (await handleHtml(Promise.resolve("<p>x</p>"), opts, false)) as Response;
  expect(await res.text()).toBe("<p>x</p>");
});

test("handleHtml：流只检查第一块，不会在后续块重复补 doctype", async () => {
  const stream = Readable.from(["<html><body>", "<html>inner</html>", "</body></html>"]);
  const res = handleHtml(stream as unknown as Readable, opts, false) as Response;
  expect(await res.text()).toBe("<!doctype html><html><body><html>inner</html></body></html>");
});
