/** client 的 fetch 助手：JSON 进出，错误统一抛 Error(message)。
 *  端点分流：部署语境在 /api/deploy/*（api），画布原生在 /api/canvas/*（canvasApi） */
import { routes } from "../../../../.elysiax/routes.gen";

export const api = routes.pages.deploy;
export const canvasApi = routes.pages.canvas;

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await errText(res));
  return (await res.json()) as T;
}

export async function sendJSON<T = { ok: true }>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await errText(res));
  if (res.status === 204) return { ok: true } as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : { ok: true }) as T;
}

async function errText(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { error?: string; message?: string };
    return j.error ?? j.message ?? text;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

export const postJSON = <T>(url: string, body?: unknown) => sendJSON<T>("POST", url, body);
export const patchJSON = <T>(url: string, body?: unknown) => sendJSON<T>("PATCH", url, body);
export const putJSON = <T>(url: string, body?: unknown) => sendJSON<T>("PUT", url, body);
export const delJSON = <T>(url: string) => sendJSON<T>("DELETE", url);
