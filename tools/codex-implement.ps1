# Ask Codex to implement a task written by Claude Code, and save Codex's report next to the task file.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/codex-implement.ps1 -Task .ai-tasks/xxx.md
# Codex runs in a workspace-write sandbox: it can edit files in this folder only.
param(
    [Parameter(Mandatory = $true)][string]$Task
)

$ErrorActionPreference = "Stop"

function Fail([string]$msg, [int]$code) {
    [Console]::Error.WriteLine("codex-implement: " + $msg)
    exit $code
}

$root = Split-Path -Parent $PSScriptRoot
$taskPath = if ([IO.Path]::IsPathRooted($Task)) { $Task } else { Join-Path $root $Task }
if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf)) {
    Fail "Task file not found: $Task" 2
}
$taskFull = (Resolve-Path -LiteralPath $taskPath).Path
$tasksDir = (Resolve-Path -LiteralPath (Join-Path $root ".ai-tasks") -ErrorAction SilentlyContinue)
if (-not $tasksDir -or -not $taskFull.StartsWith($tasksDir.Path + [IO.Path]::DirectorySeparatorChar)) {
    Fail "Task file must be inside .ai-tasks/." 2
}

$codex = (Get-Command codex.cmd -ErrorAction SilentlyContinue).Source
if (-not $codex) {
    Fail "codex.cmd not found in PATH." 3
}

$outFile = [IO.Path]::ChangeExtension($taskFull, $null).TrimEnd('.') + "_result.md"
if (Test-Path -LiteralPath $outFile) {
    Fail "Result file already exists: $outFile (write a new task file instead of re-running)" 5
}

$template = Get-Content -LiteralPath (Join-Path $PSScriptRoot "codex-implement-prompt.md") -Raw -Encoding UTF8
$taskText = Get-Content -LiteralPath $taskFull -Raw -Encoding UTF8
$relative = $taskFull.Substring($root.Length + 1)
$prompt = $template.Replace("{{TASK_FILE}}", $relative).Replace("{{TASK}}", $taskText)

# Pass the prompt through stdin as UTF-8 so Japanese text survives.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$prompt | & $codex exec --sandbox workspace-write --ephemeral --color never -C $root -o $outFile - | Out-Null
$code = $LASTEXITCODE

if ($code -ne 0 -or -not (Test-Path -LiteralPath $outFile)) {
    Fail "Codex implementation failed (exit code $code)." 1
}

Write-Output "Result saved: $outFile"
