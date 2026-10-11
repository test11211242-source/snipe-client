import { describe, expect, it, vi } from 'vitest'
import { CaptureTargetResolver } from './capture-target-resolver'

const profileId = '00000000-0000-4000-8000-000000000001'
const source = { kind: 'window', label: 'Game' }
function harness() {
  let signedIn = true
  const profile = {
    profileName: 'Второй',
    configuration: { fingerprint: 'a'.repeat(64), sourceBinding: { identity: source } },
  }
  const repository = {
    list: vi.fn().mockResolvedValue({
      revision: 4,
      activeProfileId: 'other',
      profiles: [{ profileId, configurationFingerprint: 'a'.repeat(64) }],
    }),
    get: vi.fn().mockResolvedValue(profile),
    getActive: vi.fn(),
  }
  const selector = { kind: 'window', windowHwnd: '42' }
  const registry = { resolvePreference: vi.fn().mockResolvedValue(selector) }
  const service = new CaptureTargetResolver(
    { getView: () => ({ user: signedIn ? { id: 'user-1' } : null }) } as never,
    repository as never,
    registry as never,
  )
  return {
    service,
    repository,
    registry,
    profile,
    selector,
    signOut: () => {
      signedIn = false
    },
  }
}
describe('selected capture profile result target', () => {
  it('resolves the requested inactive profile, never the active one or a display-label guess', async () => {
    const test = harness()
    expect(await test.service.resolveProfileTarget(profileId)).toEqual({
      userId: 'user-1',
      profileId,
      profileName: 'Второй',
      collectionRevision: 4,
      configuration: test.profile.configuration,
      selector: test.selector,
    })
    expect(test.repository.get).toHaveBeenCalledWith('user-1', profileId)
    expect(test.repository.getActive).not.toHaveBeenCalled()
    expect(test.registry.resolvePreference).toHaveBeenCalledWith(source)
  })
  it('rejects a profile removed from the collection', async () => {
    const test = harness()
    test.repository.list.mockResolvedValue({ revision: 5, profiles: [] })
    await expect(test.service.resolveProfileTarget(profileId)).rejects.toMatchObject({
      code: 'CAPTURE_PROFILE_NOT_FOUND',
    })
    expect(test.registry.resolvePreference).not.toHaveBeenCalled()
  })
  it('rejects a calibration change between collection and profile reads', async () => {
    const test = harness()
    test.repository.get.mockResolvedValue({
      ...test.profile,
      configuration: { ...test.profile.configuration, fingerprint: 'b'.repeat(64) },
    })
    await expect(test.service.resolveProfileTarget(profileId)).rejects.toMatchObject({
      code: 'CAPTURE_PROFILE_STALE',
    })
    expect(test.registry.resolvePreference).not.toHaveBeenCalled()
  })
  it('rejects unauthenticated callers before touching a user profile', async () => {
    const test = harness()
    test.signOut()
    await expect(test.service.resolveProfileTarget(profileId)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    })
    expect(test.repository.get).not.toHaveBeenCalled()
  })
})
