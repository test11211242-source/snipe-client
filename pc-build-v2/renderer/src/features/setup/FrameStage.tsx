import { useLayoutEffect, useRef, useState } from 'react'

import type { NormalizedRect, PixelSize } from '../../../../shared/models/capture'
import { cx } from '../../ui'
import {
  containTransform,
  hitRect,
  moveRect,
  nudgeRect,
  pointerToNormalized,
  rectFromPoints,
  resizeCorner,
  type ContainTransform,
  type RectCorner,
} from './geometry'
import styles from './Setup.module.css'

export interface StageBox {
  id: string
  label: string
  rect: NormalizedRect | null
  /** The one region being edited: gets handles and takes pointer input. */
  active: boolean
  /** Label under the box instead of above (keeps neighbours readable). */
  labelBelow?: boolean | undefined
}

type Drag =
  | { pointerId: number; mode: 'draw'; start: Point; origin: NormalizedRect | null }
  | { pointerId: number; mode: 'move'; start: Point; origin: NormalizedRect }
  | {
      pointerId: number
      mode: 'resize'
      corner: RectCorner
      start: Point
      origin: NormalizedRect
    }
interface Point {
  x: number
  y: number
}

/** Size of a corner handle's grab area, in CSS pixels. */
const HANDLE_GRAB = 14
const CORNERS: readonly RectCorner[] = ['nw', 'ne', 'sw', 'se']
const HANDLE_CLASS: Record<RectCorner, string> = {
  nw: 'handleNw',
  ne: 'handleNe',
  sw: 'handleSw',
  se: 'handleSe',
}

function boxStyle(rect: NormalizedRect): React.CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  }
}

/**
 * The frozen frame with its regions. When `editable`, the active region is edited with
 * the pointer: drag on empty frame to draw, drag a corner to resize, drag inside to move.
 * Escape or a cancelled pointer undoes the gesture in progress. The draft belongs to the
 * caller; arrow keys on the focused region nudge it (Shift = coarse, Alt = resize).
 */
export function FrameStage({
  frameUrl,
  frameSize,
  boxes,
  inner = null,
  innerLabel = 'Найдена структура',
  editable,
  draft,
  onDraft,
  activeName,
  badge,
}: {
  frameUrl: string
  frameSize: PixelSize
  boxes: readonly StageBox[]
  /** Structure the analyzer found inside the trigger, already in frame coordinates. */
  inner?: NormalizedRect | null
  innerLabel?: string
  editable: boolean
  draft: NormalizedRect | null
  onDraft: (rect: NormalizedRect | null) => void
  /** Name of the active region for the accessible label. */
  activeName?: string | undefined
  badge?: string | undefined
}): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [transform, setTransform] = useState<ContainTransform | null>(null)

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (stage === null) return undefined
    const update = (): void =>
      setTransform(
        containTransform(
          {
            width: Math.max(1, stage.clientWidth),
            height: Math.max(1, stage.clientHeight),
          },
          frameSize,
        ),
      )
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [frameSize])

  const point = (event: React.PointerEvent<HTMLDivElement>): Point | null => {
    const stage = stageRef.current
    if (stage === null || transform === null) return null
    const bounds = stage.getBoundingClientRect()
    return pointerToNormalized(
      event.clientX,
      event.clientY,
      bounds.left,
      bounds.top,
      transform,
    )
  }

  const release = (event: React.PointerEvent<HTMLDivElement>): void => {
    const target = event.currentTarget
    if (
      typeof target.hasPointerCapture === 'function' &&
      target.hasPointerCapture(event.pointerId) &&
      typeof target.releasePointerCapture === 'function'
    )
      target.releasePointerCapture(event.pointerId)
  }

  const apply = (gesture: Drag, at: Point): void => {
    if (gesture.mode === 'draw') {
      onDraft(rectFromPoints(gesture.start, at) ?? gesture.origin)
    } else if (gesture.mode === 'move') {
      onDraft(moveRect(gesture.origin, at.x - gesture.start.x, at.y - gesture.start.y))
    } else {
      onDraft(resizeCorner(gesture.origin, gesture.corner, at))
    }
  }

  const cancelGesture = (): void => {
    const gesture = drag.current
    drag.current = null
    if (gesture !== null) onDraft(gesture.origin)
  }

  const activeRect = draft

  return (
    <div
      aria-label="Выделение области на рабочем кадре"
      className={cx(styles['stage'], editable && styles['stageEditable'])}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && drag.current !== null) {
          event.stopPropagation()
          cancelGesture()
        }
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null
      }}
      onPointerCancel={(event) => {
        if (drag.current?.pointerId === event.pointerId) cancelGesture()
        release(event)
      }}
      onPointerDown={(event) => {
        if (!editable || event.button !== 0 || drag.current !== null) return
        const start = point(event)
        if (start === null || transform === null) return
        const hit =
          activeRect === null
            ? null
            : hitRect(activeRect, start, {
                x: HANDLE_GRAB / 2 / transform.width,
                y: HANDLE_GRAB / 2 / transform.height,
              })
        if (hit?.kind === 'handle' && activeRect !== null)
          drag.current = {
            pointerId: event.pointerId,
            mode: 'resize',
            corner: hit.corner,
            start,
            origin: activeRect,
          }
        else if (hit?.kind === 'body' && activeRect !== null)
          drag.current = {
            pointerId: event.pointerId,
            mode: 'move',
            start,
            origin: activeRect,
          }
        else
          drag.current = {
            pointerId: event.pointerId,
            mode: 'draw',
            start,
            origin: activeRect,
          }
        event.currentTarget.focus()
        if (typeof event.currentTarget.setPointerCapture === 'function')
          event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const gesture = drag.current
        if (!editable || gesture?.pointerId !== event.pointerId) return
        const at = point(event)
        if (at !== null) apply(gesture, at)
      }}
      onPointerUp={(event) => {
        const gesture = drag.current
        if (gesture?.pointerId === event.pointerId) {
          const at = point(event)
          if (at !== null) apply(gesture, at)
          drag.current = null
        }
        release(event)
      }}
      ref={stageRef}
      role="group"
      tabIndex={-1}
    >
      {transform === null ? null : (
        <div
          className={styles['surface']}
          style={{
            left: transform.x,
            top: transform.y,
            width: transform.width,
            height: transform.height,
          }}
        >
          <img
            alt="Кадр выбранного источника"
            className={styles['frameImg']}
            draggable={false}
            src={frameUrl}
          />
          {boxes.map((box) => {
            const rect = box.active ? activeRect : box.rect
            if (rect === null) return null
            return (
              <div
                aria-label={
                  box.active && editable
                    ? `Область «${activeName ?? box.label}». Стрелки — сдвинуть, Shift — крупнее, Alt+стрелки — изменить размер.`
                    : undefined
                }
                className={cx(styles['box'], box.active && styles['boxActive'])}
                data-region={box.id}
                key={box.id}
                onKeyDown={(event) => {
                  if (!box.active || !editable || activeRect === null) return
                  if (
                    event.key === 'ArrowLeft' ||
                    event.key === 'ArrowRight' ||
                    event.key === 'ArrowUp' ||
                    event.key === 'ArrowDown'
                  ) {
                    event.preventDefault()
                    onDraft(
                      nudgeRect(
                        activeRect,
                        event.key,
                        event.shiftKey ? 0.05 : 0.01,
                        event.altKey,
                      ),
                    )
                  }
                }}
                role={box.active && editable ? 'group' : undefined}
                style={boxStyle(rect)}
                tabIndex={box.active && editable ? 0 : undefined}
              >
                <i
                  className={cx(
                    styles['boxLabel'],
                    box.labelBelow === true && styles['boxLabelBelow'],
                    !box.active && styles['boxLabelMuted'],
                  )}
                >
                  {box.label}
                </i>
                {box.active && editable
                  ? CORNERS.map((corner) => (
                      <i
                        className={cx(styles['handle'], styles[HANDLE_CLASS[corner]])}
                        key={corner}
                      />
                    ))
                  : null}
              </div>
            )
          })}
          {inner === null ? null : (
            <div
              className={cx(styles['box'], styles['boxInner'])}
              data-testid="trigger-inner-region"
              style={boxStyle(inner)}
            >
              <i className={styles['boxLabel']}>{innerLabel}</i>
            </div>
          )}
        </div>
      )}
      {badge === undefined ? null : <span className={styles['stageBadge']}>{badge}</span>}
    </div>
  )
}
