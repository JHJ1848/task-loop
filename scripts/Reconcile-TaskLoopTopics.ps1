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
        [ValidateSet('NOOP', 'RECONCILED', 'INVALID')]
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
        throw "$Name file does not exist: $Path"
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
        $registry | Add-Member -NotePropertyName 'modules' -NotePropertyValue ([pscustomobject]@{}) -Force
    }

    $provisioned = @()
    $modified = $false

    foreach ($topic in @($manifest.topics)) {
        if ($null -eq $topic) { continue }
        if ($topic.PSObject.Properties['enabled'] -and $topic.enabled -eq $false) {
            continue
        }

        $moduleKey = [string]$topic.module_key
        $registered = $registry.modules.PSObject.Properties[$moduleKey]

        if ($null -eq $registered -or [string]::IsNullOrWhiteSpace($registered.Value.thread_id)) {
            # Auto-provision new session thread ID
            $newThreadId = [guid]::NewGuid().ToString('D')
            $moduleData = [pscustomobject][ordered]@{
                thread_id = $newThreadId
                title = [string]$topic.title
                title_prefix = [string]$topic.title_prefix
                memory_docs = @($topic.memory_docs)
                auto_provisioned = $true
                provisioned_at = [DateTimeOffset]::UtcNow.ToString('o')
            }

            if ($null -eq $registered) {
                $registry.modules | Add-Member -NotePropertyName $moduleKey -NotePropertyValue $moduleData -Force
            }
            else {
                $registry.modules.$moduleKey = $moduleData
            }

            $provisioned += [pscustomobject]@{
                module_key = $moduleKey
                thread_id = $newThreadId
                title = [string]$topic.title
            }
            $modified = $true
        }
    }

    if ($modified) {
        $jsonStr = $registry | ConvertTo-Json -Depth 12
        [System.IO.File]::WriteAllText($RegistryPath, $jsonStr, [System.Text.Encoding]::UTF8)
        Write-Outcome 'RECONCILED' 'topics_provisioned' @{ provisioned = $provisioned }
        exit 0
    }
    else {
        Write-Outcome 'NOOP' 'all_topics_registered'
        exit 0
    }
}
catch {
    Write-Outcome 'INVALID' 'reconcile_error' @{ message = $_.Exception.Message }
    exit 2
}
