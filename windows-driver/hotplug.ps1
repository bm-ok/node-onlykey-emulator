<#
.SYNOPSIS
    Plug and unplug the virtual OnlyKey, whole or one interface at a time.

.DESCRIPTION
    There is no cable to pull, so "unplug" has to be spelled out. Two ways to
    say it:

        default   Disable-PnpDevice / Enable-PnpDevice
        -Hard     pnputil /remove-device / devgen /add

    In practice both end up at the second one. devgen conjures these nodes
    under SWD\DEVGEN, and software devices are not created disableable, so
    Disable-PnpDevice answers "Not supported" and the script falls through to
    removing them. The disable path is kept because it is the better unplug
    where it works - it leaves the node behind, so replugging keeps the same
    instance ID - and because these devices will not always be devgen's.

    Either way Windows tears the whole stack down: WUDFHost drops the
    instance, okvhid's pipe closes, and the HID collections disappear from
    every application that had them open. That is a real unplug, not a
    simulated one.

    The emulator does not have to be told. It is retrying the pipe
    continuously, so it reconnects on its own when the interface comes back -
    which is the point of the driver hosting the pipe rather than the host.

.PARAMETER Interface
    kbd, fido, vendor, seremu, or all. Defaults to all.

    Unplugging one interface is a state real hardware cannot be in, and that
    is deliberate: it is the cheapest way to see how a relying party behaves
    when CTAP-HID vanishes mid-ceremony.

.PARAMETER Off
    Unplug. Without it, plug in.

.PARAMETER Cycle
    Unplug, wait -DelayMs, plug back in. What you want for a replug test.

.PARAMETER DelayMs
    How long -Cycle stays unplugged. Default 1500. Long enough that Windows
    finishes the removal before the arrival, which it does not always do at
    a few hundred milliseconds.

.PARAMETER Hard
    Remove and recreate the device nodes instead of disabling them.

.EXAMPLE
    .\hotplug.ps1 -Off
    .\hotplug.ps1
    .\hotplug.ps1 -Interface fido -Cycle
#>
[CmdletBinding()]
param(
    [ValidateSet('kbd', 'fido', 'vendor', 'seremu', 'all')]
    [string] $Interface = 'all',
    [switch] $Off,
    [switch] $Cycle,
    [int]    $DelayMs = 1500,
    [switch] $Hard
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Say($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Note($m) { Write-Host "    $m" }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "    $m" -ForegroundColor Red }

# Must match the [Standard] section of okvhid.inf and install-driver.ps1.
$All = @(
    @{ Tag = 'kbd';    Id = 'root\okvhid_kbd';    Instance = 'okvhid_kbd';    What = 'hid.usb0 keyboard' },
    @{ Tag = 'fido';   Id = 'root\okvhid_fido';   Instance = 'okvhid_fido';   What = 'hid.usb1 FIDO2 / CTAP-HID' },
    @{ Tag = 'vendor'; Id = 'root\okvhid_vendor'; Instance = 'okvhid_vendor'; What = 'hid.usb2 vendor protocol' },
    @{ Tag = 'seremu'; Id = 'root\okvhid_seremu'; Instance = 'okvhid_seremu'; What = 'hid.usb3 SEREMU console' }
)

$targets = if ($Interface -eq 'all') { $All }
           else { $All | Where-Object { $_.Tag -eq $Interface } }

# ------------------------------------------------------------------ checks
$isAdmin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    throw 'Administrator required. Enabling and disabling a device both need an elevated token.'
}

# ------------------------------------------------------------------- tools
# devgen only matters for -Hard. Looking for it up front means a missing tool
# is reported before anything has been unplugged, rather than halfway through.
function Find-Tool([string] $Name) {
    $hit = Get-ChildItem -Path (Join-Path $root 'vendor\wdk') `
                         -Filter $Name -Recurse -ErrorAction SilentlyContinue |
           Select-Object -First 1
    if ($hit) { return $hit.FullName }
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# Always, not just for -Hard: soft mode falls back to removal on these nodes,
# and finding that out after unplugging four devices we then cannot recreate is
# the one outcome worth ruling out up front.
$devgen = Find-Tool 'devgen.exe'
if (-not $devgen) {
    throw 'devgen.exe not found; it is what recreates the devices after a removal. Run scripts\fetch-wdk.ps1.'
}

$script:UsedHard = $false

# ------------------------------------------------------------------ lookup
# devgen enumerates these under SWD\DEVGEN\OKVHID_KBD rather than the
# root\okvhid_kbd hardware ID they were created from, so match on the instance
# name, which appears in both. -like is case-insensitive, which is just as
# well: devgen upper-cases what it is given.
#
# No -PresentOnly:$false here. It reads like the way to include absent devices
# and it is not - it returns a *smaller* set that excludes these, so passing it
# makes every device look unplugged and every unplug look like a no-op. Bare
# Get-PnpDevice already returns present and absent both.
function Get-Node($Target) {
    return Get-PnpDevice -ErrorAction SilentlyContinue |
           Where-Object { $_.InstanceId -like "*$($Target.Instance)*" } |
           Select-Object -First 1
}

function Show-State($Target) {
    $n = Get-Node $Target
    if ($null -eq $n) { Note "$($Target.Tag.PadRight(7)) absent" ; return }
    $problem = ''
    try {
        $p = (Get-PnpDeviceProperty -InstanceId $n.InstanceId `
                                    -KeyName 'DEVPKEY_Device_ProblemCode' `
                                    -ErrorAction Stop).Data
        if ($p -and $p -ne 0) { $problem = "  problem $p" }
    } catch { }
    Note "$($Target.Tag.PadRight(7)) $($n.Status)$problem"
}

# --------------------------------------------------------------- unplug/plug
function Unplug($Target) {
    $n = Get-Node $Target
    if ($null -eq $n) { Warn "$($Target.Tag): no device node - already unplugged"; return }

    if (-not $Hard) {
        try {
            Disable-PnpDevice -InstanceId $n.InstanceId -Confirm:$false -ErrorAction Stop
            Note "$($Target.Tag): disabled"
            return
        } catch {
            # Software devices conjured by devgen live under SWD\DEVGEN and
            # have no disable capability - CM_DEVCAP_DISABLEABLE is not set, so
            # Disable-PnpDevice answers "Not supported" and means it. Removal
            # is the only unplug these nodes have, so take it rather than
            # report a failure the caller can do nothing about.
            Warn "$($Target.Tag): not disableable ($($_.Exception.Message.Trim())); removing instead"
            $script:UsedHard = $true
        }
    }

    & pnputil /remove-device $n.InstanceId 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Warn "$($Target.Tag): pnputil exit $LASTEXITCODE" }
    else { Note "$($Target.Tag): removed" }
}

function Plug($Target) {
    $n = Get-Node $Target

    # No node means it was removed rather than disabled, whichever way we got
    # there, so recreate it. Enable only applies to something still present.
    if ($null -eq $n) {
        & $devgen /add /instanceid $Target.Instance /hardwareid $Target.Id | Out-Null
        if ($LASTEXITCODE -ne 0) { Bad "$($Target.Tag): devgen exit $LASTEXITCODE" }
        else { Note "$($Target.Tag): created" }
        return
    }

    if ($n.Status -eq 'OK') { Note "$($Target.Tag): already plugged in"; return }

    try {
        Enable-PnpDevice -InstanceId $n.InstanceId -Confirm:$false -ErrorAction Stop
        Note "$($Target.Tag): enabled"
    } catch {
        Bad "$($Target.Tag): enable failed - $($_.Exception.Message)"
    }
}

# -------------------------------------------------------------------- drive
$mode = if ($Hard) { 'hard (remove/create)' } else { 'soft (disable/enable)' }

if ($Cycle) {
    Say "Replugging $Interface - $mode"
    foreach ($t in $targets) { Unplug $t }
    Note "waiting ${DelayMs}ms"
    Start-Sleep -Milliseconds $DelayMs
    foreach ($t in $targets) { Plug $t }
} elseif ($Off) {
    Say "Unplugging $Interface - $mode"
    foreach ($t in $targets) { Unplug $t }
} else {
    Say "Plugging in $Interface - $mode"
    foreach ($t in $targets) { Plug $t }
}

# The stack takes a moment to settle; reporting before it does shows the state
# we just left rather than the one we asked for.
Start-Sleep -Milliseconds 800

Say 'State'
foreach ($t in $All) { Show-State $t }

$pipes = @(Get-ChildItem '\\.\pipe\' -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -like 'okvhid-*' })
Say "Pipes: $($pipes.Count) of 4$(if ($pipes.Count) { ' (' + (($pipes.Name | Sort-Object) -join ', ') + ')' })"
if ($pipes.Count -ne 4 -and -not $Off) {
    Warn 'A device that is Started but has no pipe means the driver loaded and'
    Warn 'OkvhidPipeStart failed. Check the WUDFHost event log.'
}
