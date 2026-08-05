# Builds the offline, per-user Windows installer for the Kenshi MKII Editor.
#
#   powershell -ExecutionPolicy Bypass -File releases\build.ps1
#   powershell -ExecutionPolicy Bypass -File releases\build.ps1 -SkipCompile
#
# Stages a runtime-only copy of webapp\ plus a bundled node.exe into
# releases\build\app, audits it, generates the Inno Setup script and compiles it.
# The installer needs no Node.js on the target machine and no network access.
param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$BuildRoot = (Join-Path $PSScriptRoot 'build'),
  [string]$IsccPath = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  [string]$NodeExe = (Get-Command node -ErrorAction Stop).Source,
  [string]$NpmCmd = (Get-Command npm.cmd -ErrorAction Stop).Source,
  # Version to stamp the installer with. Defaults to webapp/package.json.
  [string]$Version = '',
  [string]$Publisher = 'Kenshi MKII Editor contributors',
  [string]$PublisherUrl = '',
  [string]$SupportUrl = '',
  [switch]$SkipCompile
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($ProjectRoot)
$webapp = Join-Path $root 'webapp'
$releases = [IO.Path]::GetFullPath($PSScriptRoot)
$build = [IO.Path]::GetFullPath($BuildRoot)
$appDest = Join-Path $build 'app'
$iconSrc = Join-Path $root 'icons\app_icon.ico'

# The build root is deleted wholesale below, so refuse anything but a child of
# releases\.
if ($build -eq $root -or $build -eq $releases -or -not $build.StartsWith($releases, [StringComparison]::OrdinalIgnoreCase)) {
  throw "BuildRoot must be a child of the releases directory: $releases"
}

if (-not (Test-Path -LiteralPath $iconSrc)) {
  Write-Host 'Generating icons/app_icon.ico...'
  & $NodeExe (Join-Path $webapp 'scripts\make-icon.js')
  if ($LASTEXITCODE -ne 0) { throw 'Failed to generate the application icon' }
}
foreach ($required in @($webapp, $NodeExe, $NpmCmd, $iconSrc)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required build input not found: $required" }
}

# Stage runtime files only. Tests, the save fixture, the name-index cache, the
# private settings file and the wiki-scraping build inputs are deliberately
# absent from these allowlists.
if (Test-Path -LiteralPath $build) { Remove-Item -LiteralPath $build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $appDest | Out-Null
$include = @('server.js', 'package.json', 'package-lock.json', 'LICENSE', 'routes', 'services', 'public', 'bin')
foreach ($item in $include) {
  $src = Join-Path $webapp $item
  if (-not (Test-Path -LiteralPath $src)) { throw "Required runtime path missing from webapp: $item" }
  Copy-Item -LiteralPath $src -Destination $appDest -Recurse -Force
}

# data\: only the two files services read at runtime. The wiki snapshot and the
# item-map audit are build inputs for scripts\build-item-catalog.js.
$dataDest = Join-Path $appDest 'data'
New-Item -ItemType Directory -Force -Path $dataDest | Out-Null
foreach ($dataFile in @('items.canonical.json', 'itemSlotObservations.json')) {
  Copy-Item -LiteralPath (Join-Path $webapp "data\$dataFile") -Destination $dataDest -Force
}

# scripts\: the console report is useful to a user; the fixture maker and the
# catalog builder are not, and audit-package.ps1 rejects them.
$scriptsDest = Join-Path $appDest 'scripts'
New-Item -ItemType Directory -Force -Path $scriptsDest | Out-Null
Copy-Item -LiteralPath (Join-Path $webapp 'scripts\status.js') -Destination $scriptsDest -Force

Copy-Item -LiteralPath (Join-Path $root 'ACKNOWLEDGEMENTS.md') -Destination (Join-Path $appDest 'ACKNOWLEDGEMENTS.md') -Force
Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination (Join-Path $appDest 'README.md') -Force

Write-Host 'Installing production dependencies...'
Push-Location $appDest
# --ignore-scripts: the staged app is a copy outside the repo, so lifecycle
# scripts would run without their tooling and abort the build.
try { & $NpmCmd ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error 2>&1 | ForEach-Object { Write-Host $_ } }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }

# npm packages publish their own fixtures and repository metadata. They are not
# runtime dependencies, and audit-package.ps1 flags directories named test/.
$nodeModules = Join-Path $appDest 'node_modules'
$nodeModulesPrefix = $nodeModules.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
Get-ChildItem -LiteralPath $nodeModules -Directory -Recurse -Force |
  Where-Object { $_.Name -in @('test', 'tests', '.github') } |
  Sort-Object { $_.FullName.Length } -Descending |
  ForEach-Object {
    $target = [IO.Path]::GetFullPath($_.FullName)
    if (-not $target.StartsWith($nodeModulesPrefix, [StringComparison]::OrdinalIgnoreCase) -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Unsafe package cleanup target: $target"
    }
    Remove-Item -LiteralPath $target -Recurse -Force
  }

# The bundled runtime: the target machine needs no Node.js install.
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $appDest 'bin\node.exe') -Force
Copy-Item -LiteralPath $iconSrc -Destination (Join-Path $appDest 'bin\app_icon.ico') -Force

& (Join-Path $releases 'audit-package.ps1') -StageRoot $appDest -SourceRoot $root

if (-not $Version) {
  $pkg = Get-Content (Join-Path $webapp 'package.json') -Raw | ConvertFrom-Json
  $Version = $pkg.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid version: '$Version'" }
# PowerShell variable names are case-insensitive: $version below is $Version.
$version = $Version
$publisherUrlLine = if ($PublisherUrl) { "AppPublisherURL=$PublisherUrl" } else { '' }
$supportUrlLine = if ($SupportUrl) { "AppSupportURL=$SupportUrl" } else { '' }

$iss = @"
; Kenshi MKII Editor - offline per-user installer
; Generated by releases/build.ps1 - edit that script, not this file.
#define MyAppName "Kenshi MKII Editor"
#define MyAppVersion "$version"
#define MyAppPublisher "$Publisher"

[Setup]
AppId={{6D1B0F3A-9C42-4A7E-B58D-3E7C1A2F84B9}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
$publisherUrlLine
$supportUrlLine
DefaultDirName={localappdata}\Programs\KenshiMKIIEditor
DefaultGroupName=Kenshi MKII Editor
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir="$releases"
OutputBaseFilename=kenshi-mkii-editor-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile="$iconSrc"
LicenseFile="$appDest\LICENSE"
InfoBeforeFile="$appDest\ACKNOWLEDGEMENTS.md"
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\bin\app_icon.ico
CreateAppDir=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "$appDest\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\bin\launch.vbs"; WorkingDir: "{app}\bin"; IconFilename: "{app}\bin\app_icon.ico"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\bin\launch.vbs"; WorkingDir: "{app}\bin"; IconFilename: "{app}\bin\app_icon.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"

[Run]
Filename: "{app}\bin\launch.vbs"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall runhidden shellexec

; Stop a running editor before its files are removed, so an in-flight write is
; never interrupted halfway.
[UninstallRun]
Filename: "{app}\bin\node.exe"; Parameters: """{app}\bin\launcher.js"" --stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopInstalledEditor"

; The name-index cache is generated at runtime, so uninstall has to clean it up.
[UninstallDelete]
Type: filesandordirs; Name: "{app}\.cache"
Type: filesandordirs; Name: "{app}\node_modules"
Type: files; Name: "{localappdata}\KenshiMKIIEditor\kenshi-mkii-editor.lock"
Type: dirifempty; Name: "{localappdata}\KenshiMKIIEditor"
"@

$issPath = Join-Path $releases 'kenshi-mkii-editor.iss'
Set-Content -LiteralPath $issPath -Value $iss -Encoding UTF8
Write-Host "Wrote kenshi-mkii-editor.iss (v$version)"

if (-not $SkipCompile) {
  if (-not (Test-Path -LiteralPath $IsccPath)) { throw "ISCC not found at $IsccPath. Install Inno Setup 6 or pass -SkipCompile." }
  & $IsccPath $issPath 2>&1 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }
  Write-Host "DONE. Output: $releases\kenshi-mkii-editor-$version.exe"
}
