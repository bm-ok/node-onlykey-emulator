<#
.SYNOPSIS
    Catalog and sign the okvhid driver package.

.DESCRIPTION
    Generates the catalog, signs the package, and in Test mode establishes the
    trust that lets this machine install it.

    -Mode Test
        Generates (or reuses) a self-signed code-signing certificate, trusts
        it on THIS machine, and signs with it. That is everything the driver
        needs to install and run here. The package is an .inf, a .cat and a
        user-mode .dll that loads into WUDFHost, so PnP package verification
        is the check it has to pass, and a certificate in LocalMachine\Root
        and LocalMachine\TrustedPublisher satisfies it.

    -Mode Production
        Signs with a real certificate you supply, by thumbprint or PFX, and
        timestamps it. Nothing about the driver changes between the two modes;
        the same build output is signed either way. That is deliberate: when
        OnlyKey/CRYPTOTRUST signs this for release, it is this command with a
        different certificate, not a different driver.

        Production is what allows installing on machines that do not already
        trust your certificate. For that the certificate alone is not enough -
        the package goes through Microsoft attestation signing in Partner
        Center. See SIGNING.md.

.PARAMETER Mode
    Test or Production.

.PARAMETER PackageDir
    Directory holding okvhid.dll and okvhid.inf. Default is the newest
    build\<platform>\<config> directory.

.PARAMETER Thumbprint
    Production: thumbprint of a certificate in Cert:\CurrentUser\My.

.PARAMETER PfxPath
    Production: path to a .pfx instead of a store certificate.

.PARAMETER TimestampUrl
    RFC 3161 timestamp server. Timestamping is what keeps a signature valid
    after the certificate expires; without it the driver stops installing the
    day the cert lapses.

.EXAMPLE
    .\sign.ps1 -Mode Test
    .\sign.ps1 -Mode Production -Thumbprint ABC123...
#>
[CmdletBinding()]
param(
    [ValidateSet('Test', 'Production')] [string] $Mode = 'Test',
    [string] $PackageDir,
    [string] $Thumbprint,
    [string] $PfxPath,
    [string] $TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Say($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

$TestSubject = 'CN=OnlyKey VM Manager (Test Signing - NOT FOR RELEASE)'

# ---------------------------------------------------------------- package
if (-not $PackageDir) {
    $candidate = Get-ChildItem -Path (Join-Path $root 'build') -Directory -Recurse -ErrorAction SilentlyContinue |
                 Where-Object { Test-Path (Join-Path $_.FullName 'okvhid.inf') } |
                 Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $candidate) {
        throw 'No package directory found. Run .\build.ps1 first, or pass -PackageDir.'
    }
    $PackageDir = $candidate.FullName
}

if (-not (Test-Path (Join-Path $PackageDir 'okvhid.inf'))) {
    throw "okvhid.inf not found in $PackageDir"
}
Say "Package: $PackageDir"

# ------------------------------------------------------------------ tools
#
# inf2cat and signtool live in the WDK/SDK bin directory, which is not on PATH
# outside a build prompt. Search rather than require the prompt.
function Find-Tool($name) {
    $onPath = Get-Command $name -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    #
    # The fetched WDK comes first. signtool ships with the SDK and so is
    # usually in the system kit, but inf2cat is a WDK tool and will not be
    # there at all on a machine that only has the SDK - which is exactly the
    # machine scripts\fetch-wdk.ps1 exists for.
    #
    $roots = @(
        (Join-Path $PSScriptRoot 'vendor\wdk\c\bin'),
        (Join-Path $PSScriptRoot 'vendor\wdk\c\tools'),
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "${env:ProgramFiles}\Windows Kits\10\bin"
    ) | Where-Object { Test-Path $_ }

    foreach ($r in $roots) {
        $all = Get-ChildItem -Path $r -Recurse -Filter $name -ErrorAction SilentlyContinue
        if (-not $all) { continue }

        # Prefer x64, accept x86: Inf2Cat ships only as x86 and runs under
        # WOW64.
        $hit = $all | Where-Object { $_.FullName -match '\\x64\\' } |
               Sort-Object FullName -Descending | Select-Object -First 1
        if (-not $hit) {
            $hit = $all | Sort-Object FullName -Descending | Select-Object -First 1
        }
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$inf2cat  = Find-Tool 'inf2cat.exe'
$signtool = Find-Tool 'signtool.exe'

if (-not $inf2cat)  { throw 'inf2cat.exe not found. Install the WDK.' }
if (-not $signtool) { throw 'signtool.exe not found. Install the Windows SDK or WDK.' }

# --------------------------------------------------------------- catalog
#
# The .cat carries the signature for the whole package and is a manifest of
# the INF's and binary's hashes, so it is regenerated on every run to stay in
# step with them.
Say 'Generating catalog'

# 10_X64 covers Windows 10 and 11 on x64; ARM64 needs its own.
$osList = if ($PackageDir -match 'ARM64') { '10_NI_ARM64,10_VB_ARM64' } else { '10_X64' }

& $inf2cat /driver:"$PackageDir" /os:$osList /verbose
if ($LASTEXITCODE -ne 0) {
    throw "inf2cat failed with exit code $LASTEXITCODE. The INF is usually the cause - run InfVerif on it."
}

$cat = Join-Path $PackageDir 'okvhid.cat'
if (-not (Test-Path $cat)) { throw "inf2cat reported success but $cat does not exist." }

# ------------------------------------------------------------ certificate
$signArgs = @()

if ($Mode -eq 'Test') {
    Say 'Test signing'

    $cert = Get-ChildItem Cert:\CurrentUser\My |
            Where-Object { $_.Subject -eq $TestSubject -and $_.NotAfter -gt (Get-Date) } |
            Sort-Object NotAfter -Descending | Select-Object -First 1

    if ($null -eq $cert) {
        Write-Host "    creating a self-signed certificate"
        $cert = New-SelfSignedCertificate `
            -Type CodeSigningCert `
            -Subject $TestSubject `
            -CertStoreLocation Cert:\CurrentUser\My `
            -KeyUsage DigitalSignature `
            -KeyExportPolicy Exportable `
            -NotAfter (Get-Date).AddYears(3) `
            -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')
    }
    Write-Host "    thumbprint: $($cert.Thumbprint)"

    #
    # A self-signed certificate has to be trusted before Windows will accept a
    # package signed with it. Root makes the chain valid; TrustedPublisher is
    # what suppresses the "would you like to install this device software"
    # prompt during installation. Both are LocalMachine and both need admin.
    #
    $isAdmin = ([Security.Principal.WindowsPrincipal] `
                [Security.Principal.WindowsIdentity]::GetCurrent()
               ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($isAdmin) {
        Say 'Trusting the test certificate on this machine'
        $cerPath = Join-Path $root 'okvhid-test.cer'
        Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null
        Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
        Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
        Warn "installed to LocalMachine Root and TrustedPublisher ($cerPath)"
        Warn 'This is a trust anchor on this machine. Remove it with'
        Warn '.\uninstall-driver.ps1 -RemoveTestCertificate when you are done.'
    } else {
        Warn 'Not elevated - the certificate was NOT added to the machine trust'
        Warn 'stores, so installation will fail. Re-run this from an elevated'
        Warn 'PowerShell, or import okvhid-test.cer by hand.'
    }

    $signArgs = @('/fd', 'SHA256', '/sha1', $cert.Thumbprint)

} else {
    Say 'Production signing'

    if ($PfxPath) {
        if (-not (Test-Path $PfxPath)) { throw "PFX not found: $PfxPath" }
        $pw = Read-Host -AsSecureString -Prompt 'PFX password'
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
        $signArgs = @('/fd', 'SHA256', '/f', $PfxPath, '/p', $plain)
    }
    elseif ($Thumbprint) {
        $signArgs = @('/fd', 'SHA256', '/sha1', $Thumbprint)
    }
    else {
        throw 'Production mode needs -Thumbprint or -PfxPath. See SIGNING.md.'
    }

    $signArgs += @('/tr', $TimestampUrl, '/td', 'SHA256')
}

# ------------------------------------------------------------------- sign
Say 'Signing catalog and driver binary'

foreach ($file in @($cat, (Join-Path $PackageDir 'okvhid.dll'))) {
    if (-not (Test-Path $file)) { continue }
    & $signtool sign @signArgs $file
    if ($LASTEXITCODE -ne 0) { throw "signtool failed on $file (exit $LASTEXITCODE)" }
}

& $signtool verify /pa /v $cat

Write-Host ''
if ($Mode -eq 'Test') {
    Write-Host 'Self-signed, and trusted on this machine.' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Next:  .\install-driver.ps1   (elevated)'
} else {
    Write-Host 'Signed with a production certificate.' -ForegroundColor Green
    Write-Host 'Installing without warnings on other machines also needs'
    Write-Host 'Microsoft attestation signing - see SIGNING.md.'
}
