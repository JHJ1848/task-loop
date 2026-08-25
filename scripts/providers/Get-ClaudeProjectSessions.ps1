[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = '.'
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/').Replace('\', '/').ToLowerInvariant()
}

$targetRoot = Get-NormalizedPath $ProjectRoot
$scriptDir = $PSScriptRoot
$pyScript = Join-Path $scriptDir 'get_claude_project_sessions.py'

if (Test-Path -LiteralPath $pyScript -PathType Leaf) {
    $raw = & python $pyScript $ProjectRoot 2>$null
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
        Write-Output $raw
        exit 0
    }
}

# Fallback empty list
@() | ConvertTo-Json -Depth 8

