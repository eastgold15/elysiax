import home from './src/pages/index.html'
import about from './src/pages/about.html'

const staticServer = Bun.serve({
  port: 0,
  routes: { '/': home, '/about': about },
  fetch() { return new Response('unreachable') },
})

// 直接调用 .fetch,模拟 Elysia mount 时的请求
const res = await staticServer.fetch(new Request('http://localhost:3000/'))
console.log('status:', res.status, 'type:', res.headers.get('content-type'))
console.log('body head:', JSON.stringify((await res.text()).slice(0, 150)))
