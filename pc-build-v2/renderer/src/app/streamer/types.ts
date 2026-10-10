import type { StreamerView } from '../../../../shared/models/streamer'

export type StreamerRunner = (
  name: string,
  operation: () => Promise<StreamerView | null>,
) => Promise<StreamerView | null>
