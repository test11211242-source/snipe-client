import { useState } from 'react'

import type { NormalizedRect, RegionKind } from '../../../../shared/models/capture'
import type { SetupSessionView } from '../../../../shared/models/setup'
import { Banner, Button, Icon, Spinner, cx } from '../../ui'
import { FrameStage, type StageBox } from './FrameStage'
import { rectToPixels, sameRect } from './geometry'
import { regionsOf } from './regions'
import styles from './Setup.module.css'
import type { SetupSession } from './useSetupSession'

const TIPS: readonly string[] = [
  'Тяните рамку за углы, двигайте за середину. Новую рамку можно нарисовать на пустом месте кадра.',
  'С клавиатуры: стрелки двигают рамку, Alt+стрелки меняют размер, Shift — крупнее.',
]

/**
 * Manual regions on the frozen frame: one region at a time, all of them saved to main.
 * Changing the active tab or going on stores the pending draft with `setRegion`; the
 * trigger is analyzed before the check step. This is the slot where a future real
 * auto-detection result would pre-fill the same regions.
 */
export function RegionEditor({
  session,
  view,
  frameUrl,
  onChecked,
}: {
  session: SetupSession
  view: SetupSessionView
  frameUrl: string | null
  /** Trigger analyzed and all regions saved: move on to the check step. */
  onChecked: () => void
}): React.JSX.Element {
  const defs = regionsOf(view.kind)
  const [active, setActive] = useState<RegionKind>(
    () =>
      defs.find((def) => view.regions[def.id] === null)?.id ?? defs[0]?.id ?? 'trigger',
  )
  const [draft, setDraft] = useState<NormalizedRect | null>(() => view.regions[active])
  const { busy } = session
  const editable = view.state === 'SELECTING' && !busy && frameUrl !== null
  const activeDef = defs.find((def) => def.id === active) ?? defs[0]
  const saved = view.regions[active]
  const dirty = !sameRect(draft, saved)
  const ready = defs.every((def) =>
    def.id === active ? draft !== null : view.regions[def.id] !== null,
  )
  const frameSize = view.frameSize

  const persistActive = async (): Promise<boolean> => {
    if (draft === null || sameRect(draft, session.latest()?.regions[active] ?? null))
      return true
    return (await session.setRegion(active, draft)) !== null
  }

  const select = async (next: RegionKind): Promise<void> => {
    if (next === active || busy || !editable) return
    if (!(await persistActive())) return
    setActive(next)
    setDraft(session.latest()?.regions[next] ?? null)
  }

  const proceed = async (): Promise<void> => {
    if (!ready || busy || !editable) return
    if (!(await persistActive())) return
    let latest = session.latest()
    if (latest?.triggerProfile == null) {
      latest = await session.analyze()
      if (latest?.triggerProfile == null) return
    }
    onChecked()
  }

  const boxes: StageBox[] = defs.map((def) => ({
    id: def.id,
    label: def.label,
    rect: view.regions[def.id],
    active: def.id === active,
    labelBelow: def.labelBelow,
    // A moved trigger draft no longer matches the analyzed silhouette until re-analysis.
    outline:
      def.id === 'trigger' && !(def.id === active && dirty) ? view.triggerOutline : null,
  }))

  return (
    <>
      <div className={styles['split']}>
        <div className={styles['bezel']}>
          <div className={styles['bezelBar']}>
            <i className={styles['bezelDot']} />
            <i className={styles['bezelDot']} />
            <i className={styles['bezelDot']} />
            <span className={styles['bezelTitle']}>
              Замороженный кадр · {view.source.label}
            </span>
          </div>
          {frameUrl !== null && frameSize !== null ? (
            <FrameStage
              activeName={activeDef?.label}
              badge={busy ? 'Сохраняем область…' : 'Кадр заморожен'}
              boxes={boxes}
              draft={draft}
              editable={editable}
              frameSize={frameSize}
              frameUrl={frameUrl}
              gameViewport={view.game?.viewport ?? null}
              onDraft={setDraft}
            />
          ) : (
            <div className={styles['stage']}>
              <div className={styles['stageNote']}>
                {session.frameFailed ? (
                  <span>
                    Не удалось загрузить кадр.{' '}
                    <Button onClick={() => void session.retryFrame()} size="sm">
                      Повторить
                    </Button>
                  </span>
                ) : (
                  <Spinner label="Загружаем кадр" />
                )}
              </div>
            </div>
          )}
        </div>
        <section aria-label="Ручная разметка" className={styles['panel']}>
          <h1 className={styles['h2']}>Отметьте области вручную</h1>
          <p className={styles['p']}>
            Автоматического поиска нет: области отмечаете вы на замороженном кадре. Если
            на кадре не тот экран, отмените настройку и повторите.
          </p>
          <ol aria-label="Области" className={styles['regionTabs']}>
            {defs.map((def, position) => {
              const rect = def.id === active ? draft : view.regions[def.id]
              const done = view.regions[def.id] !== null
              return (
                <li key={def.id}>
                  <button
                    aria-current={def.id === active ? 'step' : undefined}
                    className={cx(
                      styles['regionTab'],
                      def.id === active && styles['regionTabOn'],
                    )}
                    disabled={busy || !editable}
                    onClick={() => void select(def.id)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className={cx(styles['regionMark'], done && styles['regionDone'])}
                    >
                      {done ? <Icon name="check" size={12} /> : position + 1}
                    </span>
                    <span className={styles['regionName']}>
                      {def.label}
                      <span className="sr-only">
                        {done ? '. Область сохранена.' : '. Область не задана.'}
                      </span>
                    </span>
                    {rect !== null && frameSize !== null ? (
                      <span className={styles['regionMono']}>
                        {readout(rect, frameSize)}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ol>
          {activeDef === undefined ? null : (
            <p className={styles['p']} id="region-help">
              <b>{activeDef.label}.</b> {activeDef.help}
            </p>
          )}
          <ul className={styles['tips']}>
            {TIPS.map((tip) => (
              <li className={styles['tip']} key={tip}>
                <span className={styles['tipIcon']}>
                  <Icon name="info" size={14} />
                </span>
                {tip}
              </li>
            ))}
          </ul>
          {session.error === null ? null : (
            <div className={styles['alert']}>
              <Banner icon="alert" live title="Не получилось" tone="danger">
                {session.error}
              </Banner>
            </div>
          )}
        </section>
      </div>
      <div className={styles['foot']}>
        <Button
          disabled={!dirty || busy || !editable}
          onClick={() => setDraft(saved)}
          variant="ghost"
        >
          <Icon name="refresh" size={14} />
          Вернуть сохранённую
        </Button>
        <div className={styles['footRight']}>
          <Button
            disabled={!ready || !editable}
            loading={busy}
            onClick={() => void proceed()}
            size="lg"
            variant="primary"
          >
            Дальше: проверка триггера
            <Icon name="chevronRight" size={16} />
          </Button>
        </div>
      </div>
    </>
  )
}

function readout(rect: NormalizedRect, size: { width: number; height: number }): string {
  const px = rectToPixels(rect, size)
  return `${px.x}, ${px.y} · ${px.width}×${px.height}`
}
