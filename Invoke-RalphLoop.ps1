#requires -Version 7.0
<#
.SYNOPSIS
    Hardened ralph loop: max-iteration cap, no-progress detection,
    BLOCKED sentinel, per-iteration transcript logs.
.DESCRIPTION
    Pipes PROMPT.md into `claude -p` once per iteration; the agent takes the first
    unchecked item in specs/TODO.md, implements it, runs `npm run verify`, commits.
    Halts on: BLOCKED sentinel, empty queue, no-progress x3, or MaxIter.
.NOTES
    Run ONLY inside an isolated worktree — never the main checkout:
      git worktree add ..\factory-loop -b loop/auto
      cd ..\factory-loop; npm ci
      pwsh ..\Factory\Invoke-RalphLoop.ps1
    --dangerously-skip-permissions is acceptable only in that sandbox.
#>
param(
    [int]$MaxIter = 12,
    [int]$NoProgressLimit = 3,
    [string]$PromptFile = 'PROMPT.md',
    [string]$StateFile = 'specs/TODO.md',
    [string]$LogDir = '.loop-logs'
)

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$lastHash = ''
$stale = 0

for ($i = 1; $i -le $MaxIter; $i++) {
    $log = Join-Path $LogDir ('iter-{0:d3}.log' -f $i)
    Get-Content $PromptFile -Raw |
        claude -p --dangerously-skip-permissions 2>&1 |
        Tee-Object -FilePath $log | Out-Null

    # Line-anchored sentinels: the loop contract embedded in the state file mentions
    # both tokens mid-line; only real queue items / blocks start a line with them.
    if (Select-String -Path $StateFile -Pattern '^BLOCKED:' -Quiet) {
        Write-Host "[$i/$MaxIter] BLOCKED — manual intervention required."
        break
    }
    if (-not (Select-String -Path $StateFile -Pattern '^- \[ \]' -Quiet)) {
        Write-Host "[$i/$MaxIter] Queue empty — all items complete."
        break
    }

    # No-progress: HEAD + dirty-tree fingerprint unchanged N consecutive ticks
    $tree = (git rev-parse HEAD) + (git status --porcelain | Out-String)
    $hash = (Get-FileHash -InputStream (
        [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($tree))
    ) -Algorithm SHA256).Hash
    if ($hash -eq $lastHash) { $stale++ } else { $stale = 0; $lastHash = $hash }
    if ($stale -ge $NoProgressLimit) {
        Write-Host "[$i/$MaxIter] No progress x$NoProgressLimit — halting. Tune PROMPT.md."
        break
    }
    Start-Sleep -Seconds 10
}
