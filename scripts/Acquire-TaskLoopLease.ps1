[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LeasePath,
    [Parameter(Mandatory)]
    [string]$TaskId,
    [Parameter(Mandatory)]
    [string]$RunId,
    [Parameter(Mandatory = $false)]
    [int]$LeaseMinutes = 25
)

$ErrorActionPreference = 'Stop'

function Write-Outcome {
    param(
        [ValidateSet('LEASED', 'NOOP', 'INVALID')]
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

try {
    $now = [DateTimeOffset]::UtcNow
    $expiresAt = $now.AddMinutes($LeaseMinutes).ToString('o')

    if (Test-Path -LiteralPath $LeasePath -PathType Leaf) {
        $existing = [System.IO.File]::ReadAllText($LeasePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($null -ne $existing -and $existing.run_id -eq $RunId) {
            Write-Outcome 'LEASED' 'lease_already_held' @{ run_id = $RunId; task_id = $TaskId }
            exit 0
        }
        if ($null -ne $existing -and [DateTimeOffset]::Parse($existing.expires_at) -gt $now) {
            Write-Outcome 'NOOP' 'lease_active_by_other' @{ active_run_id = $existing.run_id; expires_at = $existing.expires_at }
            exit 0
        }
    }

    $leaseData = [pscustomobject][ordered]@{
        task_id = $TaskId
        run_id = $RunId
        acquired_at = $now.ToString('o')
        expires_at = $expiresAt
    }

    $leaseDir = [System.IO.Path]::GetDirectoryName($LeasePath)
    if (-not [string]::IsNullOrWhiteSpace($leaseDir) -and -not (Test-Path -LiteralPath $leaseDir -PathType Container)) {
        [System.IO.Directory]::CreateDirectory($leaseDir) | Out-Null
    }

    $jsonStr = $leaseData | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($LeasePath, $jsonStr, [System.Text.Encoding]::UTF8)

    Write-Outcome 'LEASED' 'lease_acquired' @{ run_id = $RunId; expires_at = $expiresAt }
    exit 0
}
catch {
    Write-Outcome 'INVALID' 'lease_error' @{ message = $_.Exception.Message }
    exit 2
}
