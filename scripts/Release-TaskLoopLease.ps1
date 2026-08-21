[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LeasePath,
    [Parameter(Mandatory)]
    [string]$RunId
)

$ErrorActionPreference = 'Stop'

function Write-Outcome {
    param(
        [ValidateSet('RELEASED', 'NOOP', 'INVALID')]
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
    if (-not (Test-Path -LiteralPath $LeasePath -PathType Leaf)) {
        Write-Outcome 'RELEASED' 'lease_file_not_found'
        exit 0
    }

    $existing = [System.IO.File]::ReadAllText($LeasePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($null -ne $existing -and $existing.run_id -eq $RunId) {
        [System.IO.File]::Delete($LeasePath)
        Write-Outcome 'RELEASED' 'lease_released' @{ run_id = $RunId }
        exit 0
    }

    Write-Outcome 'NOOP' 'run_id_mismatch' @{ held_by = $existing.run_id }
    exit 0
}
catch {
    Write-Outcome 'INVALID' 'release_error' @{ message = $_.Exception.Message }
    exit 2
}
