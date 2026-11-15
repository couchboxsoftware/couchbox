<#
  Builds Couchbox and (unless -NoPublish) publishes it to GitHub Releases, so every installed
  copy offers "Update now". The matching source code is uploaded to the repo's main branch too.

  Examples:
    powershell -File tools\release.ps1 -NoPublish                 # build the current version into dist\ only
    powershell -File tools\release.ps1 -Bump patch                # 0.3.0 -> 0.3.1, notes from CHANGELOG.md
    powershell -File tools\release.ps1 -Bump minor                # 0.3.x -> 0.4.0

  -Bump patch  0.3.0 -> 0.3.1     -Bump minor  0.3.x -> 0.4.0     (default: keep the version)
  -Notes       Optional: overrides the notes. Normally they come from the version's entry in
               CHANGELOG.md (the whole entry on GitHub, the headline in the update banner), and
               publishing refuses to go ahead without one.

  Publishing needs a GitHub token in the GH_TOKEN environment variable (your Windows user
  variables are checked too). The token is never printed.
#>
param(
  [ValidateSet('none', 'patch', 'minor')] [string]$Bump = 'none',
  [string]$Notes = '',
  [switch]$NoPublish
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$node = 'C:\Program Files\nodejs'
if (Test-Path $node) { $env:PATH = "$node;$env:PATH" }

# 1. Token (checked first, so nothing changes if it's missing).
if (-not $NoPublish) {
  if (-not $env:GH_TOKEN) { $env:GH_TOKEN = [Environment]::GetEnvironmentVariable('GH_TOKEN', 'User') }
  if (-not $env:GH_TOKEN) {
    throw 'No GitHub token found. Add a user environment variable called GH_TOKEN (see "Publishing an update" in the README), then try again.'
  }
}

Push-Location $root
try {
  # 2. Version and release notes.
  if ($Bump -ne 'none') { npm version $Bump --no-git-tag-version | Out-Null; if ($LASTEXITCODE) { throw 'npm version failed' } }
  $pkg = Get-Content package.json -Raw | ConvertFrom-Json
  $version = $pkg.version
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Version '$version' must be three numbers, like 0.3.1." }
  # The notes come from this version's entry in CHANGELOG.md (unless -Notes is given): the whole
  # entry goes on the GitHub release page, and its headline is what the update banner shows.
  $headline = $Notes
  if (-not $Notes) {
    $full = node (Join-Path $root 'tools\release-notes.js') $version
    if ($LASTEXITCODE -and -not $NoPublish) { throw "Write the CHANGELOG.md entry for $version first (see the template at the top of that file)." }
    if (-not $LASTEXITCODE) {
      $Notes = ($full -join "`n").Trim()
      $headline = ((node (Join-Path $root 'tools\release-notes.js') $version --headline) -join ' ').Trim()
    }
  }
  $notesFile = Join-Path $root 'build\release-notes.md'
  if ($headline) { [IO.File]::WriteAllText($notesFile, $headline.Trim() + "`n", (New-Object Text.UTF8Encoding $false)) }
  elseif (Test-Path $notesFile) { Remove-Item $notesFile } # don't reuse last release's notes
  Write-Host "Couchbox $version" -ForegroundColor Cyan

  # 3. Build from a short folder path: the installer tool fails on long ones.
  $short = Join-Path $env:TEMP 'couchbox-build'
  robocopy $root $short /MIR /XD "$root\dist" "$short\dist" /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying the project to $short failed (robocopy $LASTEXITCODE)." }
  Push-Location $short
  try {
    if (Test-Path dist) { Remove-Item dist -Recurse -Force }
    # Build first, upload second: publishing during the build raced on GitHub and left
    # latest.yml out of the 0.3.1 release.
    npx electron-builder --win --publish never
    if ($LASTEXITCODE) { throw 'The build failed (see the output above).' }
    $files = "Couchbox-Setup-$version.exe", "Couchbox-Setup-$version.exe.blockmap", "Couchbox-Portable-$version.exe", 'latest.yml'
    foreach ($f in $files) { if (-not (Test-Path (Join-Path 'dist' $f))) { throw "The build didn't produce $f." } }

    # 4. Keep only this version in the project's dist folder.
    $dist = Join-Path $root 'dist'
    New-Item -ItemType Directory -Force $dist | Out-Null
    Get-ChildItem $dist -File | Where-Object { $_.Name -match '^Couchbox[- ].*\.(exe|blockmap)$' -or $_.Name -eq 'latest.yml' } | Remove-Item -Force
    foreach ($f in $files) { Copy-Item (Join-Path 'dist' $f) $dist -Force }

    # 5. Upload the source first (so the release tag points at this version's code), then the
    #    files, attach the notes, and check all four files arrived.
    if (-not $NoPublish) {
      $msg = if ($Notes) { "Couchbox $version`n`n$($Notes.Trim())" } else { "Couchbox $version" }
      node (Join-Path $root 'tools\push-source.js') $msg
      if ($LASTEXITCODE) { throw 'Uploading the source code failed (see the output above).' }

      $publishArgs = @('electron-builder', 'publish', '--version', $version, '--policy', 'always')
      foreach ($f in $files) { $publishArgs += @('-f', (Join-Path 'dist' $f)) }
      npx @publishArgs
      if ($LASTEXITCODE) { throw 'The upload failed (see the output above).' }

      $api = "https://api.github.com/repos/$($pkg.build.publish.owner)/$($pkg.build.publish.repo)"
      $headers = @{ Authorization = "Bearer $env:GH_TOKEN"; 'User-Agent' = 'couchbox-release'; Accept = 'application/vnd.github+json' }
      $release = Invoke-RestMethod "$api/releases/tags/v$version" -Headers $headers
      if ($Notes) {
        $release = Invoke-RestMethod -Method Patch "$api/releases/$($release.id)" -Headers $headers -ContentType 'application/json' -Body (@{ body = $Notes.Trim() } | ConvertTo-Json)
      }
      $missing = $files | Where-Object { $release.assets.name -notcontains $_ }
      if ($missing) { throw "The release is missing: $($missing -join ', '). Run the script again with -Bump none to upload them." }
    }
  } finally { Pop-Location }

  if ($NoPublish) { Write-Host "Built $version into dist\ (not published)." -ForegroundColor Green }
  else { Write-Host "Published $version to https://github.com/couchboxsoftware/couchbox/releases" -ForegroundColor Green }
} finally { Pop-Location }
