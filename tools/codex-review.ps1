# Run a read-only Codex review and save the result to .ai-review/ as Markdown.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/codex-review.ps1 -Round 1 [-Target "src/a.js"] [-Note "..."]
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/codex-review.ps1 -Round 2 [-Previous .ai-review/xxx_round1.md]
# Reviews are limited to 2 rounds per change.
param(
    [Parameter(Mandatory = $true)][int]$Round,
    [string]$Target = "",
    [string]$Note = "",
    [string]$Previous = ""
)

$ErrorActionPreference = "Stop"

function Fail([string]$msg, [int]$code) {
    [Console]::Error.WriteLine("codex-review: " + $msg)
    exit $code
}

if ($Round -lt 1 -or $Round -gt 2) {
    Fail "Round must be 1 or 2. Reviews are limited to 2 rounds; report remaining issues to the user." 2
}

$root = Split-Path -Parent $PSScriptRoot
$reviewDir = Join-Path $root ".ai-review"
if (-not (Test-Path $reviewDir)) { New-Item -ItemType Directory -Path $reviewDir | Out-Null }

$codex = (Get-Command codex.cmd -ErrorAction SilentlyContinue).Source
if (-not $codex) {
    Fail "codex.cmd not found in PATH." 3
}

$template = Get-Content -LiteralPath (Join-Path $PSScriptRoot "codex-review-prompt.md") -Raw -Encoding UTF8

if ($Target -eq "") { $Target = "Uncommitted changes (git status / git diff). If there are no commits yet, review all files in this folder." }
if ($Note -eq "") { $Note = "(none)" }

$previousSection = ""
$round2Section = ""
if ($Round -eq 2) {
    if ($Previous -eq "") {
        $latest = Get-ChildItem -Path $reviewDir -Filter "*_round1.md" | Sort-Object Name -Descending | Select-Object -First 1
        if (-not $latest) {
            Fail "No round1 review found in .ai-review/. Run -Round 1 first." 4
        }
        $Previous = $latest.FullName
    }
    if (-not (Test-Path -LiteralPath $Previous -PathType Leaf)) {
        Fail "Previous review not found: $Previous" 4
    }
    $prevFull = (Resolve-Path -LiteralPath $Previous).Path
    $reviewDirResolved = (Resolve-Path -LiteralPath $reviewDir -ErrorAction SilentlyContinue)
    if (-not $reviewDirResolved -or -not $prevFull.StartsWith($reviewDirResolved.Path + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        Fail "Previous must be inside .ai-review/" 4
    }
    $prevText = Get-Content -LiteralPath $prevFull -Raw -Encoding UTF8
    $previousSection = "## Previous review (round 1) and Claude Code's response`n`n" + $prevText
    $round2Section = "## Status of round 1 findings (write this section in Japanese)`n| # | Status (resolved / unresolved / not needed and justified) | Comment |`n|---|---|---|`n"
}

$prompt = $template.Replace("{{TARGET}}", $Target).Replace("{{NOTE}}", $Note).Replace("{{PREVIOUS}}", $previousSection).Replace("{{ROUND}}", [string]$Round).Replace("{{ROUND2_SECTION}}", $round2Section)

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outFile = Join-Path $reviewDir ("{0}_round{1}.md" -f $stamp, $Round)
if (Test-Path -LiteralPath $outFile) {
    Fail "Output file already exists: $outFile" 5
}

# Pass the prompt through stdin as UTF-8 so Japanese text survives.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$prompt | & $codex exec --sandbox read-only --ephemeral --color never -C $root -o $outFile - | Out-Null
$code = $LASTEXITCODE

if ($code -ne 0 -or -not (Test-Path -LiteralPath $outFile)) {
    Fail "Codex review failed (exit code $code)." 1
}

Write-Output "Review saved: $outFile"
