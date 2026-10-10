import { describe, expect, it } from 'vitest'

import { publicErrorMessage, updateStateLabel } from './format'

describe('update formatting', () => {
  it('labels a failed update without claiming only the check failed', () => {
    expect(updateStateLabel('FAILED')).toBe('Обновление не выполнено')
  })

  it('localizes the installer helper and shutdown errors emitted by main', () => {
    expect(publicErrorMessage('INSTALLER_HELPER_EXITED', 'English fallback')).toBe(
      'Системный компонент завершился до запуска установщика.',
    )
    expect(publicErrorMessage('UPDATE_SHUTDOWN_FAILED', 'English fallback')).toBe(
      'Не удалось закрыть приложение для установки обновления.',
    )
  })
})
