# firmware: the first answer after an unlock waits in the wrong USB slot

**Patch:** `0020-usb_dev-wipe_usb_buffer-sends-the-next-packet-to-the-slot-the-controller-waits-on.patch`
**For:** trustcrypto/OnlyKey-Firmware `master` @ `80e3ba0` (the pins ok-80e3ba0-fe9e293)
**Size:** 1 file, +16 -2: `usb_dev.c` (`wipe_usb_buffer()`, its `tx_state` mapping).
**Order:** applies to `80e3ba0` (`git am` clean), alone or with 0012-0019 (those are in `libraries`). Firmware only.
**Status:** staged on our developer hard keys. A hard key's code only (`HARDKEY`): the soft key's USB is the emulator's
own (`core/okemu_usb.cpp`), so its stage leaves this out. Not sent - the owner decides.
**Protocol:** unchanged - no new message, field or reply.

**Severity:** a request that never gets its answer, and the next one reads the wrong answer. Any host that talks to the
key around its unlock on the vendor interface (a desktop app checking the key the moment it unlocks) can lose the first
answer after it: the host waits out its timeout, then its next request takes the lost answer as its own - over the
WebAuthn tunnel's transit key, a reply that "failed authentication". Nothing is exposed. Seen by the owner on his own key
on Windows, twice in a day: the idle lockout restarted the key, he unlocked it later, and the desktop app's first reads
failed until a third try.

## 1. How it is broken

The USB controller (Kinetis) keeps two buffer descriptors per endpoint direction, even and odd, and its own pointer to
the one it sends next; `usb_dev.c` keeps a matching `tx_state` per endpoint (which slot is armed, which is next). The
controller's pointer moves only when the host takes a packet, or on a bus reset (`USB_CTL_ODDRST`).

At an unlock, `OnlyKey.ino` answers the messages waiting for 200 ms, then calls `wipe_usb_buffer()` ("Wipe old
responses"). The wipe frees every packet the controller still owns - one armed that the host has not taken yet - and
resets `tx_state` with the mapping copied from `SET_CONFIGURATION`: `EVEN_FREE` -> `BOTH_FREE_EVEN_FIRST`, `ODD_FREE` ->
`BOTH_FREE_ODD_FIRST`. For a freed packet that is the wrong way round. `EVEN_FREE` means the odd slot was armed, and the
controller still waits on the odd slot; the mapping sends the next packet to the even one. It is never sent until the
packet after it fills the odd slot - then both go, the older one second, and the host reads it as the reply to its next
request.

## 2. The fix

The freed packet's slot is the next one: `ODD_FREE` (even armed) -> `BOTH_FREE_EVEN_FIRST`, `EVEN_FREE` (odd armed) ->
`BOTH_FREE_ODD_FIRST`; the two `NONE_FREE_*` cases were already right. That slot also carries the data toggle the host
expects, since the host never received the freed packet. `SET_CONFIGURATION`'s own copy is left as it is (the host
resets its toggles there).

## 3. Found, and the test

2026-11-04, blue-key (a DEBUG 3.1.0 developer key, patches 0012-0019) on the box, `run.js rehearse --app desktop@box
lockout-unlock` (ok-edge): logged in, the key restarted off the USB as the idle lockout does, unlocked, the app's
identity read - "vendor-bridge: no answer in 30000 ms", then "transit v2 message failed authentication", every time.
The desktop's main process heard no vendor report for 30-42 s, then the lost answer 0.9 s after its next write. A DEBUG
line in vendor_bridge printed the endpoint's two descriptors (emulator plugins/vendor_bridge): before the answer both 0
(the wipe's), after it the even slot `0x88` (BDT_OWN | DATA0) - still owned 30 s later at the next request - then the odd
slot filled (`0xC8`) and both were taken within a millisecond (`0x24`, `0x64`).

The test is the same rehearsal on a key with this patch: the first read after the unlock answers.
