# libraries: a request cut off before its final packet leaves the tunnel's duplicate mark set, and the next page's requests are dropped

**Patch:** `0017-fido2-a-tunnel-connect-clears-the-duplicate-mark-of-an-unfinished-request.patch`
**For:** trustcrypto/libraries `master` @ `fe9e293` (the pins ok-80e3ba0-fe9e293)
**Size:** 1 file, +4: `fido2/ok_extension.cpp` (`bridge_to_onlykey()`, the `OKCONNECT` branch).
**Order:** applies to `fe9e293` (`git am` clean), alone or after 0012, 0013, 0015 and 0016. Firmware only.
**Status:** staged on our builds (soft key and developer hard key). Not sent - the maintainer gets it when Brad says.
**Protocol:** unchanged - no new message, field or reply. Only when a remembered packet number is forgotten changes.

**Severity:** medium for the web apps on Windows: after a cancelled request, a reloaded page's requests fail until its
packet numbers climb past the old one. Nothing is exposed - the dropped requests are answered with an empty success.

---

## 1. How it is broken

Through the WebAuthn tunnel the firmware drops a request packet whose `opt3` is not above the last one it took
(`last_request_opt3`, added in 3.1.0 for Windows 10 1903, which sent every request twice), answering it with an empty
success. The mark is cleared in one place: when a request's final packet is handled (`if (opt2) last_request_opt3 = 0`).

A request that never reaches its final packet leaves the mark set: the browser refused the next ceremony (on Windows
any key press dismisses the security prompt and cancels it), the page was closed or reloaded, the host gave up. A host
numbers its packets from 1 again when it starts (the lib's counter lives with the page; the original web app restarts
its numbering after each final packet), so its next requests are dropped until their numbers pass the old mark.

3.0.4 kept this mark in `packet_buffer_details[3]`, which `wipetasks()` cleared; 3.1.0's `last_request_opt3` is static
in `ok_extension.cpp` and nothing else clears it.

The symptom was measured on a developer hard key (blue-key: 3.1.0 @ fe9e293 + 0012 + 0013 + 0015 + 0016 + plugins,
DEBUG) in the ok-edge web app in Chrome on Windows 11, with the key's DEBUG console logged beside the page's: a reloaded
page's reads were answered `CTAP1_SUCCESS` with no data - the console shows the packet opened ("transit open",
"Received FIDO2 request to send data to OnlyKey") and nothing staged - several times in a row, then worked once the
page's numbers passed the mark. There the mark was left by a refused derive in our derive_secret plugin, whose refusal
returned before the loop's end (fixed in the plugin); the cut-off request this patch covers leaves the same mark, and
is what the test below reproduces on 3.1.0 itself.

## 2. The fix

Every `OKCONNECT` (a tunnel connect or a derive) makes a new transit key before anything else, so no packet sealed
before it can continue a request. It now clears `last_request_opt3` with it. A repeated packet inside one request is
still dropped, as before; a Windows duplicate of the connect itself arrives before the request's first packet.

## 3. The test

`tests/connect-clears-duplicate-mark.test.js` (standalone, run by the kit on a soft key built with the fixes to judge):
page A connects and sends a 1152-byte request at slot 128 numbered from 200; the browser refuses its second ceremony,
so the key has taken packet 200 only. Page B numbers from 1, connects and reads an agent public key (one packet, no
press). 3.1.0: the read is dropped - FAIL. With 0017: it is answered - PASS. (The agent key read is let through the
tunnel by the ctap_bridge plugin, which the test's soft key is built with.)

## 4. Old software

Nothing an older host sends changes meaning: a connect already discarded the old transit key, so a packet from before
it could not complete a request anyway. The maintainer's 3.1.0 apps (onlykey.github.io / apps.crp.to, the desktop
OnlyKey-App, the python tools) send nothing new and see nothing new - they only stop losing requests after a cancel.
To be checked against them before it is offered.
