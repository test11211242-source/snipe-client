param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,
    [string]$BaseInstallerPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$BaseVersion = '0.1.18'
$BaseInstallerUrl = 'https://updates.artcsworld.xyz/downloads/v2/CR_Tools_V2_Setup_0.1.18.exe'
$BaseInstallerSha512 = 'D2A2D50B7C2AADA8D9DDD47E23520D2D49516B534D471C4C2237445EEB9495664DAA1C4BE68F3150E34C098632304DE09D7AC2308CF3EA608ED43603D7D37BC4'
$BaseInstallerSize = 159201176

if ($ExpectedVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw 'Expected version must be strict x.y.z semver.'
}
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$expectedName = "CR_Tools_V2_Setup_$ExpectedVersion.exe"
if ([System.IO.Path]::GetFileName($resolvedInstaller) -cne $expectedName) {
    throw 'Upgrade installer name does not match the expected version.'
}

$testRoot = Join-Path $env:RUNNER_TEMP "cr-tools-v2-upgrade-$PID"
$downloadedBaseInstaller = Join-Path $testRoot "CR_Tools_V2_Setup_$BaseVersion.exe"
$installDirectory = Join-Path $testRoot 'installed with spaces'

function Invoke-NsisInstaller {
    param(
        [string]$Path,
        [string[]]$Arguments
    )
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru -Wait
    if ($process.ExitCode -ne 0) {
        throw "NSIS process exited with code $($process.ExitCode)."
    }
}

function Assert-ExecutablePresent {
    $executable = Join-Path $installDirectory 'CR Tools V2.exe'
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw 'Installed application executable is missing.'
    }
}

function Assert-InstalledVersion {
    param([string]$Version)
    Assert-ExecutablePresent
    $versionFile = Join-Path $installDirectory 'resources' 'app-version.json'
    if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) {
        throw "Version metadata file is missing: $versionFile"
    }
    $appVersion = (Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json).version
    if ($appVersion -ne $Version) {
        throw "Installed version $appVersion does not match $Version."
    }
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    if ([string]::IsNullOrWhiteSpace($BaseInstallerPath)) {
        & curl.exe --fail --silent --show-error --proto '=https' --tlsv1.2 $BaseInstallerUrl --output $downloadedBaseInstaller
        if ($LASTEXITCODE -ne 0) { throw 'Base installer download failed.' }
        $baseInstaller = $downloadedBaseInstaller
    } else {
        $baseInstaller = (Resolve-Path -LiteralPath $BaseInstallerPath).Path
        if ([System.IO.Path]::GetFileName($baseInstaller) -cne "CR_Tools_V2_Setup_$BaseVersion.exe") {
            throw 'Base installer name is invalid.'
        }
    }
    $baseStatus = Get-Item -LiteralPath $baseInstaller
    if ($baseStatus.Length -ne $BaseInstallerSize) { throw 'Base installer size mismatch.' }
    if ((Get-FileHash -LiteralPath $baseInstaller -Algorithm SHA512).Hash -cne $BaseInstallerSha512) {
        throw 'Base installer hash mismatch.'
    }

    # /S and the final /D= argument are documented NSIS installer switches.
    Invoke-NsisInstaller -Path $baseInstaller -Arguments @('/S', "/D=$installDirectory")
    Assert-ExecutablePresent
    Invoke-NsisInstaller -Path $resolvedInstaller -Arguments @('/S', "/D=$installDirectory")
    Assert-InstalledVersion -Version $ExpectedVersion
} finally {
    $uninstaller = Join-Path $installDirectory 'Uninstall CR Tools V2.exe'
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
        try { Invoke-NsisInstaller -Path $uninstaller -Arguments @('/S') } catch { Write-Warning $_ }
    }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Verified NSIS install-over-existing flow from $BaseVersion to $ExpectedVersion."
