import { describe, it, expect } from 'vitest'
import { parseDuration } from '../../src/duration.js'

describe('parseDuration', () => {
  it('parses milliseconds', () => {
    expect(parseDuration('100ms')).toBe(100)
  })

  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000)
  })

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000)
  })

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000)
    expect(parseDuration('12h')).toBe(43_200_000)
  })

  it('parses days', () => {
    expect(parseDuration('1d')).toBe(86_400_000)
  })

  it('parses weeks', () => {
    expect(parseDuration('1w')).toBe(604_800_000)
  })

  it('parses decimal values', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000)
    expect(parseDuration('0.5s')).toBe(500)
  })

  it('throws on invalid input', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration')
    expect(() => parseDuration('30')).toThrow('Invalid duration')
    expect(() => parseDuration('s30')).toThrow('Invalid duration')
    expect(() => parseDuration('')).toThrow('Invalid duration')
    expect(() => parseDuration('30x')).toThrow('Invalid duration')
  })

  it('throws on zero duration', () => {
    expect(() => parseDuration('0s')).toThrow('duration must be greater than 0')
    expect(() => parseDuration('0m')).toThrow('duration must be greater than 0')
    expect(() => parseDuration('0ms')).toThrow('duration must be greater than 0')
  })
})
