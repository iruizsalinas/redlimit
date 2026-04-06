export interface RedisAdapter {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>
  del(...keys: string[]): Promise<number>
  set(key: string, value: string, px: number): Promise<void>
  get(key: string): Promise<string | null>
  pttl(key: string): Promise<number>
}

export type Duration = `${number}${'ms' | 's' | 'm' | 'h' | 'd' | 'w'}`

export type Algorithm = 'fixed-window' | 'sliding-window' | 'token-bucket'

interface BaseConfig {
  redis: unknown
  prefix?: string
  fail?: 'open' | 'closed'
  ban?: BanConfig
}

export interface WindowConfig extends BaseConfig {
  algorithm: 'fixed-window' | 'sliding-window'
  limit: number
  window: Duration
}

export interface RefillConfig {
  amount: number
  interval: Duration
}

export interface TokenBucketConfig extends BaseConfig {
  algorithm: 'token-bucket'
  limit: number
  refill: RefillConfig
}

export type LimiterConfig = WindowConfig | TokenBucketConfig

export interface BanConfig {
  escalation: Duration[]
  history: Duration
  shared?: string
}

export interface LimitOptions {
  cost?: number
}

export interface LimiterResult {
  success: boolean
  remaining: number
  reset: number
  limit: number
  headers: LimiterHeaders
}

export interface LimiterHeaders {
  'RateLimit-Limit': string
  'RateLimit-Remaining': string
  'RateLimit-Reset': string
  'Retry-After'?: string
}

// What Lua scripts return: [status (1=allowed, 0=denied, -1=already blocked), remaining, resetMs, nowMs]
export type LuaResult = [number, number, number, number]

export interface AlgorithmHandler {
  limit(
    adapter: RedisAdapter,
    prefix: string,
    banPrefix: string,
    identifier: string,
    maxLimit: number,
    windowMs: number,
    refillRate: number,
    cost: number,
    banArgs: string[] | null,
  ): Promise<LuaResult>

  peek(
    adapter: RedisAdapter,
    prefix: string,
    banPrefix: string,
    identifier: string,
    maxLimit: number,
    windowMs: number,
    refillRate: number,
  ): Promise<LuaResult>

  reset(
    adapter: RedisAdapter,
    prefix: string,
    banPrefix: string,
    identifier: string,
    windowMs: number,
    clearBanHistory: boolean,
  ): Promise<void>
}
