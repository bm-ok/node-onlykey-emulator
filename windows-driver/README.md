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
carry everything, and clang-cl ships with Visual Studio's C++ tools. Run it
from any PowerShell: when the MSVC environment is not already loaded,
`build-direct.ps1` finds Visual Studio with `vswhere` and loads `vcvars64.bat`
itself.

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

**If the key was unplugged when Windows went down, run `.\hotplug.ps1` too.**
`hotplug.ps1 -Off` disables a device where it can, and a disable is a saved
setting, not a state: it survives the restart. `install-driver.ps1` then shows
those devices as `Error (problem 22)` - problem 22 is "disabled" - with no
pipe. `hotplug.ps1` (plug in) enables them.

## Unplug and replug

```
.\hotplug.ps1 -Off                    unplug all four
.\hotplug.ps1                         plug back in
.\hotplug.ps1 -Interface fido -Cycle  yank CTAP-HID mid-ceremony
```

A pipe exists exactly as long as its device is present - started in
`EvtDevicePrepareHardware`, stopped in `EvtDeviceReleaseHardware` - so this is
a real removal rather than a simulated one: the stack is torn down, the pipe
closes, and every application holding the collection sees it disappear. It is
what `power.js` does on Linux by unbinding the UDC.

(It used to be stopped only at object cleanup, which waits for every handle to
close. An app holding the collection then kept the pipe served after the
device had gone, and the next device for that interface could not take its
own name.)

### An app can veto `hotplug.ps1`. A pulled cable cannot be vetoed.

`hotplug.ps1` removes devices the orderly way, and an orderly removal asks
first: any application holding a collection open may refuse. **The OnlyKey App
does**, for the vendor collection - Kernel-PnP logs it as event 225, "stopped
the removal". The device then never goes, its pipe stays served, and on
"plug in" no new device arrives, so the App sees the key leave and never come
back (measured 2026-09-26).

A real USB cable pull is a *surprise* removal, and nothing can veto that. So
the emulator GUI's **Unplug** pulls the cable first: the emulator sends every
device an `OKVHID_FRAME_UNPLUG` (see `src\public.h`), and the driver fails its
own device with `WdfDeviceSetFailed(..., WdfDeviceFailedNoRestart)` - a
surprise removal. Only then does it stop the emulator and run
`hotplug.ps1 -Off`, which now just clears the dead device nodes. Plug in runs
`hotplug.ps1` and, when it has finished, starts the emulator.

Measured with the OnlyKey App open: all four devices removed, vendor included,
no veto event, all four back on plug in and the App shows the key again.
`hotplug.ps1 -Off` run **by itself** is still the orderly, vetoable kind - use
the GUI, or close the apps holding the key first.

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
hard-coding anything. Frames: HELLO (driver to emulator, once), INPUT
(emulator to driver, a report), OUTPUT and FEATURE (driver to emulator), and
UNPLUG (emulator to driver, no payload: remove this device - see
[Unplug and replug](#unplug-and-replug)).

**The pipe ACL is the security boundary of this design.** Whoever can open
these pipes can feed reports to a device Windows treats as a security key. It
used to be `D:(A;;GA;;;AU)` — every authenticated user on the machine — because
the driver runs as a service account and cannot know which user owns the key.

Now the installer tells it. `install-driver.ps1` records the SID of the user
signed in to the desktop (not the elevating account; `-PipeUser` overrides)
under `HKLM\SOFTWARE\okvhid\PipeUser`, and each pipe is created with
`D:P(A;;GA;;;SY)(A;;GA;;;<SID>)` — SYSTEM and that one user, protected against
inheritance. **If the value is missing or not a SID, the pipe fails closed**
to SYSTEM only: the emulator cannot attach, the trace says
`pipe access: no valid PipeUser - SYSTEM only`, and the install table shows
`access denied`. Re-run `install-driver.ps1` to fix it. `uninstall-driver.ps1`
removes the record.

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

The pipe's lifecycle is logged too, and that is where an unplug is read.
Lines are tagged by interface, `[0]` keyboard to `[3]` SEREMU:

```
[2] unplug frame: failing the device for surprise removal
[2] pipe stop: thread exited, pipe closed
[2] pipe start
[2] accepted; hello sent (in=64 out=64)
```

An interface that shows no `pipe stop` at an unplug was never torn down. A
`pipe stop: thread did not exit in 3 s - abandoned` means its thread wedged;
its pipe name is reclaimed regardless, so the next device can still start.

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
