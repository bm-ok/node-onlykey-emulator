# libraries: X25519 scalars are used without RFC 7748 clamping

**Patch:** `0014-okcrypto-clamp-X25519-scalars-RFC-7748.patch`
**For:** trustcrypto/libraries `master` @ `fe9e293` (the pins ok-80e3ba0-fe9e293)
**Size:** 1 file, +15 / -2: `onlykey/okcrypto.cpp` (`okcrypto_shared_secret()` and `okcrypto_compute_pubkey()`, the
X25519 cases).
**Order:** applies to `fe9e293` alone (`git am` clean). Firmware only.
**Status:** SKIPPED - the maintainer declined it on 2026-10-29: "We aren't going to change this as it changes peoples
keys" (the `SKIPPED` file beside this). Kept as the record of the finding and its fix; never staged on our builds (the
`HOLD` file), never proposed again. Sent 2026-10-28 as a decision package; it changes existing keys (section 3).
**Write-up:** the finding in full, in the workspace: `FINDING-x25519-scalar-not-clamped.md`, with
`FINDING-x25519/x25519_check.py` (the reproduction).

**Severity:** low. The keys work and stay consistent with themselves.

---

## 1. How it is broken

The X25519 public key (`okcrypto_compute_pubkey()`) and shared secret (`okcrypto_shared_secret()`) pass the stored
32-byte scalar straight to `Curve25519::eval()`, which does not clamp. RFC 7748 X25519 always clamps the scalar first:
clear the 3 low bits, clear the top bit, set bit 254. So the keys are not standard X25519: another implementation given
the same private key computes a different public key and shared secret. And they lack what clamping protects against
(the low bits keep a small-subgroup component out of the result; the fixed top bits keep the ladder's length constant).

## 2. The fix

Both places clamp a copy of the scalar, use it, and wipe it:

```c
uint8_t s[32];
memcpy(s, ecc_private_key, 32);
s[0] &= 0xF8;
s[31] = (s[31] & 0x7F) | 0x40;
Curve25519::eval(secret, s, pub);   /* okcrypto_compute_pubkey: Curve25519::eval(ecc_public_key, s, 0) */
memset(s, 0, sizeof(s));
```

The stored key is not changed. In `okcrypto_shared_secret()` the all-zero check `fe9e293` added after the eval stays.

## 3. The catch: existing keys change

Clamping changes the public key of about 15 in 16 existing X25519 keys (those whose stored scalar is not already in
clamped form). Anything already encrypted to such a key stops decrypting with the new firmware:

- old GPG messages to an OnlyKey cv25519 subkey;
- data sealed to an agent-derived X25519 key;
- published agent keys.

So it needs a migration plan, for example:

- **clamp only new keys:** agent derivation v2 and newly generated or loaded slot keys, keeping v1-derived keys as they
  are (documented as legacy); or
- **clamp everywhere** in a release whose notes tell users to re-export their GPG/agent public keys and to decrypt old
  data with the previous firmware first.

## 4. The test

`x25519_check.py` (python-onlykey client): the RFC 7748 §6.1 test vectors loaded into ECC slots; the published public
keys and the ECDH result with Bob's RFC public key compared with the RFC's. Before the fix a scalar not already in
clamped form gives a non-RFC public key and shared secret; after it, the RFC values. A key already in clamped form is
the same before and after.

**Measured on one existing key (2026-10-26):** the kit's key made on `fe9e293` + 0012 + 0013, then run on the same build
plus this patch - the ctap_bridge kit test, which makes ok-edge's bucket key over the WebAuthn tunnel exactly as the
web app does:

| | without 0014 | with 0014 |
|---|---|---|
| bucket identity (agent Ed25519, label "") | `64030f2f7d5a` | `64030f2f7d5a` - same |
| agent X25519 public key (label `onlykey-bucket/key`) | `dfedbf1c1e52fb39…` | `e4a0139a7f4a89a6…` - changed |
| bucket key (HKDF of the agent X25519 ECDH) | `12507ede06065f61…` | `fed84f0076578261…` - changed |

So, as section 3 says, an existing agent-derived X25519 key changes with this patch, and so does anything made from
it. For our apps: a device that makes its bucket key after the upgrade gets another one than the devices that made
theirs before (each keeps the one it made), so their room frame keys differ and they cannot read each other's frames;
anything sealed to an agent X25519 key before the upgrade does not open after it. Ed25519 (the bucket identity, every
signature) is untouched.

Not sent: it needs the maintainer's migration plan, and ours would need a bucket key that does not move with it.
