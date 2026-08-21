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
$sessions = [System.Collections.Generic.List[PSObject]]::new()

# Reserved Claude Code session scanner stub
$claudeProjectDir = Join-Path $ProjectRoot '.claude'
if (Test-Path -LiteralPath $claudeProjectDir -PathType Container) {
    # If custom sessions exist in .claude
    $sessionFiles = Get-ChildItem -LiteralPath $claudeProjectDir -Filter '*.json' -ErrorAction SilentlyContinue
    foreach ($f in $sessionFiles) {
        $sessions.Add([PSCustomObject]@{
            vendor = "claude"
            session_id = $f.BaseName
            title = "Claude Session $($f.BaseName)"
            project_root = $targetRoot
            is_active = $true
            created_at = $f.CreationTimeUtc.ToString('o')
            last_active_at = $f.LastWriteTimeUtc.ToString('o')
            log_path = $f.FullName.Replace('\', '/')
            rule_files = @(Join-Path $ProjectRoot 'CLAUDE.md') | Where-Object { Test-Path -LiteralPath $_ }
        })
    }
}

$sessions | ConvertTo-Json -Depth 8
