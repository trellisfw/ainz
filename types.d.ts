declare module '@oada/oada-cache' {
  import { AxiosRequestConfig, AxiosResponse } from 'axios'

  export type Options = {
    domain: string
    token: string
    cache?: boolean
  }

  export interface OADAConnection {
    put(config: OADARequestConfig): Promise<OADAResponse>
    get(
      config: OADARequestConfig & { watch?: OADAWatchConfig }
    ): Promise<OADAResponse>
  }

  export function connect (options: Options): Promise<OADAConnection>

  export interface OADARequestConfig extends AxiosRequestConfig {
    path?: string
    tree?: object
  }

  export interface OADAWatchConfig {
    payload?: any
    callback: (ctx: OADAChangeResponse & OADAWatchConfig['payload']) => any
  }

  export interface OADAResponse extends AxiosResponse {}

  export interface OADAChangeResponse {
    response: {
      change: {
        type: 'merge' | 'delete'
        body: any
      }
    }
  }
}
