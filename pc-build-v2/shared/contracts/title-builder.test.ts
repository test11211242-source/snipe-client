import { describe, expect, it } from 'vitest'
import { DEFAULT_TITLE_SETTINGS, titleToServer } from '../../electron/main/services/streamer-adapters'
import { compileTitle, decompileTitle, TitleBuilderSchema } from './title-builder'

describe('title chip compiler', () => {
  it.each(['short', 'score', 'full', 'signed'] as const)('round-trips %s without changing server fields', (preset) => {
    const settings = compileTitle(DEFAULT_TITLE_SETTINGS, { mode: 'preset', preset })
    expect(compileTitle(settings, decompileTitle(settings))).toEqual(settings)
    expect(titleToServer(settings)).toMatchObject({ prefix_template: settings.prefixTemplate, include_rank: settings.includeRank, include_elo: settings.includeElo, include_wl: settings.includeWl, include_delta: settings.includeDelta })
    expect(settings.pollIntervalSeconds).toBe(DEFAULT_TITLE_SETTINGS.pollIntervalSeconds)
  })
  it.each(['[{rank} {elo}] {wr}% {streak} — custom', '{account}/{account} {wins} W : {losses} L', 'literal · text | unchanged', ''])('preserves arbitrary legacy template %s exactly', (prefixTemplate) => {
    const settings = { ...DEFAULT_TITLE_SETTINGS, prefixTemplate, includeRank: false, accountDisplayMode: 'multiple' as const, maxAccounts: 4 }
    const builder = decompileTitle(settings)
    expect(builder.mode).toBe('raw')
    expect(compileTitle(settings, builder)).toEqual(settings)
  })
  it('preserves disabled legacy include flags rather than showing misleading chips', () => {
    const settings = { ...compileTitle(DEFAULT_TITLE_SETTINGS, { mode: 'preset', preset: 'full' }), includeElo: false }
    expect(decompileTitle(settings).mode).toBe('raw')
    expect(compileTitle(settings, decompileTitle(settings))).toEqual(settings)
  })
  it('uses best-account selection, not a fabricated second account token', () => {
    const settings = compileTitle(DEFAULT_TITLE_SETTINGS, { mode: 'chips', chips: [{ kind: 'best' }, { kind: 'elo' }] })
    expect(settings.accountDisplayMode).toBe('best_elo')
    expect(settings.prefixTemplate).toBe('{account} · {elo}')
    expect(compileTitle(settings, decompileTitle(settings))).toEqual(settings)
    expect(() => compileTitle(settings, { mode: 'chips', chips: [{ kind: 'account' }, { kind: 'best' }] })).toThrow('TITLE_ACCOUNT_SELECTION_CONFLICT')
  })
  it('puts literal text after data, validates placeholders/length and does not expose mock deltas', () => {
    const settings = compileTitle(DEFAULT_TITLE_SETTINGS, { mode: 'chips', chips: [{ kind: 'text', text: 'Live' }, { kind: 'delta' }] })
    expect(settings.prefixTemplate).toBe('{delta} | Live')
    expect(TitleBuilderSchema.safeParse({ mode: 'chips', chips: [{ kind: 'text', text: '{token}' }] }).success).toBe(false)
    expect(() => compileTitle(settings, { mode: 'chips', chips: Array.from({ length: 12 }, () => ({ kind: 'text' as const, text: 'x'.repeat(60) })) })).toThrow()
  })
})
