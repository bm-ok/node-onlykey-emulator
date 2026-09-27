<#
.SYNOPSIS
    Install okvhid and create the four OnlyKey virtual HID devices.

.DESCRIPTION
    Both steps are required. The devices are root-enumerated, so there is no
    bus to discover them; they are created explicitly.

        pnputil /add-driver     puts okvhid.inf in the driver store, which
                                makes Windows able to install it
        devgen /add             creates root\okvhid_kbd and friends

.PARAMETER PackageDir
    Directory holding okvhid.inf, okvhid.dll and okvhid.cat. Defaults to the
    newest signed build.

.PARAMETER Force
    Install even if the package is unsigned. The install will very likely
    fail; this exists so the failure can be read.

.PARAMETER PipeUser
    The account allowed to open the key's pipes (besides SYSTEM), as
    DOMAIN\user or user. Defaults to the user signed in to the desktop -
    not the elevating account, so "run as a different admin" still names the
    key's owner. Recorded as a SID under HKLM\SOFTWARE\okvhid\PipeUser; see
    OKVHID_PIPE_SDDL_FMT in src\public.h.

.EXAMPLE
    .\install-driver.ps1
    .\install-driver.ps1 -PipeUser MYPC\alice
#>
[CmdletBinding()]
param(
    [string] $PackageDir,
    [switch] $Force,
    [string] $PipeUser
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Say($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "    $m" -ForegroundColor Red }

# The four root devices. These hardware IDs must match the [Standard] section
# of okvhid.inf and g_OkInterfaces[].Tag in the generated descriptors.h.
$Devices = @(
    @{ Id = 'root\okvhid_kbd';    Instance = 'okvhid_kbd';    Pipe = 0; What = 'hid.usb0 keyboard' },
    @{ Id = 'root\okvhid_fido';   Instance = 'okvhid_fido';   Pipe = 1; What = 'hid.usb1 FIDO2 / CTAP-HID' },
    @{ Id = 'root\okvhid_vendor'; Instance = 'okvhid_vendor'; Pipe = 2; What = 'hid.usb2 vendor protocol' },
    @{ Id = 'root\okvhid_seremu'; Instance = 'okvhid_seremu'; Pipe = 3; What = 'hid.usb3 SEREMU console' }
)

# ------------------------------------------------------------------ checks
$isAdmin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    throw 'Administrator required. Installing a driver and creating root devices both need an elevated token.'
}

if (-not $PackageDir) {
    $candidate = Get-ChildItem -Path (Join-Path $root 'build') -Directory -Recurse -ErrorAction SilentlyContinue |
                 Where-Object { Test-Path (Join-Path $_.FullName 'okvhid.inf') } |
                 Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $candidate) { throw 'No package found. Run .\build.ps1 and .\sign.ps1 first.' }
    $PackageDir = $candidate.FullName
}

$inf = Join-Path $PackageDir 'okvhid.inf'
$cat = Join-Path $PackageDir 'okvhid.cat'
if (-not (Test-Path $inf)) { throw "okvhid.inf not found in $PackageDir" }

Say "Package: $PackageDir"

if (-not (Test-Path $cat)) {
    Bad 'No okvhid.cat - the package is unsigned and Windows will reject it.'
    Bad 'Run .\sign.ps1 -Mode Test first.'
    if (-not $Force) { throw 'Refusing to install an unsigned package. Pass -Force to try anyway.' }
}

# ------------------------------------------------------------ pipe owner
#
# Who may open the key's pipes, besides SYSTEM. Recorded BEFORE the package is
# added: devices that already exist restart on the new package and read this
# as their pipes start. Without it the driver fails closed (SYSTEM only) and
# the emulator cannot attach - so an account that cannot be resolved stops
# the install here instead of producing a key nobody can reach.
Say 'Recording who may open the pipes'
if (-not $PipeUser) {
    $PipeUser = (Get-CimInstance Win32_ComputerSystem).UserName   # the desktop session
}
if (-not $PipeUser) {
    throw 'No one is signed in to the desktop session to own the key. Pass -PipeUser DOMAIN\user.'
}
try {
    $sid = (New-Object System.Security.Principal.NTAccount($PipeUser)).Translate(
               [System.Security.Principal.SecurityIdentifier]).Value
} catch {
    throw "Cannot resolve '$PipeUser' to an account: $($_.Exception.Message)"
}
New-Item -Path 'HKLM:\SOFTWARE\okvhid' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\okvhid' -Name 'PipeUser' -Value $sid -Type String
Write-Host "    $PipeUser ($sid) + SYSTEM"

# ------------------------------------------------------------ driver store
Say 'Adding okvhid.inf to the driver store'

# What DriverVer this package claims. pnputil ranks and dedupes on it, and
# nothing else about the package - not the DLL, not the catalog - takes part.
$declaredVer = (Select-String -Path $inf -Pattern '^\s*DriverVer\s*=' |
                Select-Object -First 1).Line -replace '^\s*DriverVer\s*=\s*', ''
Write-Host "    DriverVer: $declaredVer"

$addOutput = & pnputil /add-driver $inf /install 2>&1 | Out-String
$addExit = $LASTEXITCODE
Write-Host $addOutput
# 3010 is ERROR_SUCCESS_REBOOT_REQUIRED: the package IS added, but a device
# could not switch drivers yet - typically because an application (the
# OnlyKey App) holds it open. Treating it as a failure stopped the install
# before the devices and the table; carry on, and say it at the end.
$rebootNeeded = ($addExit -eq 3010)
if ($addExit -ne 0 -and $addExit -ne 259 -and -not $rebootNeeded) {
    throw "pnputil /add-driver failed with exit code $addExit"
}

# pnputil decides whether a package is new on DriverVer alone. build-direct.ps1
# stamps the build time into it so every rebuild is a distinct version; this
# reports the case where the store already holds this version and the binary
# just built therefore stayed on disk.
if ($addOutput -match 'Added driver packages:\s*0') {
    Warn ''
    Warn "The store already holds DriverVer $declaredVer, so the package was"
    Warn 'left as it was. Rebuild for a fresh DriverVer and re-sign, or remove'
    Warn 'the existing package first:'
    Warn '    pnputil /enum-drivers'
    Warn '    pnputil /delete-driver oemNN.inf /uninstall /force'
}

# --------------------------------------------------------------- devices
#
# devgen ships with the WDK (Win10 1809+). devcon is the older equivalent and
# is tried as a fallback, since plenty of machines have one and not the other.
function Find-Tool($name) {
    $onPath = Get-Command $name -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    # The fetched WDK first - devgen is a WDK tool, so on a machine with only
    # the SDK it lives nowhere else. See scripts\fetch-wdk.ps1.
    foreach ($r in @((Join-Path $PSScriptRoot 'vendor\wdk\c\tools'),
                     (Join-Path $PSScriptRoot 'vendor\wdk\c\bin'),
                     "${env:ProgramFiles(x86)}\Windows Kits\10\Tools",
                     "${env:ProgramFiles}\Windows Kits\10\Tools")) {
        if (-not (Test-Path $r)) { continue }
        $all = Get-ChildItem -Path $r -Recurse -Filter $name -ErrorAction SilentlyContinue
        if (-not $all) { continue }
        $hit = $all | Where-Object { $_.FullName -match '\\x64\\' } |
               Sort-Object FullName -Descending | Select-Object -First 1
        if (-not $hit) { $hit = $all | Sort-Object FullName -Descending | Select-Object -First 1 }
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$devgen = Find-Tool 'devgen.exe'
$devcon = Find-Tool 'devcon.exe'

if (-not $devgen -and -not $devcon) {
    Write-Host ''
    Bad 'Neither devgen.exe nor devcon.exe was found.'
    Bad 'The driver is installed but no devices exist, so nothing will enumerate.'
    Bad ''
    Bad 'Both ship with the WDK. Create the devices by hand with:'
    foreach ($d in $Devices) {
        Bad "    devgen /add /instanceid $($d.Instance) /hardwareid `"$($d.Id)`""
    }
    throw 'Cannot create root devices.'
}

#
# Keep what the tool said. devgen can decline to create a device and still
# exit 0, so its own words are the only account of why - and discarding them
# leaves the missing device with no explanation attached.
#
Say 'Creating the four root devices'
$creation = @{}
foreach ($d in $Devices) {
    Write-Host "    $($d.Id)  ($($d.What))"
    if ($devgen) {
        $out = & $devgen /add /instanceid $d.Instance /hardwareid $d.Id 2>&1 | Out-String
    } else {
        $out = & $devcon install $inf $d.Id 2>&1 | Out-String
    }
    $creation[$d.Instance] = @{ Exit = $LASTEXITCODE; Output = $out.Trim() }
    if ($LASTEXITCODE -ne 0) {
        Warn "      exit $LASTEXITCODE"
        foreach ($line in ($out -split "`r?`n" | Where-Object { $_.Trim() })) { Warn "      $line" }
    }
}

# ------------------------------------------------------------- diagnostics
Start-Sleep -Seconds 2

#
# Report the device and its pipe as two separate facts, because neither one
# implies the other and reducing them to a single score hides the cases worth
# seeing.
#
# The device comes from PnP and says whether Windows built and started it. The
# pipe is probed with a raw CreateFile so the Win32 error is legible:
#
#   opened            a server is listening and nothing else is attached
#   ERROR_PIPE_BUSY   the name exists and its one instance is taken - normally
#                     the emulator, but a client handle also keeps the name and
#                     its busy state alive after the device behind it is gone,
#                     so this is only good news next to a present device
#   FILE_NOT_FOUND    no pipe of that name
#
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class OkvhidPipeProbe {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateFileW(string p, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Probe(string name) {
    IntPtr h = CreateFileW(@"\\.\pipe\" + name, 0xC0000000u, 0u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);
    if (h.ToInt64() != -1) { CloseHandle(h); return "listening"; }
    int e = Marshal.GetLastWin32Error();
    if (e == 231) return "in use";
    if (e == 2)   return "absent";
    if (e == 5)   return "access denied";
    return "error " + e;
  }
}
'@ -ErrorAction SilentlyContinue

Say 'Result'

$present = @{}
Get-PnpDevice -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -like '*OKVHID*' } |
    ForEach-Object { $present[$_.InstanceId.Split('\')[-1].ToLower()] = $_ }

$missing = @()
$rows = foreach ($d in $Devices) {
    $dev = $present[$d.Instance]
    if ($dev) {
        $status = $dev.Status
        if ($status -ne 'OK') {
            $p = (Get-PnpDeviceProperty -InstanceId $dev.InstanceId -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction SilentlyContinue).Data
            $status = "$status (problem $p)"
        }
    } else {
        $status = 'not created'
        $missing += $d
    }
    [pscustomobject]@{
        Interface = $d.What
        Device    = $status
        Pipe      = "okvhid-$($d.Pipe)"
        State     = [OkvhidPipeProbe]::Probe("okvhid-$($d.Pipe)")
    }
}
$rows | Format-Table -AutoSize

if ($missing.Count) {
    Warn 'Windows did not build these devices:'
    foreach ($d in $missing) {
        $c = $creation[$d.Instance]
        Warn "    $($d.Id)  - the create tool exited $($c.Exit) and said:"
        if ($c.Output) {
            foreach ($line in ($c.Output -split "`r?`n" | Where-Object { $_.Trim() })) { Warn "        $line" }
        } else {
            Warn '        (nothing)'
        }
    }
    Warn ''
    Warn 'setupapi.dev.log records the PnP side, searched by hardware ID:'
    Warn '    notepad %SystemRoot%\inf\setupapi.dev.log'
}

$stale = $rows | Where-Object { $_.Device -eq 'not created' -and $_.State -ne 'absent' }
if ($stale) {
    Warn ''
    Warn 'A pipe is being served with no device behind it, so a pipe thread has'
    Warn 'outlived its device. It belongs to the host process, which Windows'
    Warn 'restarts on its own for the devices that are still present:'
    Warn '    Get-Process WUDFHost | Stop-Process -Force'
}

if ($rebootNeeded) {
    Write-Host ''
    Bad 'Windows needs a RESTART to finish: pnputil exit 3010 - a device could not'
    Bad 'switch to the new driver while something held it open (close the OnlyKey'
    Bad 'App before installing). Until then the table above may show the OLD'
    Bad 'driver still serving the pipes. After the restart, run this again - the'
    Bad 'devices do not survive a reboot anyway.'
}

Write-Host ''
Write-Host 'Next: start the emulator, so the devices have something behind them.' -ForegroundColor Green
Write-Host ''
Write-Host 'Until something connects to the pipes, the devices enumerate but never'
Write-Host 'produce a report - which is correct. They are a relay, not a simulation.'
