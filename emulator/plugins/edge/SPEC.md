# OnlyKey Edge: the spec

The rules OnlyKey Edge keeps, as the code keeps them. One line each. The key's half is in the soft
key's firmware plugin (`ok-rn/android/okemu/plugins/edge`), described byte by byte in
[WHITEPAPER.md](WHITEPAPER.md), in this folder beside the code; the host's half is `node-onlykey-lib/edge` and
the phone app ([APP.md](https://github.com/bm-ok/onlykey-edge/blob/main/edge/APP.md), [BLOCKS.md](BLOCKS.md)).
Rule numbers are stable: code comments cite them. A rule that was dropped keeps its number as a
tombstone.

## 1. In one paragraph

An AI agent uses an OnlyKey without having the key. **Budget or no go:** the person approves a
**budget** - what may be used, how many times, for how long - on the phone, then presses the key.
Inside it the key presses for the agent, one **use** at a time, each bound to the exact request
the agent announced (a **TX start**) and its **intent**. Every Edge record is a 64-byte **link**
in a hash chain only the key extends. Each use owes a **receipt**; until it is filed nothing
automatic happens. A budget whose last use is receipted ends itself. A **settle** is the way out
when receipts can't come: one press ends every live budget and marks the open uses for review.
Outside a budget, Edge pays for nothing and writes nothing.

## 2. The key's rules

| R | Rule |
|---|---|
| R1 | Only Edge's own records are linked: a budget opened (pressed), a budget ended (completed, revoked or settled), held, resumed, a budget use (self-press), a receipt, a settle, a loss, a continue. An ordinary press - approved, denied or timed out - and every FIDO2 press write nothing. |
| R2 | `genesis = SHA256("OKEDGE-GENESIS-v1" ‖ device_id)`; `head[n] = SHA256("OKEDGE-LINK-v1" ‖ head[n-1] ‖ link[n])`. |
| R3 | A link is 64 bytes: seq, op, decision, slot, flags, subject (32), grant_id, step, byte 46 (the scope that paid, or a grant-create's scope count), intent (47-62), version (63) = 1. Ops written: 1 sign, 2 decrypt, 6 grant-create, 7 grant-end, 8 receipt (a settle is a receipt), 11 loss, 13 hold, 14 resume, 16 continue. Flags: 0x01 pressed, 0x02 budget spent, 0x10 owes a receipt. |
| R4 | The record is saved inside the weld, before the operation's result is released. |
| R5 | No chain in flash: the latest link and the head are kept; the last 8 links are held in RAM for pickup; hosts keep the chain. |
| R6 | HEAD answers seq, head, the oldest pickable seq, the live budget ids, the held mask, whether a use is owed (0 or 1), and (byte 60) TX starts refused since power-up. PICKUP returns links with their heads and reveals. |
| R7 | A checkpoint is two signatures over `SHA256("OKEDGE-CKPT-v1" ‖ device_id ‖ seq ‖ head)`: P-256 with the Edge key `HKDF(0x28 ‖ device salt, K132, "onlykey/edge/v1")`, and ML-DSA-65 (FIPS 204, pure, empty context) with a key generated from the seed `HKDF(0x28 ‖ device salt, K132, "onlykey/edge/mldsa/v1")`. No other request reaches either key. A verifier requires both. PUBKEY_PQ (0x05) answers the ML-DSA public keys. |
| R8 | Every Edge request needs a PIN set, the key unlocked and out of config mode (else `EDGE:01` or no answer). |
| R9 | A wipe erases the Edge state; the next request draws a new salt (a new device id, a new genesis). No wipe link. |
| R10 | A budget opens only at a physical press, and never while a receipt is owed - checked when asked and again at the press. |
| R11 | A budget has 1-4 scopes (op, slot, cap ≥ 1); all caps together ≤ 1024 uses; each scope's cap is enforced on its own. |
| R11a | A scope on a derived code (201-203, 221-223) names one identity by its 32-byte label, staged with GRANT_LABEL just before; without it the budget is refused (`EDGE:03`). |
| R12 | Opening draws a seed, `G = H^n(seed)`, and links a grant-create whose subject commits to the scopes, the reason's hash, G, the lifetime and the labels; the reply carries a checkpoint over it. |
| R13 | A use runs without a press only after a TX start and only when a live budget pays it. It reveals `v_i = H^(n-i)(seed)` and links a self-press (budget spent, owes a receipt, the scope that paid). |
| R13a | `token = SHA256("OKEDGE-TX-v1" ‖ head ‖ subject ‖ intent)`, checked when the sign is primed: a request that is not the announced one is refused (`EDGE:1C`, no press, no link) and spends the TX start. A TX start is refused while owed (`0C`) or with nothing to pay (`0D`); refusals are counted. An announced request no budget can pay any more is an ordinary press; one primed to be paid that can no longer pay is refused (`0D`). Any link clears the TX start. |
| R13b | The intent is the first 16 bytes of `SHA256("OKEDGE-INTENT-v1" ‖ text)`; the token covers it and the use's link carries it. |
| R14 | A budget pays only for OKSIGN on slots 1-4, 101-116, 201-203, 221-223 and OKDECRYPT on slots 1-4, 101-116. Never FIDO2, config, backup, keys, PINs. |
| R15 | A budget ends: **completed** - the key ends it itself when its last use is receipted; **revoked** - GRANT_REVOKE, no press; **settled** - by a settle (R18). Each writes a grant-end link whose decision byte says which (1, 2, 3). Expiry, a lock and a reboot end it silently (budgets live in RAM). |
| R15a | Hold: no press, links a hold; a held budget pays nothing. Resume: a press, refused while owed, needs the verified head; links a resume. |
| R15b | A lifetime in minutes, 0 = 12 hours, counted from the press by the key's own clock, and committed to in the grant subject. |
| R15c | *Dropped: agent registration.* Sub-op 0x15 is not handled; op 15 is never reused. |
| R16 | Only budget uses owe a receipt. The key keeps one owed use (its seq and head) or none: nothing starts while one is owed. |
| R17 | *Dropped: folded into R16 and R18.* |
| R18 | While a receipt is owed: no TX start, no new budget, no resume. A **settle** (a press) ends every live budget first, each with its grant-end link, then links one receipt - code `0x8F` needs review, the press flag - whose subject `SHA256("OKEDGE-SETTLE-v1" ‖ the owed seq)` names the open use. More uses need a new budget. |
| R19 | *Not built:* composite pairs. |
| R20-R23 | *Dropped: peers and copy-store receipts.* |
| R24 | LOSS {from, to}, at a press: the person accepts a range of links nobody holds. One link; it pays no debt. `EDGE:12` for a bad range. |
| R25 | *Later: hardware.* |
| R26 | Every restore of a backup draws a new salt - a new device - and its first link is a **continue** naming the backup's chain, seq and head and carrying its debt, if any. The backup section (version 1) holds seq, head, the owed use (if any) and the device id, never the salt. |
| R27 | A host verifies before it approves: the phone's copy of the chain must verify, or Approve is off (`copy_unverified`). A copy verifies only when its links weld up to a newest checkpoint whose two signatures both verify (one hybrid anchor per copy); older checkpoints the copy keeps (seals, budget openings) carry the P-256 signature only. The key checks the head the host verified on GRANT_CREATE (6 bytes) and GRANT_RESUME (32), on arrival and again at the press (`EDGE:0B`). |
| R28 | One chain per physical device: the salt is drawn on first use and never leaves the device. Derived identities do not depend on it. |
| R29 | The owner key: `HKDF(K132, "onlykey/edge/owner/v1")` and its ML-DSA-65 twin (seed `HKDF(K132, "onlykey/edge/owner-mldsa/v1")`), no salt - the same on every device made from your OnlyKey. It signs only through `OKEDGE_CERTIFY`: a certification of a 32-byte subject the host built (a device's nametag, an agent identity) - the firmware never learns what the subject is. Both halves sign the device id, its P-256 checkpoint key, the hash of its ML-DSA checkpoint key, the approval (a press, or a budget's CERTIFY scope), the seq and the subject. Every certification is a link on the chain, written before it signs. `OKEDGE_PUBKEY {which = 1}` reads the owner public key, no press, nothing signed. The no-press owner statement ("No press, no link") was retired 2026-10-30 (emulator 3e7ded4). |
| R30 | Sync is the app's and the library's, never the key's ([BLOCKS.md](BLOCKS.md)). |
| R31 | The record is `OKEDGEv1`; a record of any other format is not read (the chain starts empty). A debug-only wipe (0x7E) exists in DEBUG builds only. |

## 3. The host's rules

| H | Rule |
|---|---|
| H1 | Budget requests come only from a Bluetooth-paired computer, inside its encrypted session; the pairing says who asks. |
| H2 | The phone asks for every press on its sheet: a budget's own sheet, or the press sheet showing what the firmware was handed (soft key only). A hard key never exposes that record: on USB the computer shows what it sent (the request's reason, scopes, uses, lifetime), asks y/N on its terminal, then the key's press opens the budget (B4, 2026-10-23). |
| H3 | The CLI prints what it sends before each press (the request's fingerprint) and sends nothing extra for the phone. |
| H4 | `onlykey-js edge exec` is the only way an agent's command signs under a budget: one TX start, one use, one receipt filed when it ends (OK or the failure's code). |
| H5 | Another device's log is held until you approve it, merged only when complete, and re-verified under that device's own key ([BLOCKS.md](BLOCKS.md)). |
| H6 | The testnet is a separate soft key with its own chain; the CLI's `--test-mode` and the phone refuse each other's chain. |
| H7 | The agent identities are a certified list in the identity bucket, store `edge-agents` (`edge-agents-test` on the testnet), one entry per label (node-onlykey-lib 0b41a57, `edge/src/agents.js`; Brad, 2026-10-30: "a plural multi identity section, like nametag, certified/signed/approved, named/labeled, so a agent can pick from a list, and it can just create new ones"; "sync-able in edge, not in the blockchain but in the edge bucket"; "no rename for agents, after certified"; "i dont want 2 agent ident with the same label"). Each is created at a press (the key certifies it, R29), never renamed, picked by label, and revoked into the archive, never deleted. Every entry is checked against the owner keys read from the key before it is listed as usable; an unverified one is never given to an agent. Today's single record becomes the first card, with the same labels and the certificate's own created time, so the derived gpg key and its fingerprint stay what GitHub already verifies. **Was** (2026-10-20 to 2026-10-30): one agent identity per net, kept on the phone with the chain (Brad, 2026-10-20: "edge should hold the identity (on the app side) with the block chain"; "it should be displayed in" the Edge Management drawer; "computer sets, phone keeps"). One record per net: the ssh label, the gpg user ID, the committer, the certificate's lifetime and the certificate itself (armored, fingerprint, creation time, the derived signing key). A paired computer sets it with `onlykey-js edge setup`, which makes the certificate there (two presses) and sends it; the phone shows it on a yellow Edge sheet and stores it only on Approve (a tap, no press). Edge Management shows it under "Agent identity". Every agent start reads it from the phone; no computer keeps its own copy, so a newly paired computer has the same identity and the same keys (Brad: "same identity, so i wont need to keep adding a bunch of keys to github"). The certificate is never remade at start; a derived key that does not match it stops the agent and names `edge setup`. A hard key has no phone: on USB the computer is the host (B4, 2026-10-23, node-onlykey-lib edge/cli/local-host.js) - it keeps the record in its bucket, per net, asks y/N on its own terminal for a SET, and checks the same derived key at start. |

## 4. Words

| Word | Meaning |
|---|---|
| budget | What the person approved: scopes, uses, lifetime. Live until completed, revoked, settled, expired, or the key locks. |
| use | One sign or decrypt a budget paid for, without a press. |
| link | One 64-byte record in the key's chain. |
| head | The hash over the whole chain so far; one value pins the history. |
| TX start | The agent's announcement of the one request it will make next, over the key's head. |
| intent | What a use is for, in words; its hash is in the use's link. |
| receipt | The agent's answer for a use: a one-byte code and the hash of a message ([RECEIPT-CODES.md](RECEIPT-CODES.md)). |
| settle | The press that ends every live budget and marks the open uses for review. |
| loss | The press that accepts links nobody holds. |
| checkpoint | The key's two signatures (P-256 and ML-DSA-65) over its seq and head. |
| continue | The first link of a restored device's chain, naming the chain it came from. |
| nametag | A device's name, certified by the owner key (R29). |
| block | The links between two seals, as canonical JSON ([BLOCKS.md](BLOCKS.md)). |

## 5. Acceptance

A daily agent work loop, measured against a baseline session transcript (7 "waiting on you: push" stops,
6 h 19 min waiting on the person). Each check is read from the chain or the transcript, not from the
agent's own word.

| # | Check | Pass |
|---|---|---|
| A1 | Approvals | One Yes + press for the work budget, one for the release budget; no other press while they cover the work |
| A2 | Stops | 0 "waiting on you: push" stops while the work budget has room |
| A3 | Waiting on the person | only the two approvals |
| A4 | Coverage | every push and signed commit is a use with its receipt; every receipt's message matches its hash; the phone's verdict is Verified |
| A5 | Release | the release signatures under the release budget, each receipted; the budget completes itself |
| A6 | Against the baseline | the day's pushes need 2 presses in all, not one or more per push |

**Must fail safely:**
- A plain `git push`, not through `edge exec`: no press is asked for, nothing reaches the key.
- A push after a skipped receipt: the TX start is refused, `receipt owed for #N`; nothing opens until a receipt, or a settle - which ends the budget.
- Hold from the phone: the next use is refused; Resume (a press) lets it go on.
- Another program signs between the agent's TX start and its sign: refused `EDGE:1C`, and the agent's start is spent. Never a free signature.
- The lifetime runs out mid-session: the next use is refused; a new budget is needed.
- A stale `--head`: refused.
- The budget used up: it completed itself; the next use needs a new budget.
- One budget's scopes never pay for another's slots.
- The soft key locks: every budget ends; the next use needs a new budget.
- A signer dies mid-stream: its use stays owed; a settle ends the budget and names the use; the retry needs a new budget.

Where these are tested: the plugin kit (`ok-rn/android/okemu/plugins/edge/tests/kit.test.js`, on
the emulator), the library's `edge/test/`, and the app's `__tests__/`.
