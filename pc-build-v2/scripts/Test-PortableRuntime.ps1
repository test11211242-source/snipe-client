param(
  [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '..\resources\python-runtime')
)

$ErrorActionPreference = 'Stop'
$python = Join-Path $RuntimeDirectory 'python.exe'
if (-not (Test-Path $python -PathType Leaf)) {
  throw "Portable runtime is missing python.exe: $RuntimeDirectory"
}
& $python -c "import cv2, numpy, windows_capture; assert cv2.__version__; assert numpy.__version__"
if ($LASTEXITCODE -ne 0) { throw 'Portable runtime module validation failed.' }
