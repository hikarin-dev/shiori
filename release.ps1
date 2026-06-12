# Usage: .\release.ps1 1.1.0
# Releases the app: patches versions, zips the public app files, commits, tags, pushes,
# and creates the GitHub release. The extension (private, gitignored) gets its manifest
# version bumped in step too when present, but is never included in the zip.
param([Parameter(Mandatory)][string]$Version)

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "Version must be X.Y.Z (e.g. 1.1.0)" -ForegroundColor Red
    exit 1
}

# CHANGELOG.md must already have an entry for this version.
$changelog = Get-Content CHANGELOG.md -Raw
if ($changelog -notmatch [regex]::Escape("## v$Version")) {
    Write-Host "No entry for v$Version found in CHANGELOG.md — add it first, then re-run." -ForegroundColor Red
    exit 1
}

# Patch version fields in-place (no reformatting).
function Patch-Version([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    $raw     = Get-Content $Path -Raw
    $patched = $raw -replace '"version"\s*:\s*"[^"]*"', "`"version`": `"$Version`""
    [System.IO.File]::WriteAllText((Resolve-Path $Path).Path, $patched, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "$Path  →  v$Version" -ForegroundColor Cyan
}
Patch-Version 'app/manifest.webmanifest'     # the app's version (shown in Settings → About)
Patch-Version 'extension/manifest.json'      # private extension manifest, kept in step if present

# Build distributable zip of the public app files only.
$zip = "shiori-v$Version.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path 'app', 'icons', 'vendor', 'index.html', 'README.md', 'CHANGELOG.md' -DestinationPath $zip
Write-Host "$zip built" -ForegroundColor Cyan

# Commit, tag, push.
git add app/manifest.webmanifest CHANGELOG.md
git commit -m "chore: release v$Version"
git tag "v$Version"
git push origin main
git push origin "v$Version"

# Extract changelog notes for this version (text between this heading and the next).
$notes = [regex]::Match(
    $changelog,
    "(?<=## v$([regex]::Escape($Version))[^\n]*\n)[\s\S]*?(?=\n## |\z)"
).Value.Trim()

gh release create "v$Version" $zip `
    --title "v$Version" `
    --notes $notes

Write-Host "Released v$Version" -ForegroundColor Green
