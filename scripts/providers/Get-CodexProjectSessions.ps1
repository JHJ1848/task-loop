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

# Check .codex/task-loop/sessions.json or global registry
$localRegistry = Join-Path $ProjectRoot '.codex\task-loop\sessions.json'
if (Test-Path -LiteralPath $localRegistry -PathType Leaf) {
    try {
        $content = [System.IO.File]::ReadAllText($localRegistry, [System.Text.Encoding]::UTF8)
        $reg = $content | ConvertFrom-Json
        if ($null -ne $reg.main_thread_id) {
            $sessions.Add([PSCustomObject]@{
                vendor = "codex"
                session_id = [string]$reg.main_thread_id
                title = "Codex Main Dispatcher"
                project_root = $targetRoot
                is_active = $true
                created_at = (Get-Item -LiteralPath $localRegistry).CreationTimeUtc.ToString('o')
                last_active_at = (Get-Item -LiteralPath $localRegistry).LastWriteTimeUtc.ToString('o')
                log_path = $localRegistry.Replace('\', '/')
                rule_files = @(Join-Path $ProjectRoot 'AGENTS.md') | Where-Object { Test-Path -LiteralPath $_ }
            })
        }
        if ($null -ne $reg.modules) {
            foreach ($prop in $reg.modules.PSObject.Properties) {
                $mod = $prop.Value
                if ($null -ne $mod -and -not [string]::IsNullOrWhiteSpace($mod.thread_id)) {
                    $sessions.Add([PSCustomObject]@{
                        vendor = "codex"
                        session_id = [string]$mod.thread_id
                        title = [string]$mod.title
                        module_key = [string]$prop.Name
                        project_root = $targetRoot
                        is_active = $true
                        created_at = (Get-Item -LiteralPath $localRegistry).CreationTimeUtc.ToString('o')
                        last_active_at = (Get-Item -LiteralPath $localRegistry).LastWriteTimeUtc.ToString('o')
                        log_path = $localRegistry.Replace('\', '/')
                        rule_files = @(Join-Path $ProjectRoot 'AGENTS.md') | Where-Object { Test-Path -LiteralPath $_ }
                    })
                }
            }
        }
    }
    catch {
        # ignore parse errors
    }
}

$sessions | ConvertTo-Json -Depth 8
