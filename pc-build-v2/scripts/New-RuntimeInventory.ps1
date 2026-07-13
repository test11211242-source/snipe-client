param(
  [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '..\resources\python-runtime'),
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\resources\runtime-integrity.json')
)

$ErrorActionPreference = 'Stop'
$runtime = (Resolve-Path $RuntimeDirectory).Path
$files = Get-ChildItem $runtime -Recurse -File | Sort-Object FullName | ForEach-Object {
  $relative = [System.IO.Path]::GetRelativePath($runtime, $_.FullName).Replace('\', '/')
  [ordered]@{
    path = $relative
    size = $_.Length
    sha256 = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant()
  }
}
$inventory = [ordered]@{
  schemaVersion = 1
  root = 'python-runtime'
  files = @($files)
}
$temporary = "$OutputPath.$([guid]::NewGuid()).tmp"
$inventory | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8NoBOM $temporary
Move-Item -Force $temporary $OutputPath
