[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = '.',
    [Parameter(Mandatory = $false)]
    [ValidateSet('Auto', 'Antigravity', 'Codex', 'Claude', 'All')]
    [string]$Vendor = 'Auto',
    [Parameter(Mandatory = $false)]
    [ValidateSet('markdown', 'json', 'tsv')]
    [string]$Format = 'markdown',
    [Parameter(Mandatory = $false)]
    [switch]$ActiveOnly,
    [Parameter(Mandatory = $false)]
    [int]$Limit = 20
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$pyScript = Join-Path $scriptDir 'summarize_project_sessions.py'

$argsList = @($pyScript, '--root', $ProjectRoot, '--vendor', $Vendor, '--format', $Format, '--limit', $Limit)
if ($ActiveOnly) {
    $argsList += '--active-only'
}

& python @argsList
