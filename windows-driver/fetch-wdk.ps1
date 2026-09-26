<#
.SYNOPSIS
    Fetch the WDK headers and libraries from NuGet, without administrator.

.DESCRIPTION
    The WDK normally installs as a Visual Studio extension and needs an
    elevated installer. Microsoft also publishes it as NuGet packages, which
    are ordinary zip files - so the headers, libraries and tools can be
    unpacked into vendor\ and used to build a driver on a machine where you
    cannot elevate, or in CI.

    What this does NOT give you is the MSBuild driver targets
    (WindowsDriver.Common.targets) that a .vcxproj expects. windows-driver
    therefore builds through build.ps1's direct clang-cl path rather than
    through MSBuild when the WDK came from here. That is a build-only
    limitation; the resulting binary is the same.

    Everything lands in vendor\wdk\, which is gitignored.

.PARAMETER Version
    WDK package version. Defaults to the newest stable (non-preview).

.PARAMETER Force
    Re-download even if vendor\wdk already exists.

.EXAMPLE
    .\scripts\fetch-wdk.ps1
#>
[CmdletBinding()]
param(
    [string] $Version,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo    = $PSScriptRoot
$wdkRoot = Join-Path $repo 'vendor\wdk'

function Say($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Good($m) { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

# The driver needs both: WDK.x64 carries the WDF headers and link libraries,
# SDK.CPP.x64 carries the um/shared headers the WDK ones include.
$packages = @('Microsoft.Windows.WDK.x64', 'Microsoft.Windows.SDK.CPP.x64')

if ((Test-Path $wdkRoot) -and -not $Force) {
    Say "Already present: $wdkRoot"
    Write-Host '    Pass -Force to re-download.'
    return
}

if (-not $Version) {
    Say 'Resolving newest stable WDK package'
    $idx = Invoke-RestMethod 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.wdk.x64/index.json' -UseBasicParsing
    # Exclude prereleases: anything with a hyphen in the version.
    $Version = $idx.versions | Where-Object { $_ -notmatch '-' } | Select-Object -Last 1
    if (-not $Version) { throw 'Could not resolve a stable WDK version.' }
}
Write-Host "    version: $Version"

New-Item -ItemType Directory -Force -Path $wdkRoot | Out-Null
$tmp = Join-Path $env:TEMP "okvhid-wdk-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    foreach ($pkg in $packages) {
        $lower = $pkg.ToLowerInvariant()
        $url   = "https://api.nuget.org/v3-flatcontainer/$lower/$Version/$lower.$Version.nupkg"
        $nupkg = Join-Path $tmp "$lower.zip"

        Say "Downloading $pkg $Version"
        # The progress bar makes Invoke-WebRequest dramatically slower on
        # large files in Windows PowerShell.
        $prev = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try { Invoke-WebRequest -Uri $url -OutFile $nupkg -UseBasicParsing }
        finally { $ProgressPreference = $prev }

        $size = [math]::Round((Get-Item $nupkg).Length / 1MB, 1)
        Write-Host "    ${size}MB"

        Say "Extracting $pkg"
        Expand-Archive -Path $nupkg -DestinationPath $wdkRoot -Force
        Remove-Item $nupkg -Force
    }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# --------------------------------------------------------------- report
Say 'What landed'

$found = @{}
foreach ($probe in @(
    @{ Name = 'UMDF headers';  Glob = 'c\Include\wdf\umdf\2*' },
    @{ Name = 'UMDF libs';     Glob = 'c\Lib\wdf\umdf\x64\2*' },
    @{ Name = 'km headers';    Glob = 'c\Include\*\km' },
    @{ Name = 'shared headers';Glob = 'c\Include\*\shared' },
    @{ Name = 'um headers';    Glob = 'c\Include\*\um' },
    @{ Name = 'um libs x64';   Glob = 'c\Lib\*\um\x64' }
)) {
    $hit = Get-ChildItem -Path (Join-Path $wdkRoot $probe.Glob) -ErrorAction SilentlyContinue |
           Select-Object -First 1
    if ($hit) { Good "$($probe.Name): $($hit.FullName.Substring($wdkRoot.Length + 1))"; $found[$probe.Name] = $hit.FullName }
    else { Warn "$($probe.Name): NOT FOUND" }
}

Write-Host ''
if ($found.Count -ge 4) {
    Good 'Usable. Build with:'
    Write-Host "    cd windows-driver; .\build.ps1"
} else {
    Warn 'The package layout may have changed. Look under vendor\wdk and'
    Warn 'point build.ps1 at the right directories by hand.'
}
