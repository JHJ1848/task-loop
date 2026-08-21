[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = '.'
)

$ErrorActionPreference = 'Stop'

$runtime = Join-Path $ProjectRoot '.agents\task-loop'
if (-not (Test-Path -LiteralPath $runtime -PathType Container)) {
    $runtime = Join-Path $ProjectRoot '.codex\task-loop'
}

$todoPath = Join-Path $runtime 'todo.json'
$sessionsPath = Join-Path $runtime 'sessions.json'

$stats = [ordered]@{
    total_items = 0
    ready = 0
    in_progress = 0
    done = 0
    blocked = 0
    registered_modules = 0
}

if (Test-Path -LiteralPath $todoPath -PathType Leaf) {
    try {
        $todo = [System.IO.File]::ReadAllText($todoPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $items = @($todo.items)
        $stats.total_items = $items.Count
        $stats.ready = @($items | Where-Object { $_.state -eq 'ready' }).Count
        $stats.in_progress = @($items | Where-Object { $_.state -in @('dispatched', 'in_progress', 'verifying') }).Count
        $stats.done = @($items | Where-Object { $_.state -eq 'done' }).Count
        $stats.blocked = @($items | Where-Object { $_.state -eq 'blocked' }).Count
    }
    catch { }
}

if (Test-Path -LiteralPath $sessionsPath -PathType Leaf) {
    try {
        $sessions = [System.IO.File]::ReadAllText($sessionsPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($null -ne $sessions.modules) {
            $stats.registered_modules = @($sessions.modules.PSObject.Properties).Count
        }
    }
    catch { }
}

[pscustomobject]$stats | ConvertTo-Json -Depth 8
