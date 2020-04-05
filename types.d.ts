declare module '@oada/oada-cache' {
  import { AxiosRequestConfig, AxiosResponse } from 'axios'

  export type Options = {
    domain: string
    token: string
    cache?: boolean | { name: string }
    websocket?: boolean
  }

  export interface OADAConnection {
    get<T>(
      config: OADARequestConfig & { watch?: OADAWatchConfig<T> }
    ): Promise<OADAResponse>
    watch<T>(
      config: OADARequestConfig & OADAWatchConfig<T>
    ): Promise<OADAResponse>
    unwatch<T>(callback: OADAWatchConfig<T>['callback']): Promise<void>
    put(config: OADARequestConfig): Promise<OADAResponse>
    post(config: OADARequestConfig): Promise<OADAResponse>
    delete(config: OADARequestConfig): Promise<OADAResponse>
    disconnect(): Promise<void>
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

  export interface OADAWatchConfig<T> {
    payload?: T
    callback: (ctx: OADAChangeResponse & T) => any
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
