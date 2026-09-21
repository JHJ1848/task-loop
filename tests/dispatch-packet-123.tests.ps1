$ErrorActionPreference = 'Stop'
$testDir = Join-Path $env:TEMP ("task-loop-test-" + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($testDir) | Out-Null

try {
    $scriptRoot = Join-Path $PSScriptRoot '..\scripts'
    $initScript = Join-Path $scriptRoot 'Initialize-TaskLoopState.ps1'
    $dispatchScript = Join-Path $scriptRoot 'New-TaskLoopDispatchPacket.ps1'

    $runtime = Join-Path $testDir '.agents\task-loop'
    & $initScript -RootPath $runtime

    $todoPath = Join-Path $runtime 'todo.json'
    $sessionsPath = Join-Path $runtime 'sessions.json'

    $targetThread = [guid]::NewGuid().ToString('D')
    $sessions = @{
        schema_version = 1
        main_thread_id = ([guid]::NewGuid().ToString('D'))
        modules = @{
            workflow = @{
                thread_id = $targetThread
                title = "workflow-WorkflowModule"
            }
        }
    } | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($sessionsPath, $sessions, [System.Text.Encoding]::UTF8)

    # Test Complexity 1, 2, 3
    foreach ($c in @(1, 2, 3)) {
        $runId = [guid]::NewGuid().ToString('D')
        $todo = @{
            schema_version = 2
            items = @(
                @{
                    id = "LOOP-00$c"
                    state = "ready"
                    confirmation = "approved"
                    user_description = @(@{ text = "User test prompt $c" })
                    agent_goal = @{
                        complexity = $c
                        module_keys = @("workflow")
                        objective = "Objective $c"
                        allowlist = @("src/*")
                    }
                }
            )
        } | ConvertTo-Json -Depth 8
        [System.IO.File]::WriteAllText($todoPath, $todo, [System.Text.Encoding]::UTF8)

        $out = & $dispatchScript -ProjectRoot $testDir -RunId $runId -TargetThreadId $targetThread
        $result = $out | Out-String | ConvertFrom-Json

        if ($result.action -ne 'PREPARED') {
            throw "Expected PREPARED for complexity $c, got $($result.action)"
        }
        if ($result.complexity -ne $c) {
            throw "Expected complexity $c, got $($result.complexity)"
        }

        $packetPath = Join-Path $testDir $result.packet_path
        $packet = [System.IO.File]::ReadAllText($packetPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

        $expectedPolicy = switch ($c) { 1 { 'none' } 2 { 'optional' } 3 { 'mandatory' } }
        if ($packet.subagent_policy -ne $expectedPolicy) {
            throw "Expected subagent_policy $expectedPolicy, got $($packet.subagent_policy)"
        }

        Write-Host "Complexity Level $c ($expectedPolicy) Dispatch Test PASSED!" -ForegroundColor Green
    }
}
finally {
    if (Test-Path -LiteralPath $testDir) {
        Remove-Item -LiteralPath $testDir -Recurse -Force
    }
}
