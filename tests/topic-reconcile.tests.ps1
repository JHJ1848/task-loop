$ErrorActionPreference = 'Stop'
$testDir = Join-Path $env:TEMP ("task-loop-test-" + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($testDir) | Out-Null

try {
    $scriptRoot = Join-Path $PSScriptRoot '..\scripts'
    $reconcileScript = Join-Path $scriptRoot 'Reconcile-TaskLoopTopics.ps1'
    $testRegistryScript = Join-Path $scriptRoot 'Test-TaskLoopTopicRegistry.ps1'

    $manifestPath = Join-Path $testDir 'topics.json'
    $registryPath = Join-Path $testDir 'sessions.json'

    $manifest = @{
        schema_version = 1
        topics = @(
            @{
                module_key = 'auth'
                title = 'auth-AuthModule'
                title_prefix = 'auth-'
                memory_docs = @('docs/memory/auth.md')
                enabled = $true
            }
        )
    } | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.Encoding]::UTF8)

    $registry = @{
        schema_version = 1
        main_thread_id = ([guid]::NewGuid().ToString('D'))
        modules = @{}
    } | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($registryPath, $registry, [System.Text.Encoding]::UTF8)

    # 1. Test before reconcile -> should output RECONCILE
    $preOut = & $testRegistryScript -ProjectRoot $testDir -ManifestPath $manifestPath -RegistryPath $registryPath
    $preResult = $preOut | Out-String | ConvertFrom-Json
    if ($preResult.action -ne 'RECONCILE') {
        throw "Expected RECONCILE before auto-provision, got $($preResult.action)"
    }

    # 2. Run Reconcile
    $recOut = & $reconcileScript -ProjectRoot $testDir -ManifestPath $manifestPath -RegistryPath $registryPath
    $recResult = $recOut | Out-String | ConvertFrom-Json
    if ($recResult.action -ne 'RECONCILED') {
        throw "Expected RECONCILED from Reconcile script, got $($recResult.action)"
    }

    # 3. Test after reconcile -> should output NOOP
    $postOut = & $testRegistryScript -ProjectRoot $testDir -ManifestPath $manifestPath -RegistryPath $registryPath
    $postResult = $postOut | Out-String | ConvertFrom-Json
    if ($postResult.action -ne 'NOOP') {
        throw "Expected NOOP after auto-provision, got $($postResult.action)"
    }

    Write-Host "Topic reconcile test PASSED!" -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $testDir) {
        Remove-Item -LiteralPath $testDir -Recurse -Force
    }
}
