import { Elysia, t } from 'elysia'
// 'Html' is required for JSX support but not required for string HTML
import { html, Html } from '@workspace/htmx'

const app = new Elysia()
  .use(html())
  .get(
    '/html',
    () => `
            <html lang='en'>
                <head>
                    <title>Hello World</title>
                </head>
                <body>
                    <h1>Hello World</h1>
                </body>
            </html>`
  )
  .get('/jsx', {
    query: t.Object({
      name: t.String()
    })


  }, ({ query: { name } }) => {
    return name
  })
  .listen(3000)

console.log(`Server running on http://localhost:${app.server?.port}`)