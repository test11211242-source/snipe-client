param(
  [string]$RuntimeDirectory = (Join-Path $PSScriptRoot '..\resources\python-runtime')
)

$ErrorActionPreference = 'Stop'
$python = Join-Path $RuntimeDirectory 'python.exe'
if (-not (Test-Path $python -PathType Leaf)) {
  throw "Portable runtime is missing python.exe: $RuntimeDirectory"
}
& $python -I -B -c "import cv2, numpy, windows_capture; assert cv2.__version__; assert numpy.__version__"
if ($LASTEXITCODE -ne 0) { throw 'Portable runtime module validation failed.' }

$applicationPython = Join-Path $PSScriptRoot '..\python'
$packagingConfig = Get-Content (Join-Path $PSScriptRoot '..\electron-builder.yml') -Raw
foreach ($asset in @('vs_badge_v1.png', 'vs_badge_v1_mask.png', 'result_screen_v1.json', 'pol_rank_v1.json')) {
  $assetPath = Join-Path $applicationPython "assets\$asset"
  if (-not (Test-Path $assetPath -PathType Leaf)) { throw "Missing VS asset: $asset" }
  if (-not $packagingConfig.Contains("'assets/$asset'")) { throw "VS asset is not packaged: $asset" }
}
if (-not $packagingConfig.Contains("'geometry/**/*.py'")) { throw 'Geometry modules are not packaged.' }
& $python -I -B -c "import sys; sys.path.insert(0, sys.argv[1]); from geometry.vs_finder import _assets; image, mask = _assets(); assert image.shape[:2] == mask.shape" $applicationPython
if ($LASTEXITCODE -ne 0) { throw 'Portable runtime VS asset validation failed.' }
& $python -I -B -c "import sys; sys.path.insert(0, sys.argv[1]); from geometry.result_screen import ResultTemplates; from geometry.rank_line import RankTemplates; ResultTemplates.load(); RankTemplates.load()" $applicationPython
if ($LASTEXITCODE -ne 0) { throw 'Portable runtime prediction asset validation failed.' }

$bytecodeFiles = @(Get-ChildItem $RuntimeDirectory -Recurse -File -Include '*.pyc','*.pyo')
$bytecodeDirectories = @(Get-ChildItem $RuntimeDirectory -Recurse -Directory | Where-Object {
  $_.Name -eq '__pycache__'
})
if ($bytecodeFiles.Count -ne 0 -or $bytecodeDirectories.Count -ne 0) {
  throw 'Portable runtime contains mutable Python bytecode caches.'
}
