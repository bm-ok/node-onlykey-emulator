# libraries: an OnlyKey message on the vendor interface during an RSA operation is lost

**Patch:** `0019-fido2-handle_packets-takes-only-a-FIDO-report.patch`
**For:** trustcrypto/libraries `master` @ `fe9e293` (the pins ok-80e3ba0-fe9e293)
**Size:** 1 file, +8: `fido2/device.cpp` (`handle_packets()`).
**Order:** applies to `fe9e293` (`git am` clean), alone or with 0012-0018. Firmware only.
**Status:** staged on our builds (soft key and developer hard key). Not sent - the owner decides.
**Protocol:** unchanged - no new message, field or reply.

**Severity:** a request that never gets its answer. A host that asks for an RSA sign or decrypt over the WebAuthn
tunnel on the vendor interface (a desktop app, where browsers are not involved) is answered "pending" and polls for the
result - and the poll is taken by `handle_packets()` inside the RSA private-key operation and parsed as CTAPHID. The key
signs and stores the answer; the host waits out its timeout for a poll the key never read. Nothing is exposed. Any
OnlyKey message arriving on the vendor interface during an RSA private-key operation is lost the same way.

## 1. How it is broken

`RawHID.recv()` serves both interfaces, the FIDO endpoint first, and says which: `1` FIDO, `2` vendor
(OnlyKey-Firmware `usb_rawhid.c`). `handle_packets()` (fido2/device.cpp) hands every report it takes to
`ctaphid_handle_packet()`. It runs inside long operations: mbedtls `rsa.cpp` (`rsa_private()`) calls it between the
steps of every RSA private-key operation, so a FIDO host does not time out meanwhile. An OnlyKey message on the vendor
interface at that moment is not CTAPHID, and it is gone.

Found 2026-11-04 by an RSA-2048 sign over the vendor-interface tunnel, the sign paid by an Edge budget (no press): the
key's DEBUG console showed `handle_packets()` taking the 0xFD poll (vendor, 200 ms after the request) before
`Signature =`, then `Stored Data for FIDO Response 276`, and no further report until the 20 s wipe.

## 2. The fix

`handle_packets()` takes a report only when the FIDO endpoint has one - `RawHID.available()` counts that endpoint alone
(`usb_rawhid_available()`), and `recv()` serves it first - so a vendor report stays queued for `recvmsg()`, which takes
it once the operation is done. A FIDO frame a host sends on the vendor interface (the Android case `recvmsg()`
handles) waits for the operation's end too, rather than being read inside it.

## 3. Test

The emulator kit, side-loaded with the edge plugin: `edge: an RSA sign a budget pays answers over the vendor bridge,
as the desktop app asks it` (plugins/edge/tests/kit.test.js) - fails without this patch ("no answer in 30000 ms"),
passes with it.
