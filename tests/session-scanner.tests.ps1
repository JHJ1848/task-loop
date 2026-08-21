$ErrorActionPreference = 'Stop'
$testDir = Join-Path $env:TEMP ("task-loop-test-" + [guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($testDir) | Out-Null

try {
    $scriptRoot = Join-Path $PSScriptRoot '..\scripts'
    $scannerScript = Join-Path $scriptRoot 'Find-ProjectSessions.ps1'

    # Test Auto scanning
    $out = & $scannerScript -ProjectRoot $testDir -Vendor Auto
    $result = $out | Out-String | ConvertFrom-Json

    if ($null -eq $result) {
        Write-Host "Scanner test passed (empty/handled gracefully)." -ForegroundColor Green
    } else {
        Write-Host "Scanner test returned results count: $($result.Count)" -ForegroundColor Green
    }
}
finally {
    if (Test-Path -LiteralPath $testDir) {
        Remove-Item -LiteralPath $testDir -Recurse -Force
    }
}
