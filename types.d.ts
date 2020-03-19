declare module '@oada/oada-cache' {
  import { AxiosRequestConfig, AxiosResponse } from 'axios'

  export type Options = {
    domain: string
    token: string
    cache?: boolean
  }

  export interface OADAConnection {
    get(
      config: OADARequestConfig & { watch?: OADAWatchConfig }
    ): Promise<OADAResponse>
    put(config: OADARequestConfig): Promise<OADAResponse>
    post(config: OADARequestConfig): Promise<OADAResponse>
    del(
      config: OADARequestConfig & { unwatch?: boolean }
    ): Promise<OADAResponse>
  }

  export function connect (options: Options): Promise<OADAConnection>

  export type OADATree = {
    _type?: string
    _rev?: number
  } & Partial<{
    [key: string]: OADATree
  }>
  export interface OADARequestConfig extends AxiosRequestConfig {
    path: string
    tree?: OADATree
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
