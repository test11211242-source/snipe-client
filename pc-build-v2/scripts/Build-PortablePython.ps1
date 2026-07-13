param(
  [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '..\resources\python-runtime'),
  [string]$PythonVersion = '3.11.9',
  [string]$PythonPackageSha256 = '9283876d58c017e0e846f95b490da3bca0fc0a6ee1134b2870677cfb7eec3c67'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$requirements = Join-Path $root 'python\requirements-windows-runtime.txt'
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("cr-tools-v2-python-" + [guid]::NewGuid())
$package = Join-Path $staging "python.$PythonVersion.nupkg"
$expanded = Join-Path $staging 'package'

try {
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $versionLower = $PythonVersion.ToLowerInvariant()
  $source = "https://api.nuget.org/v3-flatcontainer/python/$versionLower/python.$versionLower.nupkg"
  Invoke-WebRequest -UseBasicParsing -Uri $source -OutFile $package
  $actualPackageSha256 = (Get-FileHash -Algorithm SHA256 $package).Hash.ToLowerInvariant()
  if ($actualPackageSha256 -ne $PythonPackageSha256) {
    throw 'Pinned NuGet Python package hash did not match.'
  }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($package, $expanded)

  $tools = Join-Path $expanded 'tools'
  if (-not (Test-Path (Join-Path $tools 'python.exe'))) {
    throw 'Pinned NuGet Python package did not contain tools\python.exe.'
  }
  if (Test-Path $RuntimeDirectory) { Remove-Item -Recurse -Force $RuntimeDirectory }
  New-Item -ItemType Directory -Force -Path $RuntimeDirectory | Out-Null
  Copy-Item -Recurse -Force (Join-Path $tools '*') $RuntimeDirectory

  $python = Join-Path $RuntimeDirectory 'python.exe'
  & $python -m ensurepip --upgrade
  if ($LASTEXITCODE -ne 0) { throw 'ensurepip failed.' }
  & $python -m pip install --disable-pip-version-check --no-compile --no-deps --only-binary=:all: --require-hashes --requirement $requirements
  if ($LASTEXITCODE -ne 0) { throw 'Pinned wheel installation failed.' }
  & $python -m pip check
  if ($LASTEXITCODE -ne 0) { throw 'pip check failed.' }
  & $python -c "import cv2, numpy, windows_capture; print('portable runtime imports verified')"
  if ($LASTEXITCODE -ne 0) { throw 'Portable runtime import smoke failed.' }

  $licenses = Join-Path $RuntimeDirectory 'licenses'
  $licenseFiles = @(Get-ChildItem $RuntimeDirectory -Recurse -File -Include 'LICENSE*','COPYING*')
  New-Item -ItemType Directory -Force -Path $licenses | Out-Null
  $licenseFiles | ForEach-Object {
    $parent = Split-Path $_.DirectoryName -Leaf
    Copy-Item $_.FullName (Join-Path $licenses ("$parent-$($_.Name)")) -Force
  }
  Get-ChildItem $RuntimeDirectory -Recurse -Directory | Where-Object {
    $_.Name -in @('__pycache__', 'tests', 'test')
  } | Sort-Object FullName -Descending | Remove-Item -Recurse -Force
  Get-ChildItem $RuntimeDirectory -Recurse -File -Include '*.pyc','*.pyo' | Remove-Item -Force
  Get-ChildItem (Join-Path $RuntimeDirectory 'Lib\site-packages') -Force | Where-Object {
    $_.Name -eq 'pip' -or $_.Name -like 'pip-*.dist-info'
  } | Remove-Item -Recurse -Force
  Get-ChildItem (Join-Path $RuntimeDirectory 'Scripts') -File -Filter 'pip*.exe' | Remove-Item -Force
  Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'pip\Cache') -ErrorAction SilentlyContinue

  & (Join-Path $PSScriptRoot 'Test-PortableRuntime.ps1') -RuntimeDirectory $RuntimeDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Final portable runtime validation failed.' }
  & (Join-Path $PSScriptRoot 'New-RuntimeInventory.ps1') -RuntimeDirectory $RuntimeDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Runtime inventory generation failed.' }
}
finally {
  Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
}
