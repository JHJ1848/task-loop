[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = '.',
    [Parameter(Mandatory = $false)]
    [ValidateSet('Auto', 'Antigravity', 'Codex', 'Claude', 'All')]
    [string]$Vendor = 'Auto'
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$providersDir = Join-Path $scriptDir 'providers'

$allSessions = [System.Collections.Generic.List[PSObject]]::new()

function Invoke-Provider {
    param([string]$ScriptPath)
    if (Test-Path -LiteralPath $ScriptPath -PathType Leaf) {
        $raw = & $ScriptPath -ProjectRoot $ProjectRoot 2>$null
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            try {
                $items = $raw | Out-String | ConvertFrom-Json
                if ($null -ne $items) {
                    if ($items -is [System.Array]) {
                        foreach ($item in $items) { $allSessions.Add($item) }
                    }
                    else {
                        $allSessions.Add($items)
                    }
                }
            }
            catch { }
        }
    }
}

$agyScript = Join-Path $providersDir 'Get-AgyProjectSessions.ps1'
$codexScript = Join-Path $providersDir 'Get-CodexProjectSessions.ps1'
$claudeScript = Join-Path $providersDir 'Get-ClaudeProjectSessions.ps1'

switch ($Vendor) {
    'Antigravity' {
        Invoke-Provider $agyScript
    }
    'Codex' {
        Invoke-Provider $codexScript
    }
    'Claude' {
        Invoke-Provider $claudeScript
    }
    'All' {
        Invoke-Provider $agyScript
        Invoke-Provider $codexScript
        Invoke-Provider $claudeScript
    }
    'Auto' {
        # Check policy.json if active_vendor is configured
        $policyPath1 = Join-Path $ProjectRoot '.agents\task-loop\policy.json'
        $policyPath2 = Join-Path $ProjectRoot '.codex\task-loop\policy.json'
        $activeVendor = $null

        if (Test-Path -LiteralPath $policyPath1 -PathType Leaf) {
            try {
                $p = [System.IO.File]::ReadAllText($policyPath1, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                $activeVendor = $p.active_vendor
            } catch { }
        }
        elseif (Test-Path -LiteralPath $policyPath2 -PathType Leaf) {
            try {
                $p = [System.IO.File]::ReadAllText($policyPath2, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
                $activeVendor = $p.active_vendor
            } catch { }
        }

        if ($activeVendor -eq 'antigravity' -or [string]::IsNullOrWhiteSpace($activeVendor)) {
            Invoke-Provider $agyScript
            if ($allSessions.Count -eq 0) {
                Invoke-Provider $codexScript
            }
        }
        elseif ($activeVendor -eq 'codex') {
            Invoke-Provider $codexScript
            if ($allSessions.Count -eq 0) {
                Invoke-Provider $agyScript
            }
        }
        elseif ($activeVendor -eq 'claude') {
            Invoke-Provider $claudeScript
        }
    }
}

$allSessions | ConvertTo-Json -Depth 8
