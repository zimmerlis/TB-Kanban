<#
.SYNOPSIS
    Packages TB-Kanban into an installable .xpi file.
.DESCRIPTION
    Packages the given git ref (default: HEAD) with `git archive`, so only
    committed, tracked files end up in the .xpi. The output is named after
    the "version" field in manifest.json.
.PARAMETER Ref
    Git ref (branch, tag or commit) to package. Defaults to HEAD.
.PARAMETER OutDir
    Output directory for the .xpi. Defaults to "dist".
.PARAMETER Lint
    Run `web-ext lint` against the working directory before packaging, if
    web-ext is installed.
#>
[CmdletBinding()]
param(
    [string]$Ref = "HEAD",
    [string]$OutDir = "dist",
    [switch]$Lint
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

$status = git status --porcelain
if ($status) {
    Write-Warning "Working tree has uncommitted changes. 'git archive' only packages committed content, so they will NOT be part of the .xpi."
}

if ($Lint) {
    if (Get-Command web-ext -ErrorAction SilentlyContinue) {
        web-ext lint --source-dir .
    } else {
        Write-Warning "web-ext not found (npm i -g web-ext) - skipping lint."
    }
}

$manifest = Get-Content (Join-Path $repoRoot "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) {
    throw "Could not read 'version' from manifest.json"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$xpiPath = Join-Path $OutDir "tb-kanban-$version.xpi"
if (Test-Path $xpiPath) {
    Remove-Item $xpiPath -Force
}

git archive --format=zip --worktree-attributes --output $xpiPath $Ref

Write-Host "Built $xpiPath" -ForegroundColor Green
