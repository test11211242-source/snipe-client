import type { RegionKind } from '../../../../shared/models/capture'

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
