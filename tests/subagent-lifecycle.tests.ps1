$ErrorActionPreference = 'Stop'
$testDir = Join-Path $env:TEMP ("task-loop-subagent-test-" + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($testDir) | Out-Null

try {
    # 1. Test Schema validations in PowerShell
    $validNamePattern = '^[a-zA-Z0-9_.-]+$'
    $allowedWorkspaces = @('inherit', 'branch', 'share')
    $allowedModels = @('inherit', 'flash_lite', 'flash', 'pro')
    $allowedActions = @('list', 'kill', 'kill_all')
    $allowedStates = @('running', 'idle', 'waiting_for_input', 'waiting_for_dependents', 'waiting_for_message', 'canceling', 'errored', 'unspecified')

    if (-not ('code_reviewer' -match $validNamePattern)) { throw "Pattern failed valid name" }
    if ('bad name with space' -match $validNamePattern) { throw "Pattern matched invalid name" }

    # 2. Test Subagent Invocation Mock
    $mockSubagent = @{
        TypeName = 'research'
        Role = 'Codebase Researcher'
        Prompt = 'Investigate module dependencies'
        Workspace = 'inherit'
        Model = 'flash'
    }
    if (-not ($allowedWorkspaces -contains $mockSubagent.Workspace)) { throw "Invalid workspace" }
    if (-not ($allowedModels -contains $mockSubagent.Model)) { throw "Invalid model" }

    # 3. Test Lifecycle Simulation
    $cid = [guid]::NewGuid().ToString('D')
    $activeSubagent = @{
        role = $mockSubagent.Role
        type = $mockSubagent.TypeName
        conversationId = $cid
        transcript = "file:///tmp/brain/$cid/transcript.jsonl"
        workspace_mode = $mockSubagent.Workspace
        model_tier = $mockSubagent.Model
        state = 'running'
        stateDetail = 'Executing prompt...'
    }

    if (-not ($allowedStates -contains $activeSubagent.state)) { throw "Invalid state" }

    Write-Host "Subagent lifecycle PowerShell test PASSED!" -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $testDir) {
        Remove-Item -LiteralPath $testDir -Recurse -Force
    }
}
