import { createElement as h, type Children } from '@kitajs/html'

// attrs 类型透传上游签名（@kitajs/html 的 createElement 第二参，本身是
// PropsWithChildren<any>）——不在框架层重新声明 any，符合 no-any 规则
export const createElement = (
  name: string | Function,
  attrs: Parameters<typeof h>[1],
  ...children: Children[]
) => {
  const { $elysia, ...attr } = attrs ?? {}

  return h(name, attr, ...children)
}