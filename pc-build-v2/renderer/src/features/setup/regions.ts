import type { RegionKind } from '../../../../shared/models/capture'
import type { SetupSessionView } from '../../../../shared/models/setup'

export interface RegionDef {
  id: RegionKind
  /** Tab and frame label. */
  label: string
  /** What to mark; shown as the step heading text. */
  help: string
  /** Label sits under the box. */
  labelBelow: boolean
}

/** `normal` is the nickname region and `precise` the top-left evidence region in main. */
export const CAPTURE_REGIONS: readonly RegionDef[] = [
  {
    id: 'trigger',
    label: 'Триггер',
    help: 'Выделите неподвижный элемент экрана — например, значок «VS». Берите его по краю: приложение само найдёт устойчивую структуру внутри рамки.',
    labelBelow: true,
  },
  {
    id: 'nickname',
    label: 'Ник соперника',
    help: 'Область должна целиком охватывать плашку с именем соперника.',
    labelBelow: false,
  },
  {
    id: 'topLeftEvidence',
    label: 'Левая верхняя область',
    help: 'Выделите область в левом верхнем углу экрана боя. Она сохраняется вместе с триггером и областью ника.',
    labelBelow: false,
  },
]

export const RESULT_REGIONS: readonly RegionDef[] = [
  {
    id: 'resultTrigger',
    label: 'Триггер результата',
    help: 'Выделите неподвижный элемент экрана с итогом боя. Приложение само найдёт устойчивую структуру внутри рамки.',
    labelBelow: true,
  },
  {
    id: 'resultData',
    label: 'Зона с итогом',
    help: 'Выделите область с итогом боя — «Победа» или «Поражение». Именно она уйдёт боту прогнозов.',
    labelBelow: false,
  },
]

export function regionsOf(kind: SetupSessionView['kind']): readonly RegionDef[] {
  return kind === 'predictionResult' ? RESULT_REGIONS : CAPTURE_REGIONS
}

export function triggerRegionOf(kind: SetupSessionView['kind']): RegionKind {
  return kind === 'predictionResult' ? 'resultTrigger' : 'trigger'
}
