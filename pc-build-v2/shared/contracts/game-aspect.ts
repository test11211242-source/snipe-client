import { z } from 'zod'

export const GAME_ASPECT_MIN = (9 / 22) * 0.97
export const GAME_ASPECT_MAX = (3 / 4) * 1.03
export const GAME_ASPECT_TOL = 0.03

export const GameAspectSchema = z.number().min(GAME_ASPECT_MIN).max(GAME_ASPECT_MAX)

export function gameAspectsOverlap(a: number, b: number): boolean {
  return Math.max(a / b, b / a) - 1 <= GAME_ASPECT_TOL
}
