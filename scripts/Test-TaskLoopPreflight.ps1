[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$TodoPath,
    [Parameter(Mandatory = $false)]
    [string]$RegistryPath,
    [Parameter(Mandatory = $false)]
    [string]$PolicyPath,
    [Parameter(Mandatory = $false)]
    [string]$LeasePath,
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = '.'
)

$ErrorActionPreference = 'Stop'

function Write-Outcome {
    param(
        [ValidateSet('DISPATCH', 'DISCUSS', 'NOOP', 'INVALID')]
        [string]$Action,
        [string]$Reason,
        [hashtable]$Details = @{}
    )
    $result = [ordered]@{ action = $Action; reason = $Reason }
    foreach ($key in $Details.Keys) {
        $result[$key] = $Details[$key]
    }
    [pscustomobject]$result | ConvertTo-Json -Compress -Depth 8
}

function Read-Json {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $content = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($content)) { return $null }
    return $content | ConvertFrom-Json
}

try {
    # Resolve paths if not specified
    if ([string]::IsNullOrWhiteSpace($TodoPath)) {
        $runtime = Join-Path $ProjectRoot '.agents\task-loop'
        if (-not (Test-Path -LiteralPath $runtime -PathType Container)) {
            $runtime = Join-Path $ProjectRoot '.codex\task-loop'
        }
        $TodoPath = Join-Path $runtime 'todo.json'
        $RegistryPath = Join-Path $runtime 'sessions.json'
        $PolicyPath = Join-Path $runtime 'policy.json'
        $LeasePath = Join-Path $runtime 'lease.json'
    }

    $todo = Read-Json $TodoPath
    if ($null -eq $todo -or $null -eq $todo.items) {
        Write-Outcome 'NOOP' 'no_todo_items'
        exit 0
    }

    # Check active lease
    if (-not [string]::IsNullOrWhiteSpace($LeasePath) -and (Test-Path -LiteralPath $LeasePath -PathType Leaf)) {
        $lease = Read-Json $LeasePath
        if ($null -ne $lease -and $null -ne $lease.expires_at) {
            $expires = [DateTimeOffset]::Parse($lease.expires_at)
            if ($expires -gt [DateTimeOffset]::UtcNow) {
                Write-Outcome 'NOOP' 'active_lease_held' @{ active_task = $lease.task_id; run_id = $lease.run_id }
                exit 0
            }
        }
    }

    $items = @($todo.items)
    $firstActive = @($items | Where-Object { $_.state -notin @('done', 'cancelled') } | Select-Object -First 1)

    if ($firstActive.Count -eq 0) {
        Write-Outcome 'NOOP' 'queue_empty'
        exit 0
    }

    $item = $firstActive[0]

    if ($item.state -eq 'ready' -and $item.confirmation -eq 'approved') {
        Write-Outcome 'DISPATCH' 'eligible' @{ item_id = $item.id; complexity = $item.agent_goal.complexity }
        exit 0
    }
    elseif ($item.state -in @('needs_normalization', 'planning', 'awaiting_user_input', 'awaiting_user_confirmation')) {
        Write-Outcome 'DISCUSS' 'pending_discussion' @{ item_id = $item.id; state = $item.state }
        exit 0
    }

    Write-Outcome 'NOOP' 'item_in_progress' @{ item_id = $item.id; state = $item.state }
    exit 0
}
catch {
    Write-Outcome 'INVALID' 'preflight_error' @{ message = $_.Exception.Message }
    exit 2
}
