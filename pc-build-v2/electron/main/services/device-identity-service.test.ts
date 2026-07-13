import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  DeviceIdentityService,
  WindowsDeviceIdentityProvider,
  type DeviceRawData,
} from './device-identity-service'

const fixture: DeviceRawData = {
  cpuProcessorId: 'CPU-ID',
  cpuModel: 'Fallback CPU',
  motherboardSerial: 'BOARD-1',
  diskSerials: ['', 'DISK-2'],
  networkInterfaces: {
    Virtual: [
      {
        address: '1',
        netmask: '1',
        family: 'IPv4',
        mac: '11:11:11:11:11:11',
        internal: false,
        cidr: null,
      },
    ],
    Ethernet: [
      {
        address: '2',
        netmask: '1',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
        cidr: null,
      },
    ],
  },
  platform: 'win32',
  arch: 'x64',
  release: '10.0.22631',
}

describe('DeviceIdentityService', () => {
  it('reproduces the sorted V1 component hash and only exposes a masked hint', async () => {
    const service = new DeviceIdentityService({ collect: () => Promise.resolve(fixture) })
    const components = [
      'CPU:CPU-ID',
      'MB:BOARD-1',
      'DISK:DISK-2',
      'MAC:aa:bb:cc:dd:ee:ff',
      'SYS:win32:x64:10.0.22631',
    ]
    const expected = createHash('sha256')
      .update(components.sort().join('|'))
      .digest('hex')
    await expect(service.getIdentity()).resolves.toBe(expected)
    await expect(service.getMaskedHint()).resolves.toBe(
      `${expected.slice(0, 8)}...${expected.slice(-4)}`,
    )
  })

  it('uses exactly one powershell CIM process and rejects non-Windows production use', async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        cpuProcessorId: 'X',
        cpuModel: 'Y',
        motherboardSerial: null,
        diskSerials: [],
      }),
    })
    const windowsSystem = {
      platform: () => 'win32',
      arch: () => 'x64',
      release: () => '10',
      networkInterfaces: () => ({}),
    }
    const provider = new WindowsDeviceIdentityProvider(runner, windowsSystem)
    await provider.collect()
    expect(runner).toHaveBeenCalledOnce()
    expect(runner).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-Command']),
      expect.objectContaining({ windowsHide: true }),
    )

    const linuxProvider = new WindowsDeviceIdentityProvider(runner, {
      ...windowsSystem,
      platform: () => 'linux',
    })
    await expect(linuxProvider.collect()).rejects.toMatchObject({
      code: 'DEVICE_PLATFORM_UNSUPPORTED',
    })
    expect(runner).toHaveBeenCalledOnce()
  })
})
