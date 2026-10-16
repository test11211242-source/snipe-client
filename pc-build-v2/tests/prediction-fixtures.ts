import type { PredictionStatus } from '../shared/models/streamer'

export const predictionStatusFixture: PredictionStatus = {
  enabled: true,
  live: false,
  clientReady: true,
  phase: 'waiting_stream',
  attention: null,
  prediction: null,
  stats: { resolved: 0, yes: 0, no: 0, canceled: 0 },
  history: [],
}
