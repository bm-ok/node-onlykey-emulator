okvhid — the Windows HID driver
===============================

A UMDF 2 HID minidriver that presents the emulator's four HID interfaces to
Windows as real devices. It is the Windows counterpart of the UHID bridge:
`uhid-bridge.js` asks the Linux kernel to create HID devices, and on Windows
there is no such call, so the device has to be a driver.

```
  emulator (native addon)
        │  named pipe, \\.\pipe\okvhid-0..3
        ▼
  okvhid.dll  ← WUDFRd.sys ← mshidumdf.sys ← HIDCLASS.SYS
        │
  4 HID collections, 1D50:60FC, the emulator's own descriptors
        │
  WebAuthn / browser / python-onlykey
```

Nothing in here is emulator-specific beyond the descriptors it generates, and
nothing outside this directory is needed to build, sign or install it.

---

## Build

```
.\fetch-wdk.ps1          WDK headers, libs and tools from NuGet - no admin
.\build-direct.ps1       clang-cl + lld-link -> build\x64\Release\
```

`fetch-wdk.ps1` unpacks into `windows-driver\vendor\wdk\`, which is gitignored.
No Visual Studio workload and no WDK installer is required; the NuGet packages
carry everything, and clang-cl ships with Visual Studio's C++ tools.

`build-direct.ps1` regenerates `src\descriptors.h` from
`..\emulator\lib\hid-descriptors.js` on every run, so the descriptors Windows
enumerates cannot drift from the ones the UHID bridge and the gadget scripts
use. It also stamps the build time into `DriverVer`. `pnputil` decides whether
a package is new on that field alone, so stamping it is what makes each
rebuild install as a distinct version.

## Install

All three need an elevated shell.

```
.\sign.ps1 -Mode Test    generate a catalog, self-sign, trust it locally
.\install-driver.ps1     add to the driver store, create the four devices
.\uninstall-driver.ps1   remove the devices and the package
```

A self-signed certificate is all this package needs. It is an `.inf`, a `.cat`
and a user-mode `.dll` that loads into `WUDFHost` — `WUDFRd.sys` and
`mshidumdf.sys` below it are Microsoft's own — so PnP package verification is
the check it has to pass, and a certificate in `LocalMachine\Root` +
`LocalMachine\TrustedPublisher` satisfies it. `sign.ps1` installs it into
both; `.\uninstall-driver.ps1 -RemoveTestCertificate` takes it out.

Both install steps matter. Adding the driver to the store is what makes
Windows able to install it; the devices are root-enumerated, so
`install-driver.ps1` then creates them with `devgen`.

It finishes by reporting each interface twice — the PnP device, and its pipe:

```
Interface                 Device Pipe     State
hid.usb0 keyboard         OK     okvhid-0 listening
hid.usb1 FIDO2 / CTAP-HID OK     okvhid-1 listening
hid.usb2 vendor protocol  OK     okvhid-2 listening
hid.usb3 SEREMU console   OK     okvhid-3 listening
```

The two columns are independent, which is why they are reported side by side
rather than scored. `listening` is a pipe with a server and nothing attached;
it reads `in use` once the emulator connects, and both are healthy states.
`absent` next to a device that is `OK` means the driver installed but its pipe
thread never started, and a served pipe next to a device that is not there
means a pipe thread outlived its device.

### After a reboot, run install-driver.ps1 again

The driver package persists in the store; the devices do not. `devgen` creates
them at runtime under `SWD\DEVGEN`, and a restart returns them to phantoms —
`Get-PnpDevice -PresentOnly` finds none and there are no pipes.

Re-running `install-driver.ps1` is cheap once the package is signed and in the
store: it re-adds a package Windows already has and recreates the four
devices. No rebuild, no re-sign.

## Unplug and replug

```
.\hotplug.ps1 -Off                    unplug all four
.\hotplug.ps1                         plug back in
.\hotplug.ps1 -Interface fido -Cycle  yank CTAP-HID mid-ceremony
```

A pipe exists exactly as long as its device does, so this is a real removal
rather than a simulated one: the stack is torn down, the pipe closes, and every
application holding the collection sees it disappear. It is what `power.js`
does on Linux by unbinding the UDC.

---

## Ecosystem compatibility

The point of a HID driver rather than something simpler is that real clients
find the device through hidapi and identify it by fields only a real USB device
normally carries. On Linux this is exactly where the UHID bridge falls down -
hidapi reports manufacturer `''` and interface `-1` for a UHID device, which no
unmodified client can match, and it is why `gadget-bridge.js` exists.

This driver clears that bar. Measured with real hidapi, running
python-onlykey's own `client.py::_connect` selection:

```
1d50:60fc  serial='1000000000'  iface=-1  usage_page=0xffab  usage=0x0002
    manufacturer='CRYPTOTRUST'  product='ONLYKEY'
-> vendor branch selected, opened, device answered 'INITIALIZED'
```

Two caveats worth knowing before relying on it.

**`interface_number` is -1.** hidapi derives it from the `&MI_xx` component of
the device path, which only a real USB composite device has; these are
root-enumerated and have no such component. python-onlykey is unaffected
because its test is `usage_page == 0xffab **or** interface_number == 2` and the
usage page carries it — but a client that checks `interface_number` alone will
not find this device. That is the one respect in which this is less faithful
than the Linux gadget bridge, and it is structural rather than a bug to fix:
short of emulating a USB bus, nothing here can produce an `&MI_xx` path.

**The FIDO collection does not appear to unelevated callers.** Windows returns
ACCESS_DENIED on it for non-admin processes, so hidapi silently omits it from
`enumerate()`. A real security key behaves identically — it is evidence Windows
classified the device correctly, not a defect. Browsers reach it through the
WebAuthn service; a client wanting the raw FIDO interface needs elevation, on
this device and on real hardware alike.

## The transport, and why it is a pipe

The data path has to stay outside the PnP stack. A create on a device
interface goes to the **top** of the stack that registered it, which here is
HIDCLASS, and HIDCLASS accepts only opens of a HID collection — so once the
driver is correctly layered under it, the collection is the only way in and a
private `DeviceIoControl` channel cannot coexist with it.

A UMDF driver is an ordinary user-mode process, so it hosts a named pipe
instead, and Windows PnP has no opinion about that. The driver is the server:
WUDFHost runs as a service account, and a pipe created by the emulator would
carry a default ACL the driver is not in.

`src\public.h` is the contract. One pipe per interface, `\\.\pipe\okvhid-0..3`,
numbered by USB interface; a 12-byte header of magic, kind and length; and a
HELLO frame on connect so the client learns which interface it reached without
hard-coding anything.

**The pipe ACL is the security boundary of this design, and it is a wide one.**
`D:(A;;GA;;;AU)` — anything running as an authenticated user can feed reports
to a device Windows treats as a security key. That is the intended behaviour
for an emulator whose purpose is to be driven by a test harness, and it is a
concrete reason this driver should not be production-signed as it stands.

## Tracing

A UMDF driver has no console, its stdout goes nowhere, and OutputDebugString
lands in a session-0 buffer needing a debugger. So it writes a text log
instead, off unless asked:

```
reg add HKLM\SOFTWARE\okvhid /v Trace /t REG_DWORD /d 1 /f
```

Output goes to `%ProgramData%\okvhid\okvhid.log`, readable without elevation,
capped at 32 MB. The switch is read once per device when its pipe starts, so
toggling it means replugging (`.\hotplug.ps1 -Cycle`). Every IOCTL, every frame
read off the pipe, and every report handed to HIDCLASS is logged, which gives
a complete trace of a ceremony from the browser down to the wire.

## Layout

```
src/
  driver.c            entry point, device creation, interface selection
  hid.c               the HID minidriver surface - descriptors, reports
  bridge.c            the named pipe and the inbound report ring
  trace.c             the log file
  okvhid.h public.h   internal types; the pipe contract
  okvhid.inf          four root-enumerated devices, one per interface

gen-descriptors.js    src/descriptors.h from the emulator's own table
fetch-wdk.ps1         WDK from NuGet, no admin
build-direct.ps1      clang-cl + lld-link
sign.ps1              catalog and signature
install-driver.ps1 uninstall-driver.ps1 hotplug.ps1
```
