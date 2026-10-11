import type { OverlaySettings, OverlayUrlKind } from '../../../../shared/models/streamer'

/** The public, token-free preview origin (also the only `frame-src` of the main window). */
export const WIDGET_ORIGIN = 'https://api.artcsworld.xyz'

/** Token-free preview of a widget with the current look; test data, never the OBS key. */
export function widgetPreviewUrl(
  kind: OverlayUrlKind,
  settings: OverlaySettings,
): string {
  const path = kind === 'stats' ? '/streamer-stats-widget' : '/opponent-widget'
  const parameters = new URLSearchParams({
    mock: '1',
    layout: kind === 'stats' ? settings.statsLayout : settings.opponentLayout,
    font: settings.widgetFontStyle,
    shape: settings.widgetCornerStyle,
  })
  return `${WIDGET_ORIGIN}${path}?${parameters.toString()}`
}

const SIZES: Record<
  OverlayUrlKind,
  Record<OverlaySettings['statsLayout'], [number, number]>
> = {
  stats: { compact: [360, 48], standard: [480, 64], detailed: [720, 96] },
  opponent: { compact: [420, 300], standard: [560, 380], detailed: [760, 500] },
}

/** Browser-source size for OBS (width, height) for the current layout. */
export function widgetSize(
  kind: OverlayUrlKind,
  settings: OverlaySettings,
): [number, number] {
  const layout = kind === 'stats' ? settings.statsLayout : settings.opponentLayout
  return SIZES[kind][layout]
}
