import { createAdapter } from './adapter.js'
import { parseDuration } from './duration.js'
import { fixedWindow } from './algorithms/fixed-window.js'
import { slidingWindow } from './algorithms/sliding-window.js'
import { tokenBucket } from './algorithms/token-bucket.js'
import type {
  Algorithm,
  AlgorithmHandler,
  Duration,
  LimitOptions,
  LimiterConfig,
  LimiterResult,
  RedisAdapter,
} from './types.js'

const SUPPORTED_ALGORITHMS = new Set<Algorithm>([
  'fixed-window',
  'sliding-window',
  'token-bucket',
])

function validateKeyPrefix(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined

  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string. Got: ${String(value)}`)
  }

  if (value.includes('{') || value.includes('}')) {
    throw new Error(
      `${name} must not contain "{" or "}" because Redis Cluster key hashing relies on reserved hash-tag braces.`
    )
  }

  return value
}

function validateHashTagComponent(name: string, value: string): void {
  if (value.includes('{') || value.includes('}')) {
    throw new Error(
      `${name} must not contain "{" or "}" because Redis Cluster key hashing relies on reserved hash-tag braces.`
    )
  }
}

export class Limiter {
  private adapter: RedisAdapter
  private algorithm: AlgorithmHandler
  private limitValue: number
  private windowMs: number
  private refillRate: number
  private prefix: string
  private fail: 'open' | 'closed'
  private banArgs: string[] | null
  private banPrefix: string

  constructor(config: LimiterConfig) {
    if (!Number.isInteger(config.limit) || config.limit <= 0) {
      throw new Error(`limit must be a positive integer. Got: ${config.limit}`)
    }

    const algorithm = config.algorithm as string
    if (!SUPPORTED_ALGORITHMS.has(algorithm as Algorithm)) {
      throw new Error(
        `Unsupported algorithm: "${algorithm}". Expected "fixed-window", "sliding-window", or "token-bucket".`
      )
    }

    if (config.fail !== undefined && config.fail !== 'open' && config.fail !== 'closed') {
      throw new Error(
        `fail must be "open" or "closed". Got: ${String(config.fail)}`
      )
    }

    const prefix = validateKeyPrefix('prefix', config.prefix) ?? 'rl'

    if (config.ban) {
      if (!Array.isArray(config.ban.escalation) || config.ban.escalation.length === 0) {
        throw new Error('ban.escalation must be a non-empty array of durations.')
      }
      const stepsMs = config.ban.escalation.map((d) => parseDuration(d))
      const historyMs = parseDuration(config.ban.history)
      this.banArgs = [
        String(stepsMs.length),
        String(historyMs),
        ...stepsMs.map(String),
      ]
      this.banPrefix = validateKeyPrefix('ban.shared', config.ban.shared) ?? prefix
    } else {
      this.banArgs = null
      this.banPrefix = prefix
    }

    this.adapter = createAdapter(config.redis)
    this.prefix = prefix
    this.fail = config.fail ?? 'closed'
    this.limitValue = config.limit

    if (config.algorithm === 'token-bucket') {
      if (config.refillRate <= 0 || !Number.isFinite(config.refillRate)) {
        throw new Error(`refillRate must be a positive number. Got: ${config.refillRate}`)
      }
      this.refillRate = config.refillRate
      this.windowMs = 0
      this.algorithm = tokenBucket
    } else {
      if (typeof config.window !== 'string') {
        throw new Error(
          `window is required when algorithm is "${config.algorithm}".`
        )
      }

      this.windowMs = parseDuration(config.window)
      this.refillRate = 0
      this.algorithm = config.algorithm === 'fixed-window' ? fixedWindow : slidingWindow
    }
  }

  private validateIdentifier(identifier: string): void {
    if (typeof identifier !== 'string' || !identifier) {
      throw new Error(`identifier must be a non-empty string. Got: ${String(identifier)}`)
    }
    validateHashTagComponent('identifier', identifier)
  }

  async limit(identifier: string, options?: LimitOptions): Promise<LimiterResult> {
    this.validateIdentifier(identifier)
    const cost = options?.cost ?? 1

    if (!Number.isInteger(cost) || cost < 1) {
      throw new Error(`cost must be a positive integer. Got: ${cost}`)
    }

    if (cost > this.limitValue) {
      throw new Error(
        `cost (${cost}) exceeds limit (${this.limitValue}). Request can never succeed.`
      )
    }

    let result: [number, number, number, number]
    try {
      result = await this.algorithm.limit(
        this.adapter,
        this.prefix,
        this.banPrefix,
        identifier,
        this.limitValue,
        this.windowMs,
        this.refillRate,
        cost,
        this.banArgs,
      )
    } catch (err) {
      if (this.fail === 'open') {
        const now = Date.now()
        return this.buildResult(true, this.limitValue, now, now)
      }
      throw err
    }

    const [success, remaining, resetMs, nowMs] = result

    return this.buildResult(success === 1, remaining, resetMs, nowMs)
  }

  async peek(identifier: string): Promise<LimiterResult> {
    this.validateIdentifier(identifier)
    try {
      const [success, remaining, resetMs, nowMs] = await this.algorithm.peek(
        this.adapter,
        this.prefix,
        this.banPrefix,
        identifier,
        this.limitValue,
        this.windowMs,
        this.refillRate,
      )
      return this.buildResult(success === 1, remaining, resetMs, nowMs)
    } catch (err) {
      if (this.fail === 'open') {
        const now = Date.now()
        return this.buildResult(true, this.limitValue, now, now)
      }
      throw err
    }
  }

  async reset(identifier: string): Promise<void> {
    this.validateIdentifier(identifier)
    await this.algorithm.reset(
      this.adapter,
      this.prefix,
      this.banPrefix,
      identifier,
      this.windowMs,
      this.banArgs !== null,
    )
  }

  async block(identifier: string, duration: Duration): Promise<void> {
    this.validateIdentifier(identifier)
    const ms = parseDuration(duration)
    const key = `${this.banPrefix}:{${identifier}}:blocked`
    await this.adapter.set(key, '1', ms)
  }

  private buildResult(
    success: boolean,
    remaining: number,
    resetMs: number,
    nowMs: number,
  ): LimiterResult {
    const resetSec = Math.max(0, Math.ceil((resetMs - nowMs) / 1000))
    const resetAppTime = Date.now() + (resetMs - nowMs)
    const safeRemaining = Math.max(0, remaining)
    return {
      success,
      remaining: safeRemaining,
      reset: resetAppTime,
      limit: this.limitValue,
      headers: {
        'RateLimit-Limit': String(this.limitValue),
        'RateLimit-Remaining': String(safeRemaining),
        'RateLimit-Reset': String(resetSec),
        ...(!success && { 'Retry-After': String(resetSec) }),
      },
    }
  }
}
