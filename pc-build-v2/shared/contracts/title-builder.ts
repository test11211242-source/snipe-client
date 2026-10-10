import { z } from 'zod'
import { StreamTitleSettingsSchema, type StreamTitleSettings } from '../models/streamer'

const TitleChipSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['rank', 'elo', 'wl', 'delta', 'account', 'best']) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(60).regex(/^[^{}]*$/) }).strict(),
])
export const TitleBuilderSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('preset'), preset: z.enum(['short', 'score', 'full', 'signed']) }).strict(),
  z.object({ mode: z.literal('chips'), chips: z.array(TitleChipSchema).max(12) }).strict(),
  // Existing arbitrary server-valid templates are preserved, never approximated as chips.
  z.object({ mode: z.literal('raw'), template: z.string().max(200) }).strict(),
])
export const CompileTitlePayloadSchema = z.object({ settings: StreamTitleSettingsSchema, builder: TitleBuilderSchema }).strict()
export const TITLE_BUILDER_CHANNELS = Object.freeze({ compile: 'streamer:compile-title', decompile: 'streamer:decompile-title' })
export type TitleBuilder = z.infer<typeof TitleBuilderSchema>
export type TitleChip = z.infer<typeof TitleChipSchema>
export const TitleCompileResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), settings: StreamTitleSettingsSchema }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['VALIDATION_FAILED', 'TITLE_ACCOUNT_SELECTION_CONFLICT']) }).strict(),
])
export type TitleCompileResult = z.infer<typeof TitleCompileResultSchema>
export const TITLE_PRESETS: Record<'short' | 'score' | 'full' | 'signed', readonly TitleChip[]> = {
  short: [{ kind: 'rank' }, { kind: 'elo' }],
  score: [{ kind: 'elo' }, { kind: 'wl' }],
  full: [{ kind: 'rank' }, { kind: 'elo' }, { kind: 'wl' }, { kind: 'delta' }],
  signed: [{ kind: 'rank' }, { kind: 'elo' }, { kind: 'text', text: 'Играю в Clash Royale' }],
}
const TOKEN: Record<Exclude<TitleChip['kind'], 'text'>, string> = { rank: '{rank}', elo: '{elo}', wl: '{wins}W-{losses}L', delta: '{delta}', account: '{account}', best: '{account}' }
export function compileTitle(settings: StreamTitleSettings, raw: TitleBuilder): StreamTitleSettings {
  const base = StreamTitleSettingsSchema.parse(settings)
  const builder = TitleBuilderSchema.parse(raw)
  if (builder.mode === 'raw') return StreamTitleSettingsSchema.parse({ ...base, prefixTemplate: builder.template })
  const chips = builder.mode === 'preset' ? TITLE_PRESETS[builder.preset] : builder.chips
  if (chips.some((chip) => chip.kind === 'account') && chips.some((chip) => chip.kind === 'best')) throw new Error('TITLE_ACCOUNT_SELECTION_CONFLICT')
  const data = chips.filter((chip) => chip.kind !== 'text').map((chip) => TOKEN[chip.kind as keyof typeof TOKEN]).join(' · ')
  const text = chips.filter((chip) => chip.kind === 'text').map((chip) => chip.text).filter(Boolean).join(' ')
  return StreamTitleSettingsSchema.parse({ ...base,
    prefixTemplate: [data, text].filter(Boolean).join(' | '),
    includeRank: chips.some((chip) => chip.kind === 'rank'), includeElo: chips.some((chip) => chip.kind === 'elo'), includeWl: chips.some((chip) => chip.kind === 'wl'), includeDelta: chips.some((chip) => chip.kind === 'delta'),
    accountDisplayMode: chips.some((chip) => chip.kind === 'best') ? 'best_elo' : base.accountDisplayMode,
  })
}
export function decompileTitle(settings: StreamTitleSettings): TitleBuilder {
  const base = StreamTitleSettingsSchema.parse(settings)
  const raw: TitleBuilder = { mode: 'raw', template: base.prefixTemplate }
  const [data, text, extra] = base.prefixTemplate.split(' | ')
  if (extra !== undefined) return raw
  const chips: TitleChip[] = []
  for (const part of (data ?? '').split(' · ')) {
    const kind = (Object.keys(TOKEN) as (keyof typeof TOKEN)[]).find((key) => TOKEN[key] === part)
    if (kind === undefined) return raw
    chips.push({ kind: kind === 'account' && base.accountDisplayMode === 'best_elo' ? 'best' : kind })
  }
  if (text !== undefined) chips.push({ kind: 'text', text })
  const builder: TitleBuilder = { mode: 'chips', chips }
  try {
    const compiled = compileTitle(base, builder)
    if (JSON.stringify(compiled) !== JSON.stringify(base)) return raw
    for (const preset of Object.keys(TITLE_PRESETS) as (keyof typeof TITLE_PRESETS)[]) {
      if (JSON.stringify(compileTitle(base, { mode: 'preset', preset })) === JSON.stringify(base)) return { mode: 'preset', preset }
    }
    return builder
  } catch { return raw }
}
