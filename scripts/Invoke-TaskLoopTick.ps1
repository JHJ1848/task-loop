[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = '.'
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$preflightScript = Join-Path $scriptDir 'Test-TaskLoopPreflight.ps1'
$scannerScript = Join-Path $scriptDir 'Find-ProjectSessions.ps1'
$reconcileScript = Join-Path $scriptDir 'Reconcile-TaskLoopTopics.ps1'

$runtime = Join-Path $ProjectRoot '.agents\task-loop'
if (-not (Test-Path -LiteralPath $runtime -PathType Container)) {
    $runtime = Join-Path $ProjectRoot '.codex\task-loop'
}

$manifestPath = Join-Path $runtime 'topics.json'
$registryPath = Join-Path $runtime 'sessions.json'

# Step 1: Topic Reconcile if manifest exists
if ((Test-Path -LiteralPath $manifestPath -PathType Leaf) -and (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
    $reconcileOut = & $reconcileScript -ProjectRoot $ProjectRoot -ManifestPath $manifestPath -RegistryPath $registryPath 2>&1
}

# Step 2: Preflight check
$preflightOut = & $preflightScript -ProjectRoot $ProjectRoot 2>&1
$preflight = $preflightOut | Out-String | ConvertFrom-Json

[pscustomobject]@{
    tick_at = [DateTimeOffset]::UtcNow.ToString('o')
    preflight = $preflight
} | ConvertTo-Json -Depth 8
