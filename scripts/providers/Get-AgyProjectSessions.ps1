[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = '.',
    [Parameter(Mandatory = $false)]
    [string]$AgyBrainPath = (Join-Path $env:USERPROFILE '.gemini\antigravity\brain')
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/').Replace('\', '/').ToLowerInvariant()
}

$targetRoot = Get-NormalizedPath $ProjectRoot
if (-not (Test-Path -LiteralPath $AgyBrainPath -PathType Container)) {
    @() | ConvertTo-Json -Depth 8
    exit 0
}

$sessions = [System.Collections.Generic.List[PSObject]]::new()
$brainDirs = Get-ChildItem -LiteralPath $AgyBrainPath -Directory -ErrorAction SilentlyContinue

foreach ($dir in $brainDirs) {
    $convId = $dir.Name
    # Check if folder name looks like a UUID
    $isGuid = [guid]::TryParse($convId, [ref][guid]::Empty)
    if (-not $isGuid) { continue }

    $logFile = Join-Path $dir.FullName '.system_generated\logs\transcript.jsonl'
    if (-not (Test-Path -LiteralPath $logFile -PathType Leaf)) {
        $logFile = Join-Path $dir.FullName '.system_generated\logs\transcript_full.jsonl'
        if (-not (Test-Path -LiteralPath $logFile -PathType Leaf)) { continue }
    }

    $fileInfo = Get-Item -LiteralPath $logFile
    $lastModified = $fileInfo.LastWriteTimeUtc.ToString('o')
    $created = $fileInfo.CreationTimeUtc.ToString('o')

    # Read the first few lines of transcript to extract project workspace and initial prompt
    $isMatch = $false
    $title = "Session $convId"
    $detectedRoot = ""

    try {
        $reader = [System.IO.File]::OpenText($logFile)
        $lineCount = 0
        try {
            while ($null -ne ($line = $reader.ReadLine()) -and $lineCount -lt 25) {
                $lineCount++
                if ($line -match '"workspaceUris"\s*:\s*\[([^\]]+)\]') {
                    $matchedUris = $Matches[1]
                    if ($matchedUris.ToLowerInvariant().Contains($targetRoot.Replace(':', '%3a')) -or $matchedUris.ToLowerInvariant().Contains($targetRoot)) {
                        $isMatch = $true
                        $detectedRoot = $targetRoot
                    }
                }
                if (-not $isMatch -and $line.ToLowerInvariant().Contains($targetRoot)) {
                    $isMatch = $true
                    $detectedRoot = $targetRoot
                }
                if ($line -match '"type"\s*:\s*"USER_INPUT"' -and $line -match '"content"\s*:\s*"([^"]+)"') {
                    $rawContent = $Matches[1]
                    $cleanContent = $rawContent -replace '\\n', ' ' -replace '<[^>]+>', ''
                    $cleanContent = $cleanContent.Trim()
                    if ($cleanContent.Length -gt 60) {
                        $cleanContent = $cleanContent.Substring(0, 57) + '...'
                    }
                    if (-not [string]::IsNullOrWhiteSpace($cleanContent)) {
                        $title = $cleanContent
                    }
                }
            }
        }
        finally {
            $reader.Dispose()
        }
    }
    catch {
        # If read fails, continue
    }

    if ($isMatch) {
        $sessionObj = [PSCustomObject]@{
            vendor = "antigravity"
            session_id = $convId
            title = $title
            project_root = $targetRoot
            is_active = $true
            created_at = $created
            last_active_at = $lastModified
            log_path = $logFile.Replace('\', '/')
            rule_files = @(
                Join-Path $ProjectRoot 'AGENTS.md'
            ) | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { [System.IO.Path]::GetFullPath($_).Replace('\', '/') }
        }
        $sessions.Add($sessionObj)
    }
}

$sessions | Sort-Object -Property last_active_at -Descending | ConvertTo-Json -Depth 8
