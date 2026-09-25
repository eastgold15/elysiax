
import { Elysia, t } from 'elysia'
import type { TSchema } from 'elysia/type';

export const responseFormat = new Elysia({ name: 'response-format' })
  .macro({


    envelope: {

      afterHandle: (Context) => {
        console.log('Context01111111111111111111111111', Context)
        let res = Context.responseValue
        return {
          ...Context,
          responseValue: {
            code: 0,
            data: res,
            message: 'success',
          }
        }
      },
      mapResponse:(con)=>{

        con.responseValue
      }

    }


  })

  .as('global')