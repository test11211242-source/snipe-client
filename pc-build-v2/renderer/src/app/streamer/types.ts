import type { StreamerView } from '../../../../shared/models/streamer'

export type StreamerRunner = (
  name: string,
  operation: () => Promise<StreamerView>,
) => Promise<StreamerView | null>
