<#
.SYNOPSIS
    Windows counterpart of setup.sh: brings a Windows machine from "cloned the
    emulator" to "can run the test kit", and says what it could not do.

.DESCRIPTION
    Same layout as setup.sh: the components are checkouts BESIDE this repo, and
    okpqc-venv is generated beside them. A component that is already there is
    used exactly as it is - nothing here fetches, pulls or re-clones into a
    checkout you already have.

    Steps, in order (each one skips itself when its result is already there):

      1. prerequisites   git, Node >= 22.12, npm, Python >= 3.10, Visual
                         Studio's "C++ Clang tools", pm2 (installed if missing)
      2. components      the list is READ FROM setup.sh, so there is one list
      3. okpqc-venv      pip installs, then age/age-keygen (windows zip)
      4. emulator addon  npm install --ignore-scripts, npm run rebuild
      5. node installs   ui, onlykey-testing, OnlyKey-App, apps.onlykey.io
      6. kit NW SDK      nw@0.114.0-sdk in onlykey-testing - LAST, see below
      7. okvhid driver   fetch-wdk + build-direct run here (no admin needed);
                         sign + install are PRINTED for you to run elevated
      8. summary         read back from the system, never asserted

    Why PowerShell and not Git Bash: every Windows-specific step is a Windows
    API question - PnP devices, the certificate store, named pipes, vswhere,
    zip extraction, admin-token checks - and the driver scripts it drives are
    PowerShell already. Windows PowerShell 5.1 ships with every Windows 10/11,
    so a fresh machine can run this before it has anything else. From Git Bash:

        powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./setup-windows.ps1 -Check

    (-ExecutionPolicy Bypass because a stock machine's LocalMachine policy is
    Restricted, which refuses every .ps1.)

    This script never elevates itself and never runs an elevated step. The
    driver's sign and install need an admin token; it prints them. It also
    never starts, stops or restarts pm2 - it reports the emulator's pm2 state
    and prints the command, as setup.sh does.

.PARAMETER Clone
    Clone the missing component repos beside this one (setup.sh --clone).
    Without it, missing components are named and setup stops.

.PARAMETER NoDriver
    Skip the okvhid driver step (setup.sh --no-privileged). Everything else
    still runs; the emulator builds but has no device to present on.

.PARAMETER Check
    Dry run. Report what is present and what would be done, and change
    NOTHING: no clone, no install, no download, no build. It does not open the
    okvhid pipes either (it lists their names) and does not run `okt caps`,
    which does. Exits 0 when nothing is outstanding, 1 otherwise.

.EXAMPLE
    .\setup-windows.ps1 -Check
.EXAMPLE
    .\setup-windows.ps1 -Clone
#>
[CmdletBinding()]
param(
    [switch] $Clone,
    [switch] $NoDriver,
    [switch] $Check,
    [switch] $Help
)

if ($Help) { Get-Help $PSCommandPath -Detailed; return }

# Continue, not Stop: under Stop, Windows PowerShell 5.1 turns any stderr line
# of a native command (git's progress, npm's warnings) into a terminating
# error when it is redirected. Every native call here checks $LASTEXITCODE.
$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'   # Invoke-WebRequest is 10x slower drawing a bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ROOT      = $PSScriptRoot
$CHECKOUTS = (Resolve-Path (Join-Path $ROOT '..')).Path
$VENV      = Join-Path $CHECKOUTS 'okpqc-venv'
$DRIVER    = Join-Path $ROOT 'windows-driver'
$SETUP_SH  = Join-Path $ROOT 'setup.sh'

$script:Outstanding = New-Object System.Collections.Generic.List[string]

function Say($m)   { Write-Host "== $m" }
function Warn($m)  { Write-Host "!! $m" -ForegroundColor Yellow }
function Note($m)  { Write-Host "   $m" }
function Would($m) { Write-Host "-> would: $m" -ForegroundColor Cyan; $script:Outstanding.Add($m) }
function Todo($m)  { $script:Outstanding.Add($m) }

# Runs a native command in a directory and reports failure without stopping:
# like setup.sh's non-fatal components, one thing that will not install is
# named and the rest carries on.
function Run([string] $Dir, [string] $Exe, [string[]] $Arguments) {
    Push-Location $Dir
    try { & $Exe @Arguments | Out-Host; $code = $LASTEXITCODE } finally { Pop-Location }
    if ($code -ne 0) { Warn "$Exe $($Arguments -join ' ') failed (exit $code) in $Dir"; Todo "retry in ${Dir}: $Exe $($Arguments -join ' ')" }
    return ($code -eq 0)
}

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    # npm and pip would then write admin-owned files into the checkouts, which
    # the unelevated shell you normally work from cannot update later.
    Warn 'running elevated. Run this script from a normal shell; only the driver'
    Warn 'steps it prints need elevation.'
}
if ($Check) { Say 'CHECK ONLY - nothing will be changed' }

# ---------------------------------------------------------- setup.sh's facts
#
# The component list and the age version are read out of setup.sh rather than
# copied, so the two platforms cannot drift apart.
if (-not (Test-Path $SETUP_SH)) { throw "setup.sh not found beside this script ($SETUP_SH)" }
$COMPONENTS = @(Select-String -Path $SETUP_SH -Pattern '^\s*"(\S+)\s+(https://\S+)"\s*$' |
    ForEach-Object { [pscustomobject]@{ Dir = $_.Matches[0].Groups[1].Value; Url = $_.Matches[0].Groups[2].Value } })
$AGE_VERSION = (Select-String -Path $SETUP_SH -Pattern '^AGE_VERSION="([^"]+)"' |
    Select-Object -First 1).Matches[0].Groups[1].Value
if ($COMPONENTS.Count -lt 5 -or -not $AGE_VERSION) {
    throw "could not read COMPONENTS / AGE_VERSION from setup.sh - its format changed; update the patterns here"
}

# ------------------------------------------------------------ prerequisites
#
# All checked up front, like setup.sh: failing on the first missing tool beats
# discovering it after a venv build.
Say "components live in $CHECKOUTS"
$missing = @()

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $missing += 'git            - https://git-scm.com/download/win' }

$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVer = (& node -p 'process.versions.node' 2>$null)
    if ($nodeVer -and ([version]$nodeVer -ge [version]'22.12.0')) { $nodeOk = $true; Note "node $nodeVer" }
    else { $missing += "Node >= 22.12  - found $nodeVer; install the current LTS from https://nodejs.org (or nvm-windows)" }
} else { $missing += 'Node >= 22.12  - https://nodejs.org (or nvm-windows)' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $missing += 'npm            - ships with Node' }

# `py -3` first: a bare `python` on a fresh Windows is often the Microsoft
# Store alias, which prints nothing and exits 9009 instead of running.
$PY = $null
foreach ($cand in @(@('py', '-3'), @('python'))) {
    if (-not (Get-Command $cand[0] -ErrorAction SilentlyContinue)) { continue }
    $pyArgs = @($cand | Select-Object -Skip 1) + @('-c', 'import sys; print(*sys.version_info[:2], sep=chr(46))')
    $v = (& $cand[0] @pyArgs 2>$null)
    if ($LASTEXITCODE -eq 0 -and $v -match '^\d+\.\d+$') {
        if ([version]$v -ge [version]'3.10') { $PY = $cand; Note "python $v ($($cand -join ' '))"; break }
        $missing += "Python >= 3.10 - found $v at $($cand[0]); install 3.10+ from https://www.python.org"
        break
    }
}
if (-not $PY -and -not ($missing -match '^Python')) {
    $missing += 'Python >= 3.10 - https://www.python.org (a bare "python" that opens the Store is the App Execution Alias, not Python)'
}

# The emulator's binding.gyp builds with msbuild_toolset ClangCL, and the
# driver with clang-cl: the firmware uses GCC __attribute__ syntax MSVC cannot
# parse. Both need the same Visual Studio component.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vsClang = $null
if (Test-Path $vswhere) {
    $vsClang = & $vswhere -latest -products * -requires `
        Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        Microsoft.VisualStudio.Component.VC.Llvm.Clang `
        Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset -property displayName | Select-Object -First 1
}
if ($vsClang) { Note "$vsClang with C++ Clang tools" }
else { $missing += 'Visual Studio C++ Clang tools - Visual Studio Installer > Modify > "Desktop development with C++" > tick "C++ Clang tools for Windows"' }

if ($missing.Count) {
    Warn 'missing prerequisites:'
    foreach ($m in $missing) { Note "  $m" }
    if (-not $Check) { exit 1 }
    foreach ($m in $missing) { Todo "install $m" }
}

# pm2 supervises the emulator; nothing else here supplies it (setup.sh installs
# it the same way).
if (Get-Command pm2 -ErrorAction SilentlyContinue) { Note 'pm2 present' }
elseif ($Check) { Would 'npm install -g pm2' }
else {
    Say 'pm2 not found - installing it'
    & npm install -g pm2
    if ($LASTEXITCODE -ne 0) { Warn 'could not install pm2 - run: npm install -g pm2'; Todo 'npm install -g pm2' }
}

# ------------------------------------------------------ component checkouts
$absent = @(); $occupied = @()
foreach ($c in $COMPONENTS) {
    $p = Join-Path $CHECKOUTS $c.Dir
    if (Test-Path (Join-Path $p '.git')) { Note "$($c.Dir) present, using it as-is" }
    elseif (Test-Path $p) { $occupied += $p }
    else { $absent += $c }
}
if ($occupied.Count) {
    Warn 'these exist beside this repo but are not git checkouts - move or remove them, then re-run:'
    foreach ($p in $occupied) { Note "  $p" }
    if (-not $Check) { exit 1 }
    Todo 'clear the non-checkout directories named above'
}
if ($absent.Count -and -not $Clone) {
    Warn "missing component checkouts, expected in ${CHECKOUTS}:"
    foreach ($c in $absent) { Note "  $($c.Dir)  ($($c.Url))" }
    Note 'Put your own checkouts there under those names, or re-run with -Clone.'
    if (-not $Check) { exit 1 }
    foreach ($c in $absent) { Todo "clone $($c.Dir) (re-run with -Clone)" }
    $absent = @()
}
foreach ($c in $absent) {
    $p = Join-Path $CHECKOUTS $c.Dir
    if ($Check) { Would "git clone $($c.Url) $p"; continue }
    Say "cloning $($c.Dir)"
    & git clone $c.Url $p
    if ($LASTEXITCODE -ne 0) { Warn "clone of $($c.Dir) failed"; Todo "git clone $($c.Url) $p"; continue }
    # Only for what was just cloned - see setup.sh for why each of these exists.
    if ($c.Dir -eq 'python-onlykey') { & git -C $p submodule update --init onlykey-solo-python }
    if ($c.Dir -in 'libraries', 'OnlyKey-Firmware') {
        & git -C $p remote add trustcrypto "https://github.com/trustcrypto/$($c.Dir)" 2>$null
        & git -C $p fetch -q --tags trustcrypto
        if ($LASTEXITCODE -ne 0) { Warn "could not fetch trustcrypto tags into $($c.Dir) - older releases may not stage" }
    }
}
function Has($dir) { Test-Path (Join-Path (Join-Path $CHECKOUTS $dir) '.git') }

# --------------------------------------------------------------- okpqc-venv
#
# onlykey-testing resolves <checkouts>\okpqc-venv\Scripts (lib/cli.js VENV_BIN),
# so everything has to land exactly there.
Say 'okpqc-venv'
$vpy = Join-Path $VENV 'Scripts\python.exe'
$venvExes = 'onlykey-cli', 'age-plugin-onlykey', 'onlykey-agent', 'onlykey-gpg'
$venvMissing = @($venvExes | Where-Object { -not (Test-Path (Join-Path $VENV "Scripts\$_.exe")) })
$canVenv = (Has 'python-onlykey') -and (Has 'lib-agent')

# Test for pip, not the directory (setup.sh has the story): a venv that failed
# partway leaves the folder and no pip, and a folder test skips it forever.
if (-not (Test-Path (Join-Path $VENV 'Scripts\pip.exe'))) {
    if ($Check) { Would "create $VENV (python -m venv)" ; $venvMissing = $venvExes }
    elseif (-not $PY) { Todo 'okpqc-venv: needs Python >= 3.10' }
    else {
        if (Test-Path $VENV) { Remove-Item -Recurse -Force $VENV }
        $pyArgs = @($PY | Select-Object -Skip 1) + @('-m', 'venv', $VENV)
        & $PY[0] @pyArgs
        $venvMissing = $venvExes
    }
}
if ($venvMissing.Count -eq 0) { Note "present: $($venvExes -join ', ')" }
elseif (-not $canVenv) { Warn 'python-onlykey or lib-agent is missing - okpqc-venv cannot be filled'; Todo 'okpqc-venv: needs python-onlykey and lib-agent' }
elseif ($Check) { Would "pip install -e python-onlykey[age] -e lib-agent -e lib-agent\agents\onlykey (missing: $($venvMissing -join ', '))" }
elseif (Test-Path $vpy) {
    Say "installing into okpqc-venv (missing: $($venvMissing -join ', '))"
    # python -m pip, not pip.exe: pip.exe cannot replace itself while running.
    & $vpy -m pip install --upgrade pip
    #   onlykey        -> onlykey-cli, age-plugin-onlykey
    #   lib-agent      -> the agent framework
    #   onlykey-agent  -> onlykey-agent, onlykey-gpg
    & $vpy -m pip install -e "$CHECKOUTS\python-onlykey[age]"
    $pipOk = ($LASTEXITCODE -eq 0)
    & $vpy -m pip install -e "$CHECKOUTS\lib-agent" -e "$CHECKOUTS\lib-agent\agents\onlykey"
    if (-not $pipOk -or $LASTEXITCODE -ne 0) { Warn 'pip install failed - see above'; Todo 'okpqc-venv pip installs' }
}

# age and age-keygen are upstream Go binaries pip cannot supply; test/05 and
# test/11 shell out to them from the same Scripts\ the kit searches.
$ageOk = (Test-Path (Join-Path $VENV 'Scripts\age.exe')) -and (Test-Path (Join-Path $VENV 'Scripts\age-keygen.exe'))
$ageArch = @{ AMD64 = 'amd64'; ARM64 = 'arm64' }[$env:PROCESSOR_ARCHITECTURE]
$ageUrl = "https://github.com/FiloSottile/age/releases/download/$AGE_VERSION/age-$AGE_VERSION-windows-$ageArch.zip"
if ($ageOk) { Note "present: age, age-keygen" }
elseif ($Check) { Would "fetch age $AGE_VERSION ($ageUrl) into $VENV\Scripts" }
elseif (-not (Test-Path (Join-Path $VENV 'Scripts'))) { Todo 'age: okpqc-venv does not exist yet' }
else {
    Say "fetching age $AGE_VERSION ($ageArch)"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("age-" + [guid]::NewGuid())
    try {
        New-Item -ItemType Directory $tmp | Out-Null
        Invoke-WebRequest -UseBasicParsing -Uri $ageUrl -OutFile "$tmp\age.zip"
        Expand-Archive "$tmp\age.zip" -DestinationPath $tmp
        Copy-Item "$tmp\age\age.exe", "$tmp\age\age-keygen.exe" (Join-Path $VENV 'Scripts')
    } catch {
        Warn "age download failed: $($_.Exception.Message)"
        Todo "put age.exe and age-keygen.exe ($ageUrl) into $VENV\Scripts"
    } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

# ------------------------------------------------------------ node installs
#
# JSON goes through node rather than ConvertFrom-Json: Windows PowerShell 5.1
# refuses any document with keys differing only in case, and pm2 jlist carries
# each process's environment, where PATH and Path both appear. $Expr sees the
# parsed document as j; $Fallback is returned when it will not parse.
function Read-Json([string] $Json, [string] $Expr, [string] $Fallback) {
    $js = "let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => { let r; try { const j = JSON.parse(s); r = $Expr; } catch (e) { r = process.argv[1]; } console.log(r); });"
    $r = ($Json | & node -e $js $Fallback 2>$null) -join ''
    if ($LASTEXITCODE -ne 0) { return $Fallback }
    return $r
}

# A tree needs installing when node_modules is missing, or when `npm ls` finds
# a dependency MISSING or INVALID against package.json - a content test, where
# mtimes would fire on every git checkout. EXTRANEOUS is ignored on purpose:
# the kit's NW SDK is installed --no-save, so it is extraneous by design.
function Get-NpmStale([string] $Dir) {
    if (-not (Test-Path (Join-Path $Dir 'node_modules'))) { return 'no node_modules' }
    Push-Location $Dir
    try { $json = (& npm ls --depth=0 --json 2>$null) -join "`n" } finally { Pop-Location }
    # Parsed by node, not ConvertFrom-Json: see Read-Json.
    return (Read-Json $json "(j.problems || []).filter((p) => !/^extraneous/.test(p)).map((p) => p.split(' ').slice(0, 2).join(' ')).join('; ')" 'npm ls output unreadable')
}

# Is pm2 running the emulator? Asked WITHOUT letting pm2 spawn a daemon: any
# pm2 command starts one when none is running, so pm2 is only asked when its
# pid file names a live process. Returns online / stopped / errored / ...
function Get-Pm2Emulator {
    $pm2Home = if ($env:PM2_HOME) { $env:PM2_HOME } else { Join-Path $env:USERPROFILE '.pm2' }
    $pidFile = Join-Path $pm2Home 'pm2.pid'
    if (-not (Test-Path $pidFile)) { return 'pm2 daemon not running' }
    $daemonPid = (Get-Content $pidFile -Raw).Trim()
    if (-not ($daemonPid -match '^\d+$') -or -not (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue)) { return 'pm2 daemon not running' }
    $out = (& pm2 jlist 2>$null) -join "`n"
    $i = $out.IndexOf('[')
    if ($i -lt 0) { return 'unknown' }
    return (Read-Json $out.Substring($i) "((a) => a ? a.pm2_env.status : 'not registered')(j.find((x) => x.name === 'onlykey-emulator'))" 'unknown')
}
$pm2State = if (Get-Command pm2 -ErrorAction SilentlyContinue) { Get-Pm2Emulator } else { 'pm2 not installed' }

# --- the emulator addon ---------------------------------------------------
Say 'emulator addon'
$emu = Join-Path $ROOT 'emulator'
$addon = Join-Path $emu 'build\Release\onlykey_emulator.node'
$stale = Get-NpmStale $emu
$depsChanged = $false
if (-not $stale) { Note 'emulator node_modules current' }
elseif ($Check) { Would "npm install --ignore-scripts --no-save in emulator ($stale)" }
else {
    # --ignore-scripts: gypfile:true makes npm run node-gyp as an implicit
    # install script, and binding.gyp includes sources.gypi, which only
    # `npm run stage` generates - so the implicit build fails on a fresh
    # checkout. rebuild below does stage -> configure -> build.
    Say "npm install in emulator ($stale)"
    $depsChanged = Run $emu 'npm' @('install', '--ignore-scripts', '--no-save')
}

# Pinned release commits: CHECKED, never fetched into an existing checkout
# (setup.sh has the reasoning). Read-only.
if (Test-Path (Join-Path $emu 'node_modules\node-onlykey-lib')) {
    foreach ($repo in 'libraries', 'OnlyKey-Firmware') {
        if (-not (Has $repo)) { continue }
        Push-Location $emu
        $shas = (& node -e "const v = require('node-onlykey-lib/versions'); const w = new Set(v.list().map((r) => (v.pinsFor(r) || {})[process.argv[1]]).filter(Boolean)); console.log([...w].join(' '));" $repo 2>$null)
        Pop-Location
        $lack = @(("$shas" -split ' ') | Where-Object { $_ } | Where-Object {
            & git -C (Join-Path $CHECKOUTS $repo) cat-file -e "$_^{commit}" 2>$null; $LASTEXITCODE -ne 0 })
        if ($lack.Count) {
            Warn "$repo lacks pinned release commit(s): $($lack -join ' ') - the version matrix cannot stage those:"
            Note "  git -C `"$CHECKOUTS\$repo`" remote add trustcrypto https://github.com/trustcrypto/$repo"
            Note "  git -C `"$CHECKOUTS\$repo`" fetch --tags trustcrypto"
        }
    }
}

if ((Test-Path $addon) -and -not $depsChanged) { Note 'addon built' }
elseif ($pm2State -eq 'online' -and (Test-Path $addon)) {
    # A running emulator holds the .node open, and Windows will not overwrite
    # a loaded DLL. This script does not stop pm2 for you.
    Warn 'the addon needs a rebuild, but pm2 is running the emulator, which locks it:'
    Note '  pm2 stop onlykey-emulator; then re-run this script'
    Todo 'rebuild the emulator addon (stop the pm2 emulator first)'
}
elseif ($Check) { Would 'npm run rebuild in emulator' }
elseif (-not (Test-Path (Join-Path $emu 'node_modules'))) { Todo 'emulator addon: npm install did not complete' }
else {
    Say 'building the emulator addon (npm run rebuild)'
    [void](Run $emu 'npm' @('run', 'rebuild'))
}

# --- the other Node trees -------------------------------------------------
#
# --no-save: these are other people's checkouts (and ui is ours, but the
# same holds), and a plain install can rewrite a tracked package-lock.json.
# --no-save still installs exactly what the lock pins.
$nodeTrees = @(@{ Name = 'ui'; Dir = (Join-Path $ROOT 'ui') }) +
    @('onlykey-testing', 'OnlyKey-App', 'apps.onlykey.io' | ForEach-Object { @{ Name = $_; Dir = (Join-Path $CHECKOUTS $_) } })
foreach ($t in $nodeTrees) {
    if (-not (Test-Path (Join-Path $t.Dir 'package.json'))) { Note "$($t.Name): no package.json, skipped"; continue }
    $stale = Get-NpmStale $t.Dir
    if (-not $stale) { Note "$($t.Name) node_modules current" }
    elseif ($Check) { Would "npm install --no-save in $($t.Name) ($stale)" }
    else { Say "npm install in $($t.Name) ($stale)"; [void](Run $t.Dir 'npm' @('install', '--no-save')) }
}

# The web app's docs/ is its webpack build. BUILD.sh does not run under
# cmd.exe, so Windows uses the committed docs/ and this does not build it.
$docs = Join-Path $CHECKOUTS 'apps.onlykey.io\docs'
if ((Has 'apps.onlykey.io') -and -not (Test-Path $docs)) {
    Warn 'apps.onlykey.io has no docs/ - it is built on Linux (BUILD.sh), not here'
}

# --- the kit's NW SDK - LAST ----------------------------------------------
#
# The kit looks for exactly nwjs-sdk-v0.114.0-win-<arch>\nw.exe in its OWN
# node_modules and does not declare it (the SDK build has the devtools
# protocol the kit drives windows with; OnlyKey-App's plain nw does not). It is
# installed --no-save, so any later plain `npm install` in onlykey-testing
# prunes it straight back out - which is why it comes after the loop above.
$nodeArch = if ($nodeOk) { (& node -p 'process.arch') } else { 'x64' }
$kit = Join-Path $CHECKOUTS 'onlykey-testing'
$nwExe = Join-Path $kit "node_modules\nw\nwjs-sdk-v0.114.0-win-$nodeArch\nw.exe"
Say 'kit NW SDK'
if (-not (Test-Path (Join-Path $kit 'package.json'))) { Note 'onlykey-testing absent, skipped' }
elseif (Test-Path $nwExe) { Note "present: $nwExe" }
elseif ($Check) { Would 'npm install --no-save nw@0.114.0-sdk in onlykey-testing' }
else {
    [void](Run $kit 'npm' @('install', '--no-save', 'nw@0.114.0-sdk'))
    # npm's allow-scripts gate can skip nw's postinstall, which is the step
    # that downloads the SDK. Run it by hand when the binary did not appear.
    if (-not (Test-Path $nwExe) -and (Test-Path (Join-Path $kit 'node_modules\nw\src\postinstall.js'))) {
        Note 'nw.exe did not appear - running nw''s postinstall by hand'
        [void](Run $kit 'node' @('node_modules/nw/src/postinstall.js'))
    }
    if (-not (Test-Path $nwExe)) { Warn 'NW SDK still missing - kit sections 3 and 4 will skip'; Todo 'kit NW SDK' }
}

# ------------------------------------------------------------ okvhid driver
#
# Four facts, each read back from Windows: the WDK was fetched, the package was
# built, it is signed with a certificate this machine trusts, and the four
# devices exist and are started. The first two need no admin and run here; the
# last two need an elevated token, so they are printed, never run.
$OKVHID = @('OKVHID_KBD', 'OKVHID_FIDO', 'OKVHID_VENDOR', 'OKVHID_SEREMU')
$TEST_SUBJECT = 'CN=OnlyKey VM Manager (Test Signing - NOT FOR RELEASE)'   # sign.ps1's $TestSubject
function Get-OkvhidDevices {
    $found = @{}
    Get-PnpDevice -PresentOnly -InstanceId 'SWD\DEVGEN\OKVHID*' -ErrorAction SilentlyContinue |
        ForEach-Object { $found[$_.InstanceId.Split('\')[-1].ToUpper()] = [string]$_.Status }
    return $found
}
# Pipe NAMES only. Opening a pipe to see if it is served would take the one
# instance the emulator (or a running kit) connects to.
function Get-OkvhidPipes {
    try { @([IO.Directory]::GetFiles('\\.\pipe\') | ForEach-Object { $_ -replace '^.*\\', '' } | Where-Object { $_ -match '^okvhid-[0-3]$' }) } catch { @() }
}

$devices = Get-OkvhidDevices
$devicesOk = @($OKVHID | Where-Object { $devices[$_] -eq 'OK' }).Count
$elevated = @()
if ($NoDriver) { Say 'skipping the okvhid driver (-NoDriver)' }
else {
    Say 'okvhid driver'
    $pkg = Join-Path $DRIVER 'build\x64\Release'
    $built = (Test-Path (Join-Path $pkg 'okvhid.dll')) -and (Test-Path (Join-Path $pkg 'okvhid.inf'))
    $trusted = @('Root', 'TrustedPublisher' | Where-Object {
        Get-ChildItem "Cert:\LocalMachine\$_" -ErrorAction SilentlyContinue |
            Where-Object { $_.Subject -eq $TEST_SUBJECT -and $_.NotAfter -gt (Get-Date) } }).Count -eq 2
    $signed = $trusted -and (Test-Path (Join-Path $pkg 'okvhid.cat'))

    if ($devicesOk -eq 4) { Note 'devices 4/4 OK - nothing to do' }
    else {
        if (Test-Path (Join-Path $DRIVER 'vendor\wdk')) { Note 'WDK present (vendor\wdk)' }
        elseif ($Check) { Would 'windows-driver\fetch-wdk.ps1 (no admin)' }
        else {
            Say 'fetching the WDK (no admin)'
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DRIVER 'fetch-wdk.ps1')
            if ($LASTEXITCODE -ne 0) { Todo 'windows-driver\fetch-wdk.ps1' }
        }
        if ($built) { Note 'driver built (build\x64\Release)' }
        elseif ($Check) { Would 'windows-driver\build-direct.ps1 (no admin)' }
        elseif (Test-Path (Join-Path $DRIVER 'vendor\wdk')) {
            Say 'building the driver (no admin)'
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $DRIVER 'build-direct.ps1')
            $built = ($LASTEXITCODE -eq 0) -and (Test-Path (Join-Path $pkg 'okvhid.dll'))
            if (-not $built) { Todo 'windows-driver\build-direct.ps1' }
            $signed = $false   # a fresh build needs a fresh catalog
        }
        if (-not $signed) { $elevated += '.\sign.ps1 -Mode Test' }
        $elevated += '.\install-driver.ps1'
        # problem 22 = disabled, left by an unplug that was in effect when
        # Windows went down; it survives the restart (windows-driver\README.md).
        if (@($devices.Values | Where-Object { $_ -and $_ -ne 'OK' }).Count) { $elevated += '.\hotplug.ps1' }
        foreach ($d in $OKVHID) { Note "  $d : $(if ($devices[$d]) { $devices[$d] } else { 'not present' })" }
        if ($devicesOk -eq 0 -and $signed) { Note 'package signed but no devices - normal after a reboot; re-run install-driver.ps1' }
    }
}

# ----------------------------------------------------------------- summary
#
# Every line is read back from the system, so a partial setup says so.
$pipes = Get-OkvhidPipes
$venvNow = @($venvExes + 'age', 'age-keygen' | Where-Object { -not (Test-Path (Join-Path $VENV "Scripts\$_.exe")) })
function Line([bool] $ok, [string] $yes, [string] $no) { if ($ok) { Write-Host "   [x] $yes" } else { Write-Host "   [ ] $no" } }

Write-Host ''
Write-Host '-- setup summary'
Line ($missing.Count -eq 0) 'prerequisites (git, node, npm, python, VS Clang tools)' 'prerequisites MISSING - see above'
Line (-not @($COMPONENTS | Where-Object { -not (Has $_.Dir) }).Count) "components ($($COMPONENTS.Count)) beside this repo" 'components MISSING - re-run with -Clone'
Line ($devicesOk -eq 4) 'okvhid devices 4/4 OK' "okvhid devices $devicesOk/4 OK"
Line ($pipes.Count -eq 4) "okvhid pipes present ($(($pipes | Sort-Object) -join ', '))" "okvhid pipes $($pipes.Count)/4 present"
Line (Test-Path $addon) 'emulator addon built' 'emulator addon MISSING - the device sections cannot run'
Line ($pm2State -ne 'pm2 not installed') "pm2 (onlykey-emulator: $pm2State)" 'pm2 MISSING - npm install -g pm2'
Line ($venvNow.Count -eq 0) 'okpqc-venv (onlykey-cli, agents, age-plugin-onlykey, age, age-keygen)' "okpqc-venv incomplete - missing $($venvNow -join ', ')"
Line (Test-Path $nwExe) 'kit NW SDK (nw.exe)' 'kit NW SDK MISSING - onlykey-testing sections 3 and 4 will skip'
Line (Test-Path $docs) 'apps.onlykey.io docs/ (committed build; not built on Windows)' 'apps.onlykey.io docs/ MISSING - build it on Linux'

$okt = Join-Path $kit 'bin\okt.js'
if (Test-Path $okt) {
    if ($Check) {
        # okt caps connects to free okvhid pipes to see whether they are taken.
        Note "okt caps: not run in -Check (it opens the pipes). Run: node `"$okt`" caps"
    } else {
        Write-Host ''
        Write-Host '-- okt caps'
        & node $okt caps
    }
}

if ($elevated.Count) {
    Write-Host ''
    Warn 'the driver needs these, from an ELEVATED PowerShell (this script does not elevate):'
    Note "  cd `"$DRIVER`""
    Note '  Set-ExecutionPolicy -Scope Process Bypass'
    foreach ($e in $elevated) { Note "  $e" }
    Note 'After every Windows restart, install-driver.ps1 again: the devices do not survive a reboot.'
    Todo "elevated driver steps: $($elevated -join '; ')"
}

Write-Host ''
if ($pm2State -ne 'online') {
    Note "The emulator is not running under pm2 ($pm2State). Start it: cd `"$ROOT`"; pm2 start ecosystem.config.js"
}
Note 'Running the kit (one device on the pipes at a time):'
Note '  pm2 stop onlykey-emulator'
Note "  node `"$okt`" run <section>"
Note '  pm2 start onlykey-emulator'

Write-Host ''
if ($script:Outstanding.Count) {
    Write-Host "$($script:Outstanding.Count) item(s) outstanding:"
    foreach ($o in $script:Outstanding) { Note "- $o" }
    exit 1
}
Write-Host $(if ($Check) { 'Check: everything is present; nothing would be done.' } else { 'Setup complete.' })
exit 0
