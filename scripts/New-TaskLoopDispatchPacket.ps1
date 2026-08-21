[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,
    [Parameter(Mandatory)]
    [string]$RunId,
    [Parameter(Mandatory)]
    [string]$TargetThreadId
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Write-Outcome {
    param(
        [ValidateSet('PREPARED', 'NOOP', 'INVALID')]
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

function Throw-DispatchError {
    param([string]$Reason, [string]$Message)
    $exception = [System.InvalidOperationException]::new($Message)
    $exception.Data['dispatch_reason'] = $Reason
    throw $exception
}

function Read-JsonFile {
    param([string]$Path, [string]$Name)
    if (-not [System.IO.File]::Exists($Path)) {
        Throw-DispatchError 'invalid_dispatch_state' "$Name file does not exist."
    }
    $content = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($content)) {
        Throw-DispatchError 'invalid_dispatch_state' "$Name file is empty."
    }
    try {
        return $content | ConvertFrom-Json
    }
    catch {
        Throw-DispatchError 'invalid_dispatch_state' "$Name file is not valid JSON."
    }
}

function Test-RequiredText {
    param([object]$Value)
    return $null -ne $Value -and -not [string]::IsNullOrWhiteSpace([string]$Value)
}

function Normalize-Complexity {
    param([object]$RawComplexity)
    if ($null -eq $RawComplexity) { return 2 }
    $str = [string]$RawComplexity
    switch -Regex ($str) {
        '^(1|simple)$' { return 1 }
        '^(2|standard|medium)$' { return 2 }
        '^(3|complex)$' { return 3 }
        default { return 2 }
    }
}

try {
    $root = [System.IO.Path]::GetFullPath($ProjectRoot)
    if (-not [System.IO.Directory]::Exists($root)) {
        Throw-DispatchError 'invalid_project_root' 'Project root directory does not exist.'
    }

    $parsedRunId = [guid]::Empty
    if (-not [guid]::TryParse($RunId, [ref]$parsedRunId) -or $parsedRunId -eq [guid]::Empty) {
        Throw-DispatchError 'invalid_run_id' 'RunId must be a non-empty UUID.'
    }
    $canonicalRunId = $parsedRunId.ToString('D')

    if (-not (Test-RequiredText $TargetThreadId)) {
        Throw-DispatchError 'target_mismatch' 'TargetThreadId is required.'
    }

    # Support .agents/task-loop and fallback to .codex/task-loop
    $runtime = Join-Path $root '.agents\task-loop'
    if (-not (Test-Path -LiteralPath $runtime -PathType Container)) {
        $legacyRuntime = Join-Path $root '.codex\task-loop'
        if (Test-Path -LiteralPath $legacyRuntime -PathType Container) {
            $runtime = $legacyRuntime
        }
    }

    $todoPath = Join-Path $runtime 'todo.json'
    $registryPath = Join-Path $runtime 'sessions.json'
    $policyPath = Join-Path $runtime 'policy.json'
    $leasePath = Join-Path $runtime 'lease.json'
    $journalPath = Join-Path $runtime 'run-journal.jsonl'
    $acquirePath = Join-Path $PSScriptRoot 'Acquire-TaskLoopLease.ps1'

    $todo = Read-JsonFile $todoPath 'todo'
    $registry = Read-JsonFile $registryPath 'sessions'
    $policy = if (Test-Path -LiteralPath $policyPath -PathType Leaf) { Read-JsonFile $policyPath 'policy' } else { [pscustomobject]@{ lease_minutes = 25 } }

    $items = @($todo.items)
    $candidate = @($items | Where-Object { $_.state -notin @('done', 'cancelled') } | Select-Object -First 1)
    if ($candidate.Count -ne 1) {
        Write-Outcome 'NOOP' 'no_eligible_items'
        exit 0
    }
    $item = $candidate[0]
    $goal = $item.agent_goal

    # Evaluate 1/2/3 complexity & subagent policy
    $complexityLevel = Normalize-Complexity $goal.complexity
    $subagentPolicy = switch ($complexityLevel) {
        1 { 'none' }
        2 { 'optional' }
        3 { 'mandatory' }
    }
    $executionMode = switch ($complexityLevel) {
        1 { 'single_thread_direct' }
        2 { 'standard_topic' }
        3 { 'subagent_orchestration_required' }
    }

    $allowlist = if ($null -ne $goal.allowlist) { @($goal.allowlist) } else { @('*') }
    $acceptanceCriteria = if ($null -ne $goal.acceptance_criteria) { @($goal.acceptance_criteria) } else { @() }
    $verification = if ($null -ne $goal.verification) { @($goal.verification) } else { @() }

    $createdAt = [DateTimeOffset]::UtcNow.ToString('O')
    $packet = [ordered]@{
        schema_version = 2
        task_id = [string]$item.id
        run_id = $canonicalRunId
        target_thread_id = [string]$TargetThreadId
        complexity = $complexityLevel
        subagent_policy = $subagentPolicy
        execution_mode = $executionMode
        objective = [string]$goal.objective
        allowlist = $allowlist
        acceptance_criteria = $acceptanceCriteria
        verification = $verification
        authorization = [ordered]@{
            change_intent = if ($goal.change_intent) { [string]$goal.change_intent } else { 'change' }
            commit_policy = if ($goal.commit_policy) { [string]$goal.commit_policy } else { 'local_commit' }
            remote_push_allowed = $false
        }
        created_at = $createdAt
    }

    $dispatchDirectory = Join-Path $runtime 'dispatch'
    [System.IO.Directory]::CreateDirectory($dispatchDirectory) | Out-Null
    $packetPath = Join-Path $dispatchDirectory "$canonicalRunId.json"

    # Acquire lease
    if (Test-Path -LiteralPath $acquirePath -PathType Leaf) {
        $leaseMinutes = if ($policy.lease_minutes) { [int]$policy.lease_minutes } else { 25 }
        $leaseOutput = & $acquirePath -LeasePath $leasePath -TaskId ([string]$item.id) -RunId $canonicalRunId -LeaseMinutes $leaseMinutes 2>&1
    }

    $jsonBytes = $utf8.GetBytes(($packet | ConvertTo-Json -Depth 16))
    [System.IO.File]::WriteAllBytes($packetPath, $jsonBytes)

    Write-Outcome 'PREPARED' 'dispatch_packet_created' @{
        run_id = $canonicalRunId
        packet_path = [System.IO.Path]::GetRelativePath($root, $packetPath).Replace('\', '/')
        complexity = $complexityLevel
        subagent_policy = $subagentPolicy
    }
    exit 0
}
catch {
    $reason = [string]$_.Exception.Data['dispatch_reason']
    if ([string]::IsNullOrWhiteSpace($reason)) {
        $reason = 'invalid_dispatch_state'
    }
    Write-Outcome 'INVALID' $reason @{ message = $_.Exception.Message }
    exit 2
}
