[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ProjectRoot,
    [Parameter(Mandatory)]
    [string]$ManifestPath,
    [Parameter(Mandatory)]
    [string]$RegistryPath
)

$ErrorActionPreference = 'Stop'

function Write-Outcome {
    param(
        [ValidateSet('NOOP', 'RECONCILE', 'INVALID')]
        [string]$Action,
        [string]$Reason,
        [hashtable]$Details = @{}
    )
    $result = [ordered]@{ action = $Action; reason = $Reason }
    foreach ($key in $Details.Keys) {
        $result[$key] = $Details[$key]
    }
    [pscustomobject]$result | ConvertTo-Json -Compress -Depth 12
}

function Read-JsonFile {
    param([string]$Path, [string]$Name)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Name file does not exist."
    }
    $content = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($content)) {
        throw "$Name file is empty."
    }
    return $content | ConvertFrom-Json
}

try {
    $root = [System.IO.Path]::GetFullPath($ProjectRoot)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw 'ProjectRoot directory does not exist.'
    }
    $manifest = Read-JsonFile $ManifestPath 'manifest'
    $registry = Read-JsonFile $RegistryPath 'registry'

    if ($manifest.schema_version -ne 1 -or $registry.schema_version -ne 1) {
        throw 'Unsupported schema_version.'
    }
    if ($null -eq $manifest.topics) {
        throw 'manifest.topics is required.'
    }
    if ($null -eq $registry.modules) {
        throw 'registry.modules is required.'
    }

    $unregisteredTopics = @()
    foreach ($topic in @($manifest.topics)) {
        if ($null -eq $topic) { continue }
        if ($topic.PSObject.Properties['enabled'] -and $topic.enabled -eq $false) {
            continue
        }
        $moduleKey = [string]$topic.module_key
        $registered = $registry.modules.PSObject.Properties[$moduleKey]
        if ($null -eq $registered -or [string]::IsNullOrWhiteSpace($registered.Value.thread_id)) {
            $unregisteredTopics += $topic
        }
    }

    if ($unregisteredTopics.Count -gt 0) {
        Write-Outcome 'RECONCILE' 'topics_unregistered' @{ unregistered_topics = $unregisteredTopics }
        exit 0
    }

    Write-Outcome 'NOOP' 'registry_matched'
    exit 0
}
catch {
    Write-Outcome 'INVALID' 'registry_invalid' @{ message = $_.Exception.Message }
    exit 2
}
