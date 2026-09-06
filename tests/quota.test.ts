import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AdvisorGroupService } from '../src/service'
import type { Config } from '../src/config'

/**
 * quota (daily cap) behavior: configurable limit, default 50, and fully
 * disableable — with the counter still accumulating for display.
 */

const BASE_CONFIG: Config = {
  enabled: true,
  discussion: {
    maxRounds: 2,
    maxAdvisorsPerCall: 3,
    parallel: true,
    autoDeepen: true,
    stopOnConsensus: false,
    advisorTimeoutMs: 120000,
  },
  trigger: {
    requireClassifier: true,
    allowWebFallback: true,
    confidenceThreshold: 0.6,
  },
  ui: {
    theme: 'retro-green',
    showTimestamps: true,
    autoExpand: true,
  },
  quota: {
    enabled: true,
    maxPerDay: 50,
  },
  advisors: [],
}

function makeService(overrides?: Partial<Config['quota']>): AdvisorGroupService {
  const config: Config = {
    ...BASE_CONFIG,
    quota: { ...BASE_CONFIG.quota, ...overrides },
  }
  const ctx = { on: () => {} } as unknown as Context
  const service = new AdvisorGroupService(ctx, config)
  activeServices.push(service)
  return service
}

let dshHome: string
let savedHome: string | undefined
const activeServices: AdvisorGroupService[] = []

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'advisor-group-quota-'))
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
})

afterEach(async () => {
  await Promise.all(activeServices.splice(0).map((service) => service.flushPersistence()))
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(dshHome, { recursive: true, force: true })
})

describe('quota: default cap', () => {
  it('allows exactly maxPerDay consultations then refuses', () => {
    const service = makeService()
    for (let i = 0; i < 50; i += 1) {
      expect(service.tryStartConsultation()).toEqual({ ok: true })
    }
    expect(service.getDailyGuard()).toMatchObject({ used: 50, enabled: true, limit: 50, remaining: 0 })
    expect(service.tryStartConsultation()).toMatchObject({ ok: false })
    expect(service.getDailyGuard()).toMatchObject({ used: 50, remaining: 0 })
  })

  it('exposes remaining before the cap is hit', () => {
    const service = makeService()
    for (let i = 0; i < 7; i += 1) service.tryStartConsultation()
    expect(service.getDailyGuard()).toMatchObject({ used: 7, limit: 50, remaining: 43 })
  })
})

describe('quota: configurable limit', () => {
  it('respects a custom maxPerDay', () => {
    const service = makeService({ maxPerDay: 3 })
    for (let i = 0; i < 3; i += 1) {
      expect(service.tryStartConsultation()).toEqual({ ok: true })
    }
    expect(service.getDailyGuard()).toMatchObject({ used: 3, remaining: 0 })
    expect(service.tryStartConsultation()).toMatchObject({ ok: false })
  })

  it('applies a runtime quota change via setConfig', () => {
    const service = makeService({ maxPerDay: 3 })
    service.setConfig({ ...BASE_CONFIG, quota: { enabled: true, maxPerDay: 1 } })
    expect(service.tryStartConsultation()).toEqual({ ok: true })
    expect(service.tryStartConsultation()).toMatchObject({ ok: false })
  })
})

describe('quota: disabled cap', () => {
  it('never refuses while the counter still accumulates', () => {
    const service = makeService({ enabled: false })
    for (let i = 0; i < 75; i += 1) {
      expect(service.tryStartConsultation()).toEqual({ ok: true })
    }
    expect(service.getDailyGuard()).toMatchObject({ used: 75, enabled: false, remaining: -1 })
  })

  it('re-enabling the cap immediately enforces it against the accumulated count', () => {
    const service = makeService({ enabled: false })
    for (let i = 0; i < 12; i += 1) service.tryStartConsultation()
    service.setConfig({ ...BASE_CONFIG, quota: { enabled: true, maxPerDay: 10 } })
    expect(service.tryStartConsultation()).toMatchObject({ ok: false })
  })
})

describe('quota: persistence & UTC day roll', () => {
  it('loads a persisted count for the current UTC day', () => {
    const today = new Date().toISOString().slice(0, 10)
    const guardPath = join(dshHome, 'storages', 'advisor-group', 'daily-guard.json')
    mkdirSync(join(dshHome, 'storages', 'advisor-group'), { recursive: true })
    writeFileSync(guardPath, JSON.stringify({ date: today, count: 9 }), 'utf8')
    const service = makeService({ maxPerDay: 50 })
    expect(service.getDailyGuard()).toMatchObject({ used: 9, remaining: 41 })
  })

  it('resets to a fresh day view when the stored date is not today (exhausted yesterday works again)', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const guardPath = join(dshHome, 'storages', 'advisor-group', 'daily-guard.json')
    mkdirSync(join(dshHome, 'storages', 'advisor-group'), { recursive: true })
    writeFileSync(guardPath, JSON.stringify({ date: yesterday, count: 50 }), 'utf8')
    const service = makeService({ maxPerDay: 50 })
    expect(service.getDailyGuard()).toMatchObject({ used: 0, remaining: 50 })
    expect(service.tryStartConsultation()).toEqual({ ok: true })
  })
})
