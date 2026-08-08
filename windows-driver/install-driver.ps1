<#
.SYNOPSIS
    Install okvhid and create the four OnlyKey virtual HID devices.

.DESCRIPTION
    Two steps that are easy to confuse. Adding the driver to the store makes
    Windows *able* to install it; it does not create anything. The devices are
    root-enumerated, so they have to be conjured explicitly - there is no bus
    that will discover them.

        pnputil /add-driver     puts okvhid.inf in the driver store
        devgen /add             creates root\okvhid_kbd and friends

    Skipping the second step leaves a correctly installed driver and no
    devices, which looks exactly like a driver that failed to load.

.PARAMETER PackageDir
    Directory holding okvhid.inf, okvhid.dll and okvhid.cat. Defaults to the
    newest signed build.

.PARAMETER Force
    Install even if the driver is unsigned or test signing is off. The install
    will very likely fail; this exists so the failure can be read.

.EXAMPLE
    .\install-driver.ps1
#>
[CmdletBinding()]
param(
    [string] $PackageDir,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Say($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "    $m" -ForegroundColor Red }

# The four root devices. These hardware IDs must match the [Standard] section
# of okvhid.inf and g_OkInterfaces[].Tag in the generated descriptors.h.
$Devices = @(
    @{ Id = 'root\okvhid_kbd';    Instance = 'okvhid_kbd';    What = 'hid.usb0 keyboard' },
    @{ Id = 'root\okvhid_fido';   Instance = 'okvhid_fido';   What = 'hid.usb1 FIDO2 / CTAP-HID' },
    @{ Id = 'root\okvhid_vendor'; Instance = 'okvhid_vendor'; What = 'hid.usb2 vendor protocol' },
    @{ Id = 'root\okvhid_seremu'; Instance = 'okvhid_seremu'; What = 'hid.usb3 SEREMU console' }
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

# Test signing state. `bcdedit /enum` is the only reliable read of it.
$testsigning = $false
try {
    $bcd = & bcdedit /enum '{current}' 2>$null | Out-String
    $testsigning = $bcd -match 'testsigning\s+Yes'
} catch { }

if (-not $testsigning) {
    Warn 'Test signing is OFF.'
    Warn 'A test-signed driver will not load. If you signed with -Mode Test:'
    Warn ''
    Warn '    bcdedit /set testsigning on'
    Warn '    (then reboot)'
    Warn ''
    Warn 'This weakens driver-signature enforcement machine-wide. See SIGNING.md.'
    if (-not $Force) {
        throw 'Refusing to continue with test signing off. Pass -Force if the package is production-signed.'
    }
} else {
    Write-Host '    test signing: on'
}

# ------------------------------------------------------------ driver store
Say 'Adding okvhid.inf to the driver store'

# What DriverVer this package claims. pnputil ranks and dedupes on it, and
# nothing else about the package - not the DLL, not the catalog - takes part.
$declaredVer = (Select-String -Path $inf -Pattern '^\s*DriverVer\s*=' |
                Select-Object -First 1).Line -replace '^\s*DriverVer\s*=\s*', ''
Write-Host "    DriverVer: $declaredVer"

$addOutput = & pnputil /add-driver $inf /install 2>&1 | Out-String
Write-Host $addOutput
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 259) {
    throw "pnputil /add-driver failed with exit code $LASTEXITCODE"
}

# "Added driver packages: 0" is not a warning anywhere - it is the ordinary
# report for a package pnputil considers identical to one already in the store,
# and it decides that on DriverVer alone. So a rebuilt DLL under an unchanged
# DriverVer is silently discarded and the OLD binary stays loaded, while every
# other line of output says success. build-direct.ps1 stamps the build time
# into DriverVer to make that impossible; this catches it if the stamp ever
# stops happening.
if ($addOutput -match 'Added driver packages:\s*0') {
    Warn ''
    Warn "pnputil added nothing - a package with DriverVer $declaredVer is"
    Warn 'already in the store, so the binary you just built was NOT installed.'
    Warn 'The previously installed okvhid.dll is what will load.'
    Warn ''
    Warn 'Rebuild (build-direct.ps1 stamps a fresh DriverVer) and re-sign, or'
    Warn 'remove the existing package first:'
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

Say 'Creating the four root devices'
foreach ($d in $Devices) {
    Write-Host "    $($d.Id)  ($($d.What))"
    if ($devgen) {
        & $devgen /add /instanceid $d.Instance /hardwareid $d.Id | Out-Null
    } else {
        & $devcon install $inf $d.Id | Out-Null
    }
    if ($LASTEXITCODE -ne 0) {
        Warn "      failed (exit $LASTEXITCODE) - it may already exist"
    }
}

# ------------------------------------------------------------- diagnostics
Start-Sleep -Seconds 2

Say 'Result'
$found = Get-PnpDevice -ErrorAction SilentlyContinue |
         Where-Object { $_.InstanceId -like '*OKVHID*' -or $_.FriendlyName -like '*OnlyKey Virtual HID*' }

if ($null -eq $found -or $found.Count -eq 0) {
    Bad 'No OnlyKey Virtual HID devices are present.'
    Bad 'Check Device Manager for a yellow bang, and read setupapi.dev.log:'
    Bad '    notepad %SystemRoot%\inf\setupapi.dev.log'
} else {
    $found | Format-Table -AutoSize Status, Class, FriendlyName, InstanceId
    $bad = $found | Where-Object { $_.Status -ne 'OK' }
    if ($bad) {
        Warn 'Some devices are not started. Their Problem code is the thing to look up.'
        $bad | ForEach-Object {
            $p = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction SilentlyContinue).Data
            Warn "    $($_.FriendlyName): problem $p"
        }
    }
}

# Each loaded instance hosts one pipe, so counting them tells you the driver
# not only installed but ran - which the device status alone does not.
$pipes = @(Get-ChildItem '\\.\pipe\' -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -like 'okvhid-*' })
Write-Host ''
Say "Pipes: $($pipes.Count) of 4$(if ($pipes.Count) { ' (' + (($pipes.Name | Sort-Object) -join ', ') + ')' })"
if ($pipes.Count -ne 4) {
    Warn 'Devices that are OK with no pipe mean the loaded okvhid.dll is an'
    Warn 'older build - check the DriverVer note above - or OkvhidPipeStart'
    Warn 'failed. Either way the emulator has nothing to connect to.'
}

Write-Host ''
Write-Host 'Next: start the emulator, so the devices have something behind them.' -ForegroundColor Green
Write-Host ''
Write-Host 'Until something connects to the pipes, the devices enumerate but never'
Write-Host 'produce a report - which is correct. They are a relay, not a simulation.'
