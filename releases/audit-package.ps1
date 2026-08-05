# Audits the staged installer payload before it is compiled into a setup.
#
# This app reads a live save directory and the player's Kenshi install, so the
# things that must never ship are: save data, game data, the test fixture, the
# private settings file, and any absolute path from the build machine.
param(
  [Parameter(Mandatory = $true)] [string]$StageRoot,
  [string]$SourceRoot
)

$ErrorActionPreference = 'Stop'
$stage = (Resolve-Path -LiteralPath $StageRoot).Path
$failures = [System.Collections.Generic.List[string]]::new()

$forbiddenNames = @('.git', '.github', '.temp', '.cache', '.fixtures', 'test', 'tests', 'py-reference', 'settings.json', 'eslint.config.js', 'playwright.config.js')
$forbiddenExtensions = @('.save', '.platoon', '.zone', '.mod', '.base', '.log')
# Scripts that only make sense against a developer's machine or the wiki.
$developmentScripts = @('make-fixture.js', 'build-item-catalog.js', 'fetch-wiki-items.js')

Get-ChildItem -LiteralPath $stage -Recurse -Force | ForEach-Object {
  $relative = $_.FullName.Substring($stage.Length + 1)
  if ($forbiddenNames -contains $_.Name -or $developmentScripts -contains $_.Name) {
    $failures.Add("Forbidden staged artifact: $relative")
  }
  if (-not $_.PSIsContainer -and $forbiddenExtensions -contains $_.Extension) {
    $failures.Add("Possible save or game-data artifact: $relative")
  }
}

if ($SourceRoot) {
  $escapedRoot = [regex]::Escape((Resolve-Path -LiteralPath $SourceRoot).Path)
  Get-ChildItem -LiteralPath $stage -Recurse -File |
    Where-Object { $_.Length -lt 10MB -and $_.Extension -notin @('.exe', '.dll', '.ico', '.png') } |
    ForEach-Object {
      if (Select-String -LiteralPath $_.FullName -Pattern $escapedRoot -Quiet) {
        $failures.Add("Build-machine path leaked into: $($_.FullName.Substring($stage.Length + 1))")
      }
    }
}

foreach ($required in @('LICENSE', 'ACKNOWLEDGEMENTS.md', 'package.json', 'server.js', 'bin\launcher.js', 'bin\launch.vbs', 'data\items.canonical.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $stage $required))) { $failures.Add("Required release file missing: $required") }
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Error $_ }
  throw "Package audit failed with $($failures.Count) finding(s)."
}
Write-Host "Package audit passed: $stage"
