import type { LayoutComponent } from "@elysiax/htmx";

/**
 * 全局壳注册：全站唯一一个 AppLayout（<html><head>、导航、toast 容器）。
 * 准入条件：纯视觉边框，不查业务数据、不感知 URL 属于哪个页面
 * （page-architecture.md L0）。应用入口定义一次：
 *
 * ```tsx
 * // src/app.layout.tsx
 * export default defineLayout(({ title, content }) => (
 *   <html>
 *     <head><title>{title}</title></head>
 *     <body><Nav />{content}<ToastRoot /></body>
 *   </html>
 * ));
 * ```
 */
let layout: LayoutComponent | undefined;

export function defineLayout(component: LayoutComponent): LayoutComponent {
  if (layout)
    console.warn("[elysiax] defineLayout 被调用多次，后者覆盖前者");
  layout = component;
  return component;
}

export function getLayout(): LayoutComponent | undefined {
  return layout;
}
