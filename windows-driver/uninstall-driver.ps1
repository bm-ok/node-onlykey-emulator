<#
.SYNOPSIS
    Remove the OnlyKey virtual HID devices and the okvhid driver.

.DESCRIPTION
    Reverses install-driver.ps1, in the order the driver store requires:
    devices first, then the package they reference.

.PARAMETER RemoveTestCertificate
    Also remove the self-signed test certificate from LocalMachine Root and
    TrustedPublisher. Worth doing when you are finished - it is a trust anchor
    with an exportable private key sitting in your user store.

.EXAMPLE
    .\uninstall-driver.ps1
    .\uninstall-driver.ps1 -RemoveTestCertificate
#>
[CmdletBinding()]
param(
    [switch] $RemoveTestCertificate
)

$ErrorActionPreference = 'Continue'

function Say($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

$TestSubject = 'CN=OnlyKey VM Manager (Test Signing - NOT FOR RELEASE)'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Administrator required.' }

# ---------------------------------------------------------------- devices
Say 'Removing devices'
$devices = Get-PnpDevice -ErrorAction SilentlyContinue |
           Where-Object { $_.InstanceId -like '*OKVHID*' -or $_.FriendlyName -like '*OnlyKey Virtual HID*' }

if ($null -eq $devices -or $devices.Count -eq 0) {
    Write-Host '    none present'
} else {
    foreach ($d in $devices) {
        Write-Host "    $($d.FriendlyName)"
        try {
            # pnputil /remove-device is the supported path; Remove-PnpDevice
            # does not exist on every Windows build this may run on.
            & pnputil /remove-device $d.InstanceId | Out-Null
        } catch {
            Warn "      failed: $($_.Exception.Message)"
        }
    }
}

# ----------------------------------------------------------- driver store
Say 'Removing okvhid from the driver store'
$published = & pnputil /enum-drivers | Out-String

# Each entry is a block; find the oem*.inf whose block mentions okvhid.
$oem = $null
foreach ($block in ($published -split "`r?`n`r?`n")) {
    if ($block -match 'okvhid\.inf' -and $block -match '(oem\d+\.inf)') {
        $oem = $Matches[1]
        break
    }
}

if ($oem) {
    Write-Host "    published as $oem"
    & pnputil /delete-driver $oem /uninstall /force
    if ($LASTEXITCODE -ne 0) { Warn "pnputil /delete-driver exit $LASTEXITCODE" }
} else {
    Write-Host '    not in the driver store'
}

# ------------------------------------------------------------ pipe owner
# install-driver.ps1 recorded who may open the pipes; with the driver gone
# that record means nothing, and a stale one would name the wrong owner for
# the next install if -PipeUser were ever skipped. Trace is left alone - it is
# a debugging switch the user set, not install state.
if (Get-ItemProperty -Path 'HKLM:\SOFTWARE\okvhid' -Name 'PipeUser' -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path 'HKLM:\SOFTWARE\okvhid' -Name 'PipeUser' -ErrorAction SilentlyContinue
    Write-Host '    pipe owner record removed'
}

# ------------------------------------------------------------ certificate
if ($RemoveTestCertificate) {
    Say 'Removing the test certificate'
    foreach ($store in @('Cert:\LocalMachine\Root',
                         'Cert:\LocalMachine\TrustedPublisher',
                         'Cert:\CurrentUser\My')) {
        Get-ChildItem $store -ErrorAction SilentlyContinue |
            Where-Object { $_.Subject -eq $TestSubject } |
            ForEach-Object {
                Write-Host "    $store  $($_.Thumbprint)"
                Remove-Item $_.PSPath -Force -ErrorAction SilentlyContinue
            }
    }
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host 'A reboot clears any device nodes Windows was still holding open.'
