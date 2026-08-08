<#
.SYNOPSIS
    Build okvhid with clang-cl directly, without the WDK's MSBuild targets.

.DESCRIPTION
    A .vcxproj with DriverType=UMDF needs WindowsDriver.Common.targets, which
    only arrives with the WDK's Visual Studio extension - and that needs an
    elevated installer. scripts\fetch-wdk.ps1 gets the same headers and
    libraries from NuGet without administrator, and this compiles and links
    against them by hand.

    The output is identical in kind: okvhid.dll, a UMDF 2 driver. What is
    skipped is only MSBuild's orchestration - Inf2Cat and signing were always
    separate steps here (see sign.ps1), so nothing is lost but the project
    file.

    build.ps1 calls this automatically when the driver targets are absent.

.PARAMETER Configuration
    Debug or Release. Release is the default and is what gets signed.

.PARAMETER UmdfVersion
    UMDF version to build against. Defaults to the newest the fetched WDK has.

.PARAMETER SkipGenerate
    Do not regenerate descriptors.h.
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug','Release')] [string] $Configuration = 'Release',
    [string] $UmdfVersion,
    [switch] $SkipGenerate
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
# Self-contained: the WDK lands in windows-driverendorwdk, not in the
# emulator root. This directory builds without anything outside it.
$repo = $root
$src  = Join-Path $root 'src'
$wdk  = Join-Path $repo 'vendor\wdk\c'

function Say($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Good($m) { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

<#
Run a compiler or linker and hand back its exit code and its diagnostics.

Windows PowerShell treats anything a native program writes to stderr as an
error record, and with $ErrorActionPreference = 'Stop' that becomes a
terminating NativeCommandError - even when stderr is redirected to a file, and
even when the program then exits 0. Compilers write warnings to stderr
routinely, so without this the first warning aborts the build and the actual
diagnostics never get printed.
#>
function Invoke-Tool {
    param([string] $Exe, [string[]] $Arguments, [string] $LogPath)

    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # *> captures every stream, not just stderr. The compilers write
        # diagnostics to stderr but InfVerif writes its verdict to stdout, and
        # capturing only one of them makes a passing run look like a silent
        # failure.
        & $Exe @Arguments *> $LogPath
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }

    $text = if (Test-Path $LogPath) { Get-Content $LogPath -Raw } else { '' }
    return [pscustomobject]@{ Code = $code; Output = ([string]$text) }
}

if (-not (Test-Path $wdk)) {
    throw "No WDK at $wdk. Run: .\scripts\fetch-wdk.ps1"
}

# ------------------------------------------------------------- descriptors
if (-not $SkipGenerate) {
    Say 'Regenerating descriptors.h'
    $header = Join-Path $src 'descriptors.h'
    $before = if (Test-Path $header) { (Get-FileHash $header).Hash } else { '' }
    & node (Join-Path $root 'gen-descriptors.js')
    if ($LASTEXITCODE -ne 0) { throw "gen-descriptors.js failed ($LASTEXITCODE)" }
    if ($before -and $before -ne (Get-FileHash $header).Hash) {
        Warn 'descriptors.h CHANGED - review before shipping:'
        Warn '    git diff windows-driver/src/descriptors.h'
    }
}

# ------------------------------------------------------------------ tools
Say 'Locating tools'

$clang = Get-Command clang-cl.exe -ErrorAction SilentlyContinue
if (-not $clang) {
    foreach ($p in @('C:\Program Files\LLVM\bin\clang-cl.exe')) {
        if (Test-Path $p) { $clang = @{ Source = $p }; break }
    }
}
if (-not $clang) { throw 'clang-cl.exe not found. Install the "C++ Clang tools for Windows" component of Visual Studio.' }
Write-Host "    clang-cl: $($clang.Source)"

$linker = Get-Command lld-link.exe -ErrorAction SilentlyContinue
if (-not $linker) {
    $p = Join-Path (Split-Path $clang.Source) 'lld-link.exe'
    if (Test-Path $p) { $linker = @{ Source = $p } }
}
if (-not $linker) { throw 'lld-link.exe not found beside clang-cl.' }
Write-Host "    lld-link: $($linker.Source)"

# The MSVC CRT and the system SDK still supply the C runtime and the ordinary
# import libraries; only the WDF and km pieces come from the NuGet WDK.
if (-not $env:INCLUDE -or -not $env:LIB) {
    throw @'
The MSVC environment is not loaded. Open a Developer PowerShell, or:

  $vcvars = 'C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat'
  foreach ($l in (cmd /c "`"$vcvars`" >nul 2>&1 && set")) {
    if ($l -match '^([^=]+)=(.*)$') { Set-Item "env:$($Matches[1])" $Matches[2] }
  }
'@
}

# ------------------------------------------------------------- WDK layout
#
# Target the UMDF version THIS MACHINE has, not the newest the WDK ships.
#
# UmdfLibraryVersion is a request: the framework loads the driver only if it
# can provide that version. Building against the newest headers in the WDK -
# 2.35, from a kit far ahead of the running OS - produces a driver that
# installs, creates its devices, and then refuses to start with
# CM_PROB_FAILED_ADD and status 0xc0000701. The only hint is a single line in
# setupapi.dev.log:
#
#     ! inf: Using WDF schema version 2.23 when section requires version 2.35
#
# HKLM\SYSTEM\CurrentControlSet\Control\Wdf\Umdf\2!Version is what the OS
# actually registers. Nothing here needs a recent UMDF - the driver uses
# WdfDriverCreate, WdfDeviceCreate, queues, spin locks and request forwarding,
# all present since 2.0 - so matching the OS costs nothing and is what makes
# the driver loadable on the machine in front of you.
#
if (-not $UmdfVersion) {
    $osUmdf = $null
    try {
        $osUmdf = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Wdf\Umdf\2' `
                    -Name Version -ErrorAction Stop).Version
    } catch { }

    $have = Get-ChildItem "$wdk\Include\wdf\umdf" -Directory |
        Where-Object { $_.Name -match '^2\.' } |
        Sort-Object { [version]$_.Name } | Select-Object -ExpandProperty Name

    if ($osUmdf -and ($have -contains $osUmdf)) {
        $UmdfVersion = $osUmdf
        $matchedOs = $true
    } elseif ($osUmdf) {
        # Highest we have that does not exceed what the OS offers.
        $UmdfVersion = $have | Where-Object { [version]$_ -le [version]$osUmdf } |
                       Select-Object -Last 1
        if (-not $UmdfVersion) { $UmdfVersion = $have | Select-Object -First 1 }
        Warn "OS reports UMDF $osUmdf; no exact header match, using $UmdfVersion"
    } else {
        $UmdfVersion = $have | Select-Object -Last 1
        Warn "Could not read the OS UMDF version; using $UmdfVersion, which may"
        Warn "be too new - a driver that will not start with CM_PROB_FAILED_ADD"
        Warn "is the symptom. Override with -UmdfVersion."
    }
}
$umdfMajor, $umdfMinor = $UmdfVersion.Split('.')
Write-Host ("    UMDF: {0}{1}" -f $UmdfVersion, $(if ($matchedOs) { ' (matches this OS)' } else { '' }))

$kitVer = Get-ChildItem "$wdk\Include" -Directory |
    Where-Object { $_.Name -match '^10\.' } | Select-Object -Last 1 -ExpandProperty Name
Write-Host "    kit:  $kitVer"

$wdfInc  = "$wdk\Include\wdf\umdf\$UmdfVersion"
$wdfLib  = "$wdk\Lib\wdf\umdf\x64\$UmdfVersion\WdfDriverStubUm.lib"
foreach ($p in @($wdfInc, $wdfLib)) {
    if (-not (Test-Path $p)) { throw "missing: $p" }
}

# km supplies hidport.h, which a UMDF HID minidriver needs even though it
# never runs in kernel mode - the HID class contract is defined there.
$incDirs = @(
    $src,
    $wdfInc,
    "$wdk\Include\$kitVer\km",
    "$wdk\Include\$kitVer\shared",
    "$wdk\Include\$kitVer\um"
) | Where-Object { Test-Path $_ }

#
# Intermediates live OUTSIDE the package directory.
#
# Inf2Cat catalogues a directory, not a file list, so anything sitting beside
# okvhid.dll ends up hashed into okvhid.cat - object files, build logs, the
# import library, the PDB. That makes the catalog invalid the moment any of
# them is touched or cleaned, and the failure appears at install time as a
# hash mismatch rather than as anything mentioning stale build output.
#
# So build\x64\<cfg> holds exactly what ships, and intermediates go in a
# sibling.
#
$outDir = Join-Path $root "build\x64\$Configuration"
$objDir = Join-Path $root "build\obj\x64\$Configuration"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $objDir | Out-Null

# ---------------------------------------------------------------- compile
Say "Compiling ($Configuration, UMDF $UmdfVersion)"

$defines = @(
    "UMDF_VERSION_MAJOR=$umdfMajor",
    "UMDF_VERSION_MINOR=$umdfMinor",
    'UMDF_USING_NTSTATUS',
    '_UNICODE', 'UNICODE',
    '_WIN32_WINNT=0x0A00', 'WINVER=0x0A00',
    'NTDDI_VERSION=0x0A000010',
    'WIN32_LEAN_AND_MEAN'
)
if ($Configuration -eq 'Debug') { $defines += @('DBG=1','_DEBUG') } else { $defines += 'NDEBUG' }

#
# /MT, not /MD. A dynamically linked CRT makes the driver depend on
# VCRUNTIME140.dll and the api-ms-win-crt-* set, which means the VC
# redistributable has to be present before the driver will load - on a machine
# where a missing DLL surfaces as an opaque device-start failure in Device
# Manager rather than as anything naming the CRT. WDK driver projects link the
# CRT statically for the same reason.
#
$common = @('/nologo','/c','/W3','/GS','/Zi','/FS','/Gy','/Gw')
if ($Configuration -eq 'Release') { $common += @('/O2','/MT') } else { $common += @('/Od','/MTd') }

$sources = @('driver.c','hid.c','bridge.c','trace.c')
$objs = @()
$failed = $false

foreach ($s in $sources) {
    $obj = Join-Path $objDir ([IO.Path]::ChangeExtension($s,'obj'))
    $objs += $obj

    $argv = @($common)
    $argv += "/Fo$obj"
    $argv += "/Fd$objDir\okvhid.pdb"
    foreach ($d in $defines)  { $argv += "/D$d" }
    foreach ($i in $incDirs)  { $argv += "/I$i" }
    $argv += (Join-Path $src $s)

    $r = Invoke-Tool -Exe $clang.Source -Arguments $argv `
                     -LogPath (Join-Path $objDir "$s.log")
    $code = $r.Code
    $out  = $r.Output

    if ($code -ne 0) {
        $failed = $true
        Write-Host "    $s  FAILED" -ForegroundColor Red
        ($out -split "`r?`n") | Where-Object { $_ -match 'error' } | Select-Object -First 6 |
            ForEach-Object { Write-Host "      $($_.Trim())" -ForegroundColor DarkRed }
    } else {
        Good "$s"
        ($out -split "`r?`n") | Where-Object { $_ -match 'warning' } | Select-Object -First 3 |
            ForEach-Object { Write-Host "      $($_.Trim())" -ForegroundColor DarkYellow }
    }
}

if ($failed) { throw 'Compilation failed.' }

# ------------------------------------------------------------------- link
Say 'Linking okvhid.dll'

#
# Linked from inside the output directory, with relative names. lld-link
# refused absolute output paths here - "could not open ...okvhid.dll: no such
# file or directory", for a directory that demonstrably existed - and running
# it with the output directory as the working directory sidesteps it
# entirely. Not satisfying, but the objects and the result are identical.
#
# No /ENTRY either: WdfDriverStubUm supplies the DLL entry point and the
# framework bind glue, and naming one explicitly only overrides what the stub
# already set up correctly.
#
$linkArgs = @(
    '/DLL',
    '/NOLOGO',
    '/OUT:okvhid.dll',
    '/PDB:okvhid.pdb',
    '/DEBUG',
    '/MACHINE:X64',
    '/SUBSYSTEM:WINDOWS',
    # Discard unreferenced functions and fold identical ones. The static CRT
    # pulls in a great deal this driver never calls.
    '/OPT:REF',
    '/OPT:ICF'
)
# Inputs stay absolute. Only the OUTPUT path is the one lld-link objects to,
# which is why the link runs with $outDir as its working directory and names
# just okvhid.dll. (Absolute input paths have always been fine, and
# [IO.Path]::GetRelativePath is .NET Core only - it does not exist in Windows
# PowerShell 5.1.)
$linkArgs += $objs
$linkArgs += $wdfLib
# ntdll for DbgPrintEx, which WdfDriverStubUm references from its trace
# helpers. It is a native API rather than a Win32 one, so kernel32 does not
# have it and the omission shows up only at link time.
$linkArgs += @('ntdll.lib','kernel32.lib','advapi32.lib','ole32.lib',
               'oleaut32.lib','uuid.lib')

Push-Location $outDir
try {
    $r = Invoke-Tool -Exe $linker.Source -Arguments $linkArgs `
                     -LogPath (Join-Path $objDir 'link.log')
} finally { Pop-Location }
$linkCode = $r.Code
$out      = $r.Output

if ($linkCode -ne 0) {
    ($out -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 15 |
        ForEach-Object { Write-Host "    $($_.Trim())" -ForegroundColor Red }
    throw 'Link failed.'
}

#
# Move the link byproducts out of the package directory.
#
# Inf2Cat hashes the directory, so anything left here goes into okvhid.cat.
# The import library is meaningless for a driver (it exports nothing) and the
# PDB is not shipped; having either in the catalog means the package stops
# verifying the moment symbols are regenerated or cleaned away.
#
# Done as a move rather than by pointing /PDB and /IMPLIB elsewhere, because
# lld-link is already being coaxed with a working directory to accept its
# output path at all - see the note above - and adding two more absolute
# output paths invites the same argument.
#
foreach ($byproduct in @('okvhid.lib', 'okvhid.pdb', 'okvhid.exp')) {
    $p = Join-Path $outDir $byproduct
    if (Test-Path $p) { Move-Item $p (Join-Path $objDir $byproduct) -Force }
}

# ------------------------------------------------------------------- INF
#
# The INF is a template, not a finished file. $ARCH$ and $UMDFVERSION$ are
# tokens that MSBuild's driver targets resolve by running stampinf, and
# bypassing MSBuild means doing it here - otherwise InfVerif rejects the
# result with "Unresolved $ARCH$ token" and the package will not install.
#
# $WINDOWS NT$ in the Signature line is NOT a token; it is the literal string
# every INF carries, and stampinf leaves it alone.
#
# Any existing catalog is now invalid - it is a manifest of file hashes, and
# the DLL and INF just changed underneath it. Leaving it means the next
# install sees a package whose hashes do not match its catalog and rejects it
# as TAMPERED, and the only trace is one line in setupapi.dev.log:
#
#     !!! sig: Driver package INF file hash is not present in catalog file
#
# Windows then quietly declines to rank the driver, the devices fall back to
# the generic software-device INF, and nothing anywhere says "stale catalog".
# Deleting it here forces a re-sign rather than allowing a silent mismatch.
#
$staleCat = Join-Path $outDir 'okvhid.cat'
if (Test-Path $staleCat) {
    Remove-Item $staleCat -Force
    Warn 'removed the previous okvhid.cat - the package changed, so re-sign'
}

Say 'Stamping the INF'

$infOut = Join-Path $outDir 'okvhid.inf'
Copy-Item (Join-Path $src 'okvhid.inf') $infOut -Force

$stampinf = Get-ChildItem (Join-Path $repo 'vendor\wdk\c\bin') -Recurse -Filter 'stampinf.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1

# DriverVer has to move every build, and the date alone does not.
#
# pnputil dedupes on DriverVer. Two builds on the same day with the same
# version are the same package to it, and it says so - "Already exists in the
# system", "Added driver packages: 0" - and leaves the OLD okvhid.dll in the
# driver store. Everything downstream looks like a success: the INF is added,
# the devices are OK, and the driver that loads is the previous one. That is a
# genuinely expensive thing to debug, because the only symptom is new code not
# running.
#
# So the low words carry the build time. yyy is days since 2020, z is
# hour*100+minute, both inside the 65535 a version field allows, and both
# monotonic - a later build always outranks an earlier one, which is what
# makes `pnputil /add-driver /install` actually replace anything.
$now = Get-Date
$verY = [int]((New-TimeSpan -Start ([datetime]'2020-01-01') -End $now).Days)
$verZ = [int]($now.Hour * 100 + $now.Minute)
$driverVer = "1.0.$verY.$verZ"

if ($stampinf) {
    # -a architecture, -u UMDF version, -d date, -v version. The DriverVer
    # date is stamped as '*' so it tracks the build rather than drifting from
    # whatever was last hard-coded.
    $r = Invoke-Tool -Exe $stampinf.FullName `
        -Arguments @('-f', $infOut, '-a', 'amd64', '-u', "$UmdfVersion.0", '-d', '*', '-v', $driverVer) `
        -LogPath (Join-Path $objDir 'stampinf.log')
    if ($r.Code -ne 0) {
        Warn "stampinf exited $($r.Code):"
        ($r.Output -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 5 |
            ForEach-Object { Warn "  $($_.Trim())" }
    } else {
        Good "stamped: arch=amd64 umdf=$UmdfVersion.0 ver=$driverVer"
    }
} else {
    Warn 'stampinf not found; the INF still contains unresolved tokens and'
    Warn 'will fail InfVerif. Run scripts\fetch-wdk.ps1.'
}

# InfVerif is cheap and catches exactly the class of mistake that otherwise
# surfaces as a silent installation failure.
$infverif = Get-ChildItem (Join-Path $repo 'vendor\wdk\c\tools') -Recurse -Filter 'infverif.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1

if ($infverif) {
    $r = Invoke-Tool -Exe $infverif.FullName -Arguments @('/v', '/w', $infOut) `
                     -LogPath (Join-Path $objDir 'infverif.log')
    $text = $r.Output
    if ($text -match 'INF is VALID') {
        Good 'InfVerif: valid'
    } else {
        Warn 'InfVerif reported problems:'
        ($text -split "`r?`n") | Where-Object { $_ -match 'ERROR|WARNING' } | Select-Object -First 8 |
            ForEach-Object { Warn "  $($_.Trim())" }
    }
}

Say 'Built'
Get-ChildItem $outDir -File | Where-Object { $_.Extension -in '.dll','.inf','.pdb' } |
    ForEach-Object { Write-Host ("    {0,-14} {1,8:N0} bytes" -f $_.Name, $_.Length) }

Write-Host ''
Write-Host 'Next: .\sign.ps1 -Mode Test   (needs an elevated shell)' -ForegroundColor Green
