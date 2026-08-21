[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$RootPath = '.agents/task-loop',
    [Parameter(Mandatory = $false)]
    [string]$MainThreadId = ([guid]::NewGuid().ToString('D')),
    [Parameter(Mandatory = $false)]
    [string]$ActiveVendor = 'antigravity'
)

$ErrorActionPreference = 'Stop'

function Initialize-FileIfMissing {
    param([string]$Path, [string]$Content)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        [System.IO.File]::WriteAllText($Path, $Content, [System.Text.Encoding]::UTF8)
    }
}

try {
    if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
        [System.IO.Directory]::CreateDirectory($RootPath) | Out-Null
    }

    $todoPath = Join-Path $RootPath 'todo.json'
    $sessionsPath = Join-Path $RootPath 'sessions.json'
    $topicsPath = Join-Path $RootPath 'topics.json'
    $policyPath = Join-Path $RootPath 'policy.json'
    $journalPath = Join-Path $RootPath 'run-journal.jsonl'

    $defaultTodo = @{
        schema_version = 2
        items = @()
    } | ConvertTo-Json -Depth 8

    $defaultSessions = @{
        schema_version = 1
        main_thread_id = $MainThreadId
        modules = @{}
    } | ConvertTo-Json -Depth 8

    $defaultTopics = @{
        schema_version = 1
        ignored_memory_docs = @()
        topics = @()
    } | ConvertTo-Json -Depth 8

    $defaultPolicy = @{
        schema_version = 1
        active_vendor = $ActiveVendor
        lease_minutes = 25
        allow_remote_push = $false
        model_profiles = @{
            simple = "gpt-5.6-luna"
            standard = "gpt-5.6-terra"
            complex = "gpt-5.6-sol"
        }
    } | ConvertTo-Json -Depth 8

    Initialize-FileIfMissing $todoPath $defaultTodo
    Initialize-FileIfMissing $sessionsPath $defaultSessions
    Initialize-FileIfMissing $topicsPath $defaultTopics
    Initialize-FileIfMissing $policyPath $defaultPolicy
    if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) {
        [System.IO.File]::WriteAllText($journalPath, "", [System.Text.Encoding]::UTF8)
    }

    [pscustomobject]@{
        action = 'INITIALIZED'
        root = $RootPath
        main_thread_id = $MainThreadId
        active_vendor = $ActiveVendor
    } | ConvertTo-Json -Compress
    exit 0
}
catch {
    [pscustomobject]@{
        action = 'INVALID'
        reason = 'initialization_error'
        message = $_.Exception.Message
    } | ConvertTo-Json -Compress
    exit 2
}
