import { z } from 'zod'
import { StreamTitleSettingsSchema, type StreamTitleSettings } from '../models/streamer'

const TitleChipSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['rank', 'elo', 'wl', 'delta', 'account', 'best']) }).strict(),
  z
    .object({
      kind: z.literal('text'),
      text: z
        .string()
        .max(60)
        .regex(/^[^{}]*$/),
    })
    .strict(),
])
export const TitleBuilderSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('preset'),
      preset: z.enum(['short', 'score', 'full', 'signed']),
    })
    .strict(),
  z
    .object({ mode: z.literal('chips'), chips: z.array(TitleChipSchema).max(12) })
    .strict(),
  // Existing arbitrary server-valid templates are preserved, never approximated as chips.
  z.object({ mode: z.literal('raw'), template: z.string().max(200) }).strict(),
])
export const CompileTitlePayloadSchema = z
  .object({ settings: StreamTitleSettingsSchema, builder: TitleBuilderSchema })
  .strict()
export const TITLE_BUILDER_CHANNELS = Object.freeze({
  compile: 'streamer:compile-title',
  decompile: 'streamer:decompile-title',
})
export type TitleBuilder = z.infer<typeof TitleBuilderSchema>
export type TitleChip = z.infer<typeof TitleChipSchema>
export const TitleCompileResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), settings: StreamTitleSettingsSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(['VALIDATION_FAILED', 'TITLE_ACCOUNT_SELECTION_CONFLICT']),
    })
    .strict(),
])
export type TitleCompileResult = z.infer<typeof TitleCompileResultSchema>
export const TITLE_PRESETS: Record<
  'short' | 'score' | 'full' | 'signed',
  readonly TitleChip[]
> = {
  short: [{ kind: 'rank' }, { kind: 'elo' }],
  score: [{ kind: 'elo' }, { kind: 'wl' }],
  full: [{ kind: 'rank' }, { kind: 'elo' }, { kind: 'wl' }, { kind: 'delta' }],
  signed: [
    { kind: 'rank' },
    { kind: 'elo' },
    { kind: 'text', text: 'Играю в Clash Royale' },
  ],
}
const TOKEN: Record<Exclude<TitleChip['kind'], 'text'>, string> = {
  rank: '{rank}',
  elo: '{elo}',
  wl: '{wins}W-{losses}L',
  delta: '{delta}',
  account: '{account}',
  best: '{account}',
}
const CHIP_FOR_TOKEN: Record<string, Exclude<TitleChip['kind'], 'text'> | undefined> = {
  '{rank}': 'rank',
  '{elo}': 'elo',
  '{wins}W-{losses}L': 'wl',
  '{delta}': 'delta',
  '{account}': 'account',
}
const PRESET_KEYS = ['short', 'score', 'full', 'signed'] as const
export function compileTitle(
  settings: StreamTitleSettings,
  raw: TitleBuilder,
): StreamTitleSettings {
  const base = StreamTitleSettingsSchema.parse(settings)
  const builder = TitleBuilderSchema.parse(raw)
  if (builder.mode === 'raw')
    return StreamTitleSettingsSchema.parse({ ...base, prefixTemplate: builder.template })
  const chips = builder.mode === 'preset' ? TITLE_PRESETS[builder.preset] : builder.chips
  const data: string[] = []
  const text: string[] = []
  let includeRank = false,
    includeElo = false,
    includeWl = false,
    includeDelta = false
  let hasAccount = false,
    hasBest = false
  for (const chip of chips) {
    if (chip.kind === 'text') {
      if (chip.text !== '') text.push(chip.text)
      continue
    }
    data.push(TOKEN[chip.kind])
    if (chip.kind === 'rank') includeRank = true
    else if (chip.kind === 'elo') includeElo = true
    else if (chip.kind === 'wl') includeWl = true
    else if (chip.kind === 'delta') includeDelta = true
    else if (chip.kind === 'account') hasAccount = true
    else hasBest = true
  }
  if (hasAccount && hasBest) throw new Error('TITLE_ACCOUNT_SELECTION_CONFLICT')
  const dataTemplate = data.join(' · ')
  const textTemplate = text.join(' ')
  return StreamTitleSettingsSchema.parse({
    ...base,
    prefixTemplate:
      dataTemplate && textTemplate
        ? `${dataTemplate} | ${textTemplate}`
        : dataTemplate || textTemplate,
    includeRank,
    includeElo,
    includeWl,
    includeDelta,
    accountDisplayMode: hasBest
      ? 'best_elo'
      : hasAccount
        ? 'last_active'
        : base.accountDisplayMode,
  })
}
export function decompileTitle(settings: StreamTitleSettings): TitleBuilder {
  const base = StreamTitleSettingsSchema.parse(settings)
  const raw: TitleBuilder = { mode: 'raw', template: base.prefixTemplate }
  const [data, text, extra] = base.prefixTemplate.split(' | ')
  if (extra !== undefined) return raw
  const chips: TitleChip[] = []
  for (const part of (data ?? '').split(' · ')) {
    const kind = Object.hasOwn(CHIP_FOR_TOKEN, part) ? CHIP_FOR_TOKEN[part] : undefined
    if (kind === undefined) return raw
    chips.push({
      kind: kind === 'account' && base.accountDisplayMode === 'best_elo' ? 'best' : kind,
    })
  }
  if (text !== undefined) chips.push({ kind: 'text', text })
  const builder: TitleBuilder = { mode: 'chips', chips }
  try {
    const compiled = compileTitle(base, builder)
    if (JSON.stringify(compiled) !== JSON.stringify(base)) return raw
    const serializedChips = JSON.stringify(chips)
    for (const preset of PRESET_KEYS) {
      if (JSON.stringify(TITLE_PRESETS[preset]) === serializedChips)
        return { mode: 'preset', preset }
    }
    return builder
  } catch {
    return raw
  }
}
