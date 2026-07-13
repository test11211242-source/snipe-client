import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import os, { type NetworkInterfaceInfo } from 'node:os'
import { promisify } from 'node:util'

import { z } from 'zod'

import { ApplicationError } from '../../../shared/errors/application-error'

const execFileAsync = promisify(execFile)

const PowerShellResultSchema = z
  .object({
    cpuProcessorId: z.string().nullable(),
    cpuModel: z.string().nullable(),
    motherboardSerial: z.string().nullable(),
    diskSerials: z.array(z.string()),
  })
  .strict()

export interface DeviceRawData {
  cpuProcessorId: string | null
  cpuModel: string | null
  motherboardSerial: string | null
  diskSerials: readonly string[]
  networkInterfaces: NodeJS.Dict<NetworkInterfaceInfo[]>
  platform: string
  arch: string
  release: string
}

export interface DeviceIdentityProvider {
  collect: () => Promise<DeviceRawData>
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options: { windowsHide: true; timeout: number; maxBuffer: number; encoding: 'utf8' },
) => Promise<{ stdout: string }>

export interface DeviceSystemProvider {
  platform: () => string
  arch: () => string
  release: () => string
  networkInterfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>
}

const CIM_SCRIPT = [
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
  '$board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1',
  '$disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object { [string]$_.SerialNumber })',
  '@{ cpuProcessorId = [string]$cpu.ProcessorId; cpuModel = [string]$cpu.Name; motherboardSerial = [string]$board.SerialNumber; diskSerials = $disks } | ConvertTo-Json -Compress',
].join('; ')

const defaultCommandRunner: CommandRunner = async (executable, args, options) => {
  const result = await execFileAsync(executable, [...args], options)
  return { stdout: result.stdout }
}

export class WindowsDeviceIdentityProvider implements DeviceIdentityProvider {
  constructor(
    private readonly commandRunner: CommandRunner = defaultCommandRunner,
    private readonly system: DeviceSystemProvider = os,
  ) {}

  async collect(): Promise<DeviceRawData> {
    if (this.system.platform() !== 'win32') {
      throw new ApplicationError(
        'DEVICE_PLATFORM_UNSUPPORTED',
        'Production device identity is available only on Windows',
      )
    }

    let result: z.infer<typeof PowerShellResultSchema>
    try {
      const execution = await this.commandRunner(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          CIM_SCRIPT,
        ],
        { windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024, encoding: 'utf8' },
      )
      result = PowerShellResultSchema.parse(JSON.parse(execution.stdout) as unknown)
    } catch (cause) {
      throw new ApplicationError(
        'DEVICE_IDENTITY_UNAVAILABLE',
        'Не удалось получить идентификатор устройства через Windows CIM',
        { cause },
      )
    }

    return {
      ...result,
      networkInterfaces: this.system.networkInterfaces(),
      platform: this.system.platform(),
      arch: this.system.arch(),
      release: this.system.release(),
    }
  }
}

export class DevelopmentDeviceIdentityProvider implements DeviceIdentityProvider {
  constructor(private readonly data: DeviceRawData) {}

  collect(): Promise<DeviceRawData> {
    return Promise.resolve(this.data)
  }
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed
}

function selectMac(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null {
  const entries = Object.entries(interfaces)
  const validMac = (entry: NetworkInterfaceInfo): boolean =>
    !entry.internal && entry.mac.length > 0 && entry.mac !== '00:00:00:00:00:00'

  for (const [name, values] of entries) {
    const lowerName = name.toLowerCase()
    if (
      !lowerName.includes('ethernet') &&
      !lowerName.includes('wi-fi') &&
      !lowerName.includes('wlan') &&
      !lowerName.includes('en')
    ) {
      continue
    }
    const match = values?.find(validMac)
    if (match !== undefined) return match.mac
  }

  for (const [, values] of entries) {
    const match = values?.find(validMac)
    if (match !== undefined) return match.mac
  }
  return null
}

export class DeviceIdentityService {
  #identityPromise: Promise<string> | undefined

  constructor(private readonly provider: DeviceIdentityProvider) {}

  getIdentity(): Promise<string> {
    this.#identityPromise ??= this.createIdentity()
    return this.#identityPromise
  }

  async getMaskedHint(): Promise<string> {
    const identity = await this.getIdentity()
    return `${identity.slice(0, 8)}...${identity.slice(-4)}`
  }

  private async createIdentity(): Promise<string> {
    const raw = await this.provider.collect()
    const components: string[] = []
    const cpu = clean(raw.cpuProcessorId) ?? clean(raw.cpuModel)
    if (cpu !== null) components.push(`CPU:${cpu}`)

    const board = clean(raw.motherboardSerial)
    if (
      board !== null &&
      !['to be filled by o.e.m.', 'default string'].includes(board.toLowerCase())
    ) {
      components.push(`MB:${board}`)
    }

    const disk = raw.diskSerials
      .map((value) => clean(value))
      .find((value) => value !== null)
    if (disk !== undefined) components.push(`DISK:${disk}`)

    const mac = selectMac(raw.networkInterfaces)
    if (mac !== null) components.push(`MAC:${mac}`)
    components.push(`SYS:${raw.platform}:${raw.arch}:${raw.release}`)

    if (components.length < 2) {
      throw new ApplicationError(
        'DEVICE_IDENTITY_UNAVAILABLE',
        'Недостаточно стабильных компонентов для идентификатора устройства',
      )
    }
    return createHash('sha256').update(components.sort().join('|'), 'utf8').digest('hex')
  }
}
