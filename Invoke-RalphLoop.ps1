#requires -Version 7.0
<#
.SYNOPSIS
    Hardened ralph loop: model pin, max-iteration cap, harness-run gate,
    no-progress detection, BLOCKED sentinel, per-iteration transcript logs.
.DESCRIPTION
    Pipes PROMPT.md into `claude -p` once per iteration; the agent takes the first
    unchecked item in specs/TODO.md, implements it, runs `npm run gate`, commits.
    The runner then re-runs the gate itself against the commits the iteration made —
    a green claimed by the agent is not trusted.
    Halts on: BLOCKED sentinel, empty queue, a red gate, no-progress x3, or MaxIter.

    This is the headless, single-agent form of the factory. The maker/checker form
    (separate implementer and reviewer agents) is the `/factory` command.
.NOTES
    Run ONLY inside an isolated worktree — never the main checkout, never `main`:
      git worktree add ..\factory-loop -b loop/auto
      cd ..\factory-loop; npm ci
      pwsh .\Invoke-RalphLoop.ps1
    --dangerously-skip-permissions is acceptable only in that sandbox.
#>
param(
    [int]$MaxIter = 12,
    [int]$NoProgressLimit = 3,
    [string]$Model = 'claude-opus-5-5',
    [string]$PromptFile = 'PROMPT.md',
    [string]$LogDir = '.loop-logs'
)

if ((git branch --show-current) -eq 'main') {
    throw 'Refusing to run on main: main auto-deploys to the public site. Use a worktree branch.'
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$lastHash = ''
$stale = 0

for ($i = 1; $i -le $MaxIter; $i++) {
    # Queue state comes from the one parser (exit 3 = empty, 4 = blocked), checked
    # BEFORE spending a model call on a tick that has nothing to do.
    node scripts/factory/queue.mjs status | Out-Null
    if ($LASTEXITCODE -eq 4) { Write-Host "[$i/$MaxIter] BLOCKED — manual intervention required."; break }
    if ($LASTEXITCODE -eq 3) { Write-Host "[$i/$MaxIter] Queue empty — all items complete."; break }
    if ($LASTEXITCODE -ne 0) { Write-Host "[$i/$MaxIter] specs/TODO.md could not be read — halting."; break }

    $before = git rev-parse HEAD
    $log = Join-Path $LogDir ('iter-{0:d3}.log' -f $i)
    Get-Content $PromptFile -Raw |
        claude -p --model $Model --dangerously-skip-permissions 2>&1 |
        Tee-Object -FilePath $log | Out-Null

    # Harness-run gate over whatever this iteration committed (and left in the tree).
    if ((git rev-parse HEAD) -ne $before) {
        node scripts/factory/gate.mjs --base $before 2>&1 |
            Tee-Object -FilePath (Join-Path $LogDir ('gate-{0:d3}.log' -f $i)) | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[$i/$MaxIter] GATE RED on $(git rev-parse --short HEAD) — halting. See $LogDir."
            break
        }
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
