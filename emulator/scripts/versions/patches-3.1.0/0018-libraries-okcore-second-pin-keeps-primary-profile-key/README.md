# libraries: a second-profile PIN added in config mode leaves the primary profile's keys unreadable

**Patch:** `0018-okcore-a-second-PIN-added-in-config-mode-keeps-the-profile-key-readable.patch`
**For:** trustcrypto/libraries `master` @ `fe9e293` (the pins ok-80e3ba0-fe9e293)
**Size:** 1 file, +6 -1: `onlykey/okcore.cpp` (`okcore_flashset_2ndpinhashpublic()`).
**Order:** applies to `fe9e293` (`git am` clean), alone or after 0012, 0013, 0015, 0016 and 0017. Firmware only.
**Status:** staged on our builds (soft key and developer hard key). Not sent - the maintainer gets it when Brad says.
**Protocol:** unchanged - no new message, field or reply. Only the second-profile mode byte is written in one more case.

**Severity:** high for anyone it reaches. A key set up with its primary PIN alone, given a second-profile PIN later in
config mode, keeps unlocking with its primary PIN - and from then on decrypts everything under the profile key as
something else: its slots, stored keys and derived keys, and its FIDO2 state (the PIN retries with it), so FIDO2 answers
PIN_BLOCKED - security-key logins stop working. Nothing says why. Getting back needs a backup. Nothing is exposed to
anyone else: it is lost access, not leaked keys.

**Not new in 3.1.0.** The code is the same in 3.0.4 (3.1.0 only reformatted it). It came with the profile key in
`527113d` "support for PIN changing" (2019-09-12); `d285d8b` "testing 2.1.2" (2021-11-22) narrowed the nonce2 change to
encrypted second profiles; `eb25290` "OnlyKey firmware 3.1.0 libraries" reformatted the function. Every release since
2.1.0 carries it.

---

## 1. How it is broken

One profile key encrypts the slots and keys of both profiles (`profilekey`, the AES-GCM key of `okcrypto_aes_gcm_*`).
It is stored in flash wrapped under

    SHA256(nonce2 (EEPROM) | chip ID[0..16] | shared secret | nonce (flash))

and the shared secret an unlock uses (`Password::profile1hashevaluate()`, password.cpp) is chosen by the second-profile
mode byte:

- `STDPROFILE2` (two profiles): Curve25519(primary PIN key, second PIN's public key)
- any other value (one profile): Curve25519(primary PIN key, primary PIN's public key)

`okcore_flashset_2ndpinhashpublic()` - every time a second PIN is set on an encrypted second profile - re-wraps the
profile key under the two-PIN secret (`Curve25519::eval(secret, ptr, p1hash)`, then `okcore_flashset_profilekey()`),
but writes `STDPROFILE2` only `if (!initcheck)`: while the key is being set up for the first time.

On a key set up with its primary PIN alone, the mode byte is not `STDPROFILE2`. A second PIN added later in config mode
re-wraps the profile key with the two-PIN secret and leaves the mode as it was. The next unlock with the primary PIN:

- the PIN check passes - it compares hashes of the PIN's public key and never touches the profile key;
- the profile key is unwrapped with the one-profile secret, which is not the one it was wrapped with
  (`okcrypto_aes_gcm_decrypt2(..., true)` gives bytes, not an error);
- every slot, stored key and derived key is decrypted with those bytes - and so is the FIDO2 auth state
  (`ctap_flash()` mode 3, okcore.cpp), whose garbage PIN retries make FIDO2 answer `CTAP2_ERR_PIN_BLOCKED`.

Seen on a soft key on our box (3.1.0 @ fe9e293 + plugins): the primary PIN unlocked it each time, and the identity
derived from its derivation key changed with each second-PIN set (9da6d2e711b9 -> ec9c61da5839 -> 3bafe0d00eef). The
key's mode byte read 0 (`STDPROFILE1`) with a second PIN set.

## 2. The fix

Record `STDPROFILE2` whenever a second PIN is set on an encrypted second profile, not only at first setup - before
the re-wrap, so the next unlock picks the secret the profile key was wrapped with. A first setup writes the same value
as before; a non-encrypted second profile (`NONENCRYPTEDPROFILE`) is not touched.

## 3. The test

`tests/second-pin-keeps-primary-keys.test.js` (standalone, run by the kit on a soft key built with the fixes to judge,
DEBUG): a blank key gets its primary PIN only, restarts, unlocks and derives a P-256 public key (`DERIVE_PUBLIC_KEY`
from slot 128's key - public data, no press); then config mode, the second-profile PIN set, a restart, the primary PIN
and the same derive. 3.1.0: the derive is refused `PIN_BLOCKED` (or, where FIDO2 still answers, derives a different
key) - FAIL. With 0018: the same key - PASS.

    OKEMU_ROOT=<emulator built with the fixes to judge> node bin/okt.js run tests/second-pin-keeps-primary-keys.test.js

## 4. Old software and keys already hit

Nothing a host sends changes meaning. The maintainer's 3.1.0 apps (onlykey.github.io / apps.crp.to, the desktop
OnlyKey-App, the python tools) set the second PIN with the same messages and see nothing new.

A key already hit keeps its mode byte at the one-profile value with a profile key wrapped under the two-PIN secret.
After 0018, setting the second PIN again in config mode records `STDPROFILE2` - but the profile key it re-wraps is the
wrong one read at that unlock, so its old contents stay lost; a restore from backup brings them back.

## 5. Results

Two DEBUG soft keys built from one emulator commit (`3b60b55`), the test run on each by the kit's emulated adapter
(`results/`):

| build | derived key before | after the second PIN, config mode, restart | test |
|---|---|---|---|
| 3.1.0 as published (`fixes []`) | `043cf81c02c498a2...` | the derive refused `CTAP2_ERR_PIN_BLOCKED` | **FAIL** (`3.1.0-released.log`) |
| 3.1.0 + 0018 (`fixes ["0018"]`) | `04f439ab5ad2267a...` | `04f439ab5ad2267a...` - the same key | **PASS** (`3.1.0-with-0018.log`) |

`results/proof.log` is the run that built both and ran the test on each.
