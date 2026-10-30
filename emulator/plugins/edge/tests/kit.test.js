'use strict';
/*
 * edge's emulator tests (the onlykey-testing kit), SIDE-LOADED from this folder
 * by 08-plugins/01-softkey-plugins.test.js when the emulator was built with
 * OKEMU_PLUGINS=edge.
 *
 * The firmware is a notary (DESIGN.md section 0); the truth is the LIBRARY's
 * reading of what it writes (node-onlykey-lib/edge, through ctx.requireLib -
 * the kit's own pinned lib): every link, weld, budget signature, reveal,
 * receipt, settle and checkpoint must check out there. The rules are
 * SPEC.md's; verification row 5 lists what these prove.
 *
 * Only budget uses owe a receipt (R16, 2026-10-06: an ordinary press is not Edge and
 * writes no link) and nothing automatic happens while
 * one is owed (R18), so a test that opens a budget first clears what earlier
 * tests left owed - with a pressed SETTLE, the same way out a person has.
 *
 * Everything from the kit comes through ctx: IFACE, okmsg, PINS, requireLib.
 */
const crypto = require('crypto');

const OKEDGE = 0x80 | 0x78;
const HEAD = 0x01;
const PICKUP = 0x02;
const RETIRED_CHECKPOINT = 0x03; /* answers as unknown: the key confirms only a head a host proves */
const PROVE_HEAD = 0x09; /* {seq u32, head 32}: on a match, seq . head, then both checkpoint signatures */
const PUBKEY = 0x04;
const PUBKEY_PQ = 0x05; /* {which: 0 checkpoint key, 1 owner key}: an ML-DSA-65 public key */
/* ML-DSA-65 sizes and their 64-byte reports */
const PQ_PK = 1952;
const PQ_SIG = 3309;
const PQ_PK_REPORTS = Math.ceil(PQ_PK / 64);
const PQ_SIG_REPORTS = Math.ceil(PQ_SIG / 64);
const RETIRED_STATEMENT = 0x06; /* the no-press owner statement: answers as an unknown request */
const CERTIFY = 0x08;    /* {subject 32}, a press (or a budget's CERTIFY scope): a link, then approval . seq . subject, owner key, both signatures */
const LOSS = 0x34;
const RETIRED_AGENT_ADD = 0x15; /* retired 2026-10-08: refused as unknown */
const GRANT_CREATE = 0x10;
const GRANT_LABEL = 0x11; /* R11a: {scope index, label 32}, no press - a derived code's identity */
const GRANT_REVOKE = 0x12;
const GRANT_HOLD = 0x13;
const GRANT_RESUME = 0x14;
const RECEIPT = 0x20;
const SETTLE = 0x21;
const TX_START = 0x22;
const SEQ_NONE = 0xffffffff;
/* lib codes.js */
const OP_SIGN = 1;
const OP_DECRYPT = 2;
const OP_GRANT_CREATE = 6;
const OP_RECEIPT = 8;
const OP_GRANT_HOLD = 13;
const OP_GRANT_RESUME = 14;
const APPROVE = 1;
const TIMEOUT = 3;
const SELF_PRESS = 4;
const NEEDS_REVIEW = 0x8f;
/* how a budget ended: its grant-end link's decision byte */
const END_COMPLETED = 1;
const END_REVOKED = 2;
const END_SETTLED = 3;
const PRESS_OBSERVED = 0x01;
const OWES_RECEIPT = 0x10; /* R16: set by the key at decision time - this use owes a receipt */
/* the console line that says a confirmation is primed (14-stored-keys uses it too) */
const PRIMED = /Encrypted Buffer/g;
const P256_SPKI = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

module.exports = function register({ it }, ctx) {
  /* R28: the backup the same-device restore test kept in the PREVIOUS run - read now, before this run's replaces it */
  const keptAtLoad = (() => { try { return JSON.parse(require('fs').readFileSync(require('path').join(require('os').tmpdir(), 'okt-plugin-backup.json'), 'utf8')); } catch { return null; } })();
  const { chain, grants, receipts } = ctx.requireLib('node-onlykey-lib/edge');
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

  /* collect every report since `since` until there are `reports` of them */
  async function collect(device, since, reports, { signal }) {
    await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
    const deadline = Date.now() + 6000;
    let got = device.reportsSince(ctx.IFACE.VENDOR, since);
    while (got.length < reports && Date.now() < deadline) {
      await device.sleep(50, { signal });
      got = device.reportsSince(ctx.IFACE.VENDOR, since);
    }
    return got;
  }

  /* send an OKEDGE sub-op and collect EVERY report since (several come back to back) */
  async function edge(device, sub, args, { signal, reports = 1, text = false, press = false }) {
    const since = device.mark(ctx.IFACE.VENDOR);
    device.sendVendor({ msg: OKEDGE, slot: sub, payload: args || Buffer.alloc(0) });
    if (press) {
      /* the physical press a grant, resume or settle waits for */
      await device.sleep(800, { signal });
      device.press(1);
    }
    const got = await collect(device, since, reports, { signal });
    if (text) return ctx.okmsg.text(got[0]).trim();
    for (const r of got) {
      const t = ctx.okmsg.text(r);
      if (/^EDGE:(?!00)/.test(t)) throw new Error(`the key refused OKEDGE ${sub}: ${t.trim()}`);
    }
    if (got.length < reports) throw new Error(`OKEDGE ${sub}: ${got.length} of ${reports} reports`);
    return got.slice(0, reports).map((r) => Buffer.from(r));
  }

  /* the device id is edge JS's to compute: SHA256("OKEDGE-DEVICE-v1" || the Edge public key)[0..16] */
  const deviceIdOf = (pub) => new Uint8Array(sha256(Buffer.concat([Buffer.from('OKEDGE-DEVICE-v1'), Buffer.from(pub)])).subarray(0, 16));

  /*
   * The key never reveals its head: the kit welds it, as every host must - from the genesis (a chain from #0, or a
   * restored device's continue link) through every link it picks up. One welded head per device id; the kit reads HEAD
   * often enough never to fall behind the key's ring of 8 links.
   */
  const welded = new Map();
  async function weldedHead(device, seq, oldest, opts) {
    const id = deviceIdOf(await pubkey(device, opts));
    const k = Buffer.from(id).toString('hex');
    if (seq === SEQ_NONE) { welded.set(k, { seq, head: chain.genesis(id) }); return chain.genesis(id); }
    let w = welded.get(k);
    if (w && w.seq !== SEQ_NONE && w.seq > seq) w = null;
    let next;
    let at;
    if (w && w.seq !== SEQ_NONE) {
      next = w.seq + 1;
      at = w.head;
    } else {
      next = w ? 0 : oldest;
      at = chain.genesis(id);
      if (!w && oldest !== 0) {
        const [first] = await pickup(device, oldest, 1, opts);
        if (chain.decodeLink(first.link).op !== 16) throw new Error(`the kit never saw chain ${k.slice(0, 8)} from its start (#${oldest})`);
      }
    }
    if (next < oldest) throw new Error(`the kit fell behind the key's ring: #${next} is gone (oldest #${oldest})`);
    while (next <= seq) {
      const n = Math.min(8, seq - next + 1);
      for (const l of await pickup(device, next, n, opts)) at = chain.weld(at, l.link);
      next += n;
    }
    welded.set(k, { seq, head: at });
    return at;
  }

  /* HEAD: seq . (zeros: never the head) . oldest pickable seq . the live budget ids . held mask . owes . caps (59) */
  async function head(device, opts) {
    const [r] = await edge(device, HEAD, null, opts);
    const ids = [0, 1, 2, 3].map((i) => r.readUInt32LE(40 + 4 * i));
    const seq = r.readUInt32LE(0);
    const oldest = r.readUInt32LE(36);
    return {
      seq, head: await weldedHead(device, seq, oldest, opts), keyHead: new Uint8Array(r.subarray(4, 36)), caps: r[59], oldest,
      live: ids.filter(Boolean), held: ids.filter((id, i) => id && (r[56] >> i) & 1), owed: r[57],
      refusedTx: r[60], /* B7 stage 2: TX starts refused since power-up (RAM only) */
    };
  }

  /* RECEIPT and SETTLE answer seq . 32 zero bytes - the kit welds the head the next TX start passes (R13a) */
  const seqHead = (r) => ({ seq: r.readUInt32LE(0), head: new Uint8Array(r.subarray(4, 36)) });

  async function receipt(device, ref, msg, opts) {
    const [r] = await edge(device, RECEIPT, Buffer.concat([u32(ref), Buffer.from([0x00]), sha256(Buffer.from(msg))]), opts);
    const { seq } = seqHead(r);
    const h = await head(device, opts);
    if (h.seq !== seq) throw new Error(`RECEIPT answered #${seq}, HEAD says #${h.seq}`);
    return { seq, head: h.head };
  }

  /*
   * R13a: TX start carries the token SHA256("OKEDGE-TX-v1" || head || subject),
   * subject = the LIBRARY's requestSubject of exactly the bytes the request
   * will submit. Whether the firmware agrees - its pend.subject, hashed from
   * what it primes - is what the per-op test below proves.
   */
  const txStartFor = (device, headBytes, payload, opts) =>
    edge(device, TX_START, Buffer.from(grants.txToken({ head: headBytes, subject: grants.requestSubject(new Uint8Array(payload)) })), { ...opts, text: true });

  /* clear whatever earlier tests left owed: a pressed SETTLE (R18) */
  async function clearDebts(device, { signal, log }) {
    const h = await head(device, { signal });
    if (!h.owed) return;
    await edge(device, SETTLE, null, { signal, press: true });
    if (log) log('settled the use earlier tests left owed');
  }

  /*
   * GRANT_CREATE (SPEC.md R27 layout): [0] scope count, [1..16] scopes,
   * [17..48] reason hash, [49] flags, [50..51] lifetime (u16 LE minutes, R15b;
   * 0 = the key's 12 h), [52..57] the first 6 bytes of the head the host
   * verified. `verified` is the key's current head - this test is the host,
   * and checks the chain itself. `scopes`: a cap (agent P-256 sign 222) or a list.
   */
  /*
   * R11a: agent sign 222 is a DERIVED code, shared by every P-256 identity, so
   * a scope on it names one: the 32-byte label of the test identity every
   * agent request here carries ("okt edge identity") - never a real one.
   */
  const OKT_LABEL = sha256(Buffer.from('okt edge identity'));
  const derived = (slot) => (slot >= 201 && slot <= 203) || (slot >= 221 && slot <= 223);
  const scopesOf = (scopes) => (typeof scopes === 'number' ? [{ op: OP_SIGN, slot: 222, cap: scopes, label: OKT_LABEL }] : scopes);
  function grantRequest(scopes, reasonHash, verified, lifetime = 0) {
    const req = Buffer.alloc(58);
    Buffer.from(grants.encodeScopes(scopesOf(scopes))).copy(req, 0);
    reasonHash.copy(req, 17);
    req.writeUInt16LE(lifetime, 50);
    Buffer.from(verified).copy(req, 52, 0, 6);
    return req;
  }

  /* ... with its press -> {grantId, uses, G, chainSeq, ckpt, sig, sigPq} */
  async function openBudget(device, scopes, reason, { signal, lifetime = 0 }) {
    const reasonHash = sha256(Buffer.from(reason));
    /* R11a: each derived-code scope's label is staged first (no press); GRANT_CREATE consumes them */
    const list = scopesOf(scopes);
    for (let j = 0; j < list.length; j++) {
      if (!derived(list[j].slot)) continue;
      const staged = await edge(device, GRANT_LABEL, Buffer.concat([Buffer.from([j]), list[j].label || OKT_LABEL]), { signal, text: true });
      if (staged !== 'EDGE:00') throw new Error(`GRANT_LABEL ${j} answered ${staged}`);
    }
    const before = (await head(device, { signal })).head;
    const req = grantRequest(scopes, reasonHash, before, lifetime);
    const rs = await edge(device, GRANT_CREATE, req, { signal, press: true, reports: 3 + PQ_SIG_REPORTS });
    const [g, ckpt, s] = rs;
    /* the opening link's head: the kit welds it onto the head it opened on (the key sends none) */
    const [opening] = await pickup(device, g.readUInt32LE(38), 1, { signal });
    return {
      grantId: g.readUInt32LE(0), uses: g.readUInt16LE(4), G: new Uint8Array(g.subarray(6, 38)),
      chainSeq: g.readUInt32LE(38), ckpt, sig: new Uint8Array(s.subarray(0, 64)), sigPq: joined(rs.slice(3), PQ_SIG), reasonHash,
      openedHead: chain.weld(before, opening.link),
    };
  }

  /*
   * A chain at least n links long, built from Edge's own records (a budget opened
   * and revoked = 2 links). Ordinary presses wrote links before 2026-10-06; tests
   * that need a story build it now, and a test run alone starts on an empty chain.
   */
  async function ensureChain(device, n, { signal, log }) {
    await clearDebts(device, { signal, log });
    for (;;) {
      const h = await head(device, { signal });
      if (h.seq !== SEQ_NONE && h.seq + 1 >= n) return h;
      const b = await openBudget(device, 1, 'okt: a link for the story', { signal });
      await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true });
    }
  }

  /* reports joined into the n bytes they carry */
  const joined = (rs, n) => new Uint8Array(Buffer.concat(rs).subarray(0, n));

  /*
   * A checkpoint (seq, head) is TWO signatures over the same digest (lib chain checkpoint digest,
   * R7): the P-256 Edge key's, checked here with node:crypto, and its ML-DSA-65 twin's, checked by
   * the lib (chain.mlDsaVerify). Both must verify.
   */
  function checkpointVerifies(pub, seq, headBytes, sig, pubPq, sigPq) {
    const message = Buffer.concat([Buffer.from('OKEDGE-CKPT-v1'), Buffer.from(deviceIdOf(pub)), u32(seq), Buffer.from(headBytes)]);
    const key = crypto.createPublicKey({ key: Buffer.concat([P256_SPKI, Buffer.from([4]), Buffer.from(pub)]), format: 'der', type: 'spki' });
    return crypto.verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig).subarray(0, 64))
      && chain.mlDsaVerify(sigPq, sha256(message), pubPq);
  }

  /* an ML-DSA-65 public key: 0 the checkpoint key's twin, 1 the owner key's */
  async function pubkeyPq(device, which, opts) {
    return joined(await edge(device, PUBKEY_PQ, Buffer.from([which]), { ...opts, reports: PQ_PK_REPORTS }), PQ_PK);
  }

  /*
   * A pressed certification of a nametag, checked with node:crypto alone (the kit's pinned lib predates it):
   * SHA256("OKEDGE-CERTIFY-v1" || device id || checkpoint key || SHA256(ML-DSA checkpoint key) || approval ||
   * seq || subject) signed with the OWNER key the reply carries; subject = SHA256("OKEDGE-NAMETAG-v1" || text).
   */
  async function certifyOf(device, nametag, opts) {
    const nh = sha256(Buffer.concat([Buffer.from('OKEDGE-NAMETAG-v1'), Buffer.from(nametag, 'utf8')]));
    const pub = await pubkey(device, opts);
    const pubPq = await pubkeyPq(device, 0, opts);
    const ownerPq = await pubkeyPq(device, 1, opts);
    const rs = await edge(device, CERTIFY, nh, { ...opts, press: true, reports: 3 + PQ_SIG_REPORTS });
    const [a, k, sg] = rs;
    const approval = a[0];
    const seq = a.readUInt32LE(1);
    const owner = new Uint8Array(k.subarray(0, 64));
    /* the certification names both of this device's checkpoint keys: the P-256 key, and the hash of its ML-DSA twin */
    const message = Buffer.concat([Buffer.from('OKEDGE-CERTIFY-v1'), Buffer.from(deviceIdOf(pub)), Buffer.from(pub), sha256(Buffer.from(pubPq)), Buffer.from([approval]), u32(seq), nh]);
    const key = crypto.createPublicKey({ key: Buffer.concat([P256_SPKI, Buffer.from([4]), Buffer.from(owner)]), format: 'der', type: 'spki' });
    const p256ok = crypto.verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sg).subarray(0, 64));
    const pqOk = chain.mlDsaVerify(joined(rs.slice(3), PQ_SIG), sha256(message), ownerPq);
    return { approval, seq, subject: nh, echoed: Buffer.from(a.subarray(5, 37)).equals(nh), owner, ownerPq, ok: p256ok && pqOk, p256ok, pqOk, pub, pubPq };
  }

  /* the owner keys and the checkpoint ML-DSA key, READ - nothing signed, no link */
  async function ownerKeysOf(device, opts) {
    const [r] = await edge(device, PUBKEY, Buffer.from([1]), opts);
    return { owner: new Uint8Array(r.subarray(0, 64)), ownerPq: await pubkeyPq(device, 1, opts), pubPq: await pubkeyPq(device, 0, opts) };
  }

  /* PICKUP: per link the link, then 32 zero bytes (the key never reveals a head: null here) and (for a self-press) the reveal */
  async function pickup(device, from, count, opts) {
    const rs = await edge(device, PICKUP, Buffer.concat([u32(from), Buffer.from([count])]), { ...opts, reports: count * 2 });
    const out = [];
    for (let i = 0; i < rs.length; i += 2) {
      const sent = new Uint8Array(rs[i + 1].subarray(0, 32));
      out.push({ link: new Uint8Array(rs[i]), head: sent.every((x) => x === 0) ? null : sent, reveal: new Uint8Array(rs[i + 1].subarray(32, 64)) });
    }
    return out;
  }

  async function pubkey(device, opts) {
    const [r] = await edge(device, PUBKEY, null, opts);
    return new Uint8Array(r.subarray(0, 64));
  }

  /* an agent-derived P-256 sign's bytes (OKSIGN code 222): message || identity hash */
  const agentPayload = (text) => Buffer.concat([sha256(Buffer.from(text)), sha256(Buffer.from('okt edge identity'))]);

  /* any request, in 57-byte chunks: 0xFF while more follows, the last chunk's length on the last */
  function sendChunked(device, msg, slot, payload) {
    for (let i = 0; i < payload.length; i += 57) {
      const chunk = payload.subarray(i, i + 57);
      device.sendVendor({ msg, slot, field: chunk.length < 57 ? chunk.length : 0xff, payload: chunk });
    }
    return payload;
  }
  const sendAgentSign = (device, message) =>
    sendChunked(device, ctx.okmsg.MSG.OKSIGN, 222, Buffer.concat([message, sha256(Buffer.from('okt edge identity'))]));

  /*
   * Wait for the key's head to move past `seq` - the decision is linked. Polled
   * on HEAD rather than slept: a slower host (the Linux VM) takes longer, and a
   * fixed sleep that suits Windows was too short there.
   */
  async function headPast(device, seq, { signal, timeoutMs = 10000 }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const h = await head(device, { signal });
      if (h.seq !== SEQ_NONE && (seq === SEQ_NONE || h.seq > seq)) return h;
      if (Date.now() > deadline) throw new Error(`the key did not link the decision (head still #${h.seq})`);
      await device.sleep(250, { signal });
    }
  }

  /* an ordinary pressed sign (no TX start): it signs and is not Edge - no link, nothing owed (2026-10-06) */
  async function ordinaryPress(device, text, { signal }) {
    const primed = device.log.count(PRIMED);
    const since = device.mark(ctx.IFACE.VENDOR);
    sendAgentSign(device, sha256(Buffer.from(text)));
    await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
    await device.sleep(500, { signal });
    device.press(1);
    await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
  }

  /* a sign the key refuses before it runs (R13a, 2026-10-06): no prompt, no link - its answer, e.g. "EDGE:1C" */
  async function refusedSign(device, payload, { signal }) {
    const since = device.mark(ctx.IFACE.VENDOR);
    sendChunked(device, ctx.okmsg.MSG.OKSIGN, 222, payload);
    const got = await collect(device, since, 1, { signal });
    return ctx.okmsg.text(got[0]).trim();
  }

  /* a sign an started budget pays for: no press - the signature comes back and the link is there */
  async function selfPressedSign(device, payload, { signal }) {
    const before = (await head(device, { signal })).seq;
    const since = device.mark(ctx.IFACE.VENDOR);
    sendChunked(device, ctx.okmsg.MSG.OKSIGN, 222, payload);
    await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
    const h = await headPast(device, before, { signal });
    return { payload, seq: h.seq };
  }

  /*
   * Pick up every link from `kept`'s end to the key's head. The key holds only
   * its last 8 for pickup, so a long test calls this before 8 new ones pile up.
   */
  async function catchUp(device, kept, from, { signal }) {
    const h = await head(device, { signal });
    let next = kept.length ? chain.decodeLink(kept[kept.length - 1].link).seq + 1 : from;
    while (next <= h.seq) {
      const n = Math.min(8, h.seq - next + 1);
      kept.push(...await pickup(device, next, n, { signal }));
      next += n;
    }
    return h;
  }

  /* everything from `from` to the key's head, verified by the library */
  async function verifyFrom(device, from, fromHead, { signal, assert, log }) {
    const h = await head(device, { signal });
    const links = await pickup(device, from, h.seq - from + 1, { signal });
    /* the key sends no heads: each is the weld from the head the kit started from, as a host's copy keeps them */
    let at = fromHead;
    for (const l of links) { at = chain.weld(at, l.link); l.head = at; }
    const result = chain.verify(links, { fromSeq: from, fromHead, expectHead: { seq: h.seq, head: h.head } });
    if (log) log(`library verdict: ${JSON.stringify({ ok: result.ok, through: result.verifiedThrough, failure: result.failure })}`);
    assert.ok(result.ok, `the library rejects the key's chain: ${JSON.stringify(result.failure)}`);
    return { h, links, fields: links.map((l) => chain.decodeLink(l.link)) };
  }

  const trail = (f) => f.map((x) => `#${x.seq} op ${x.op} dec ${x.decision} flags ${x.flags} grant ${x.grantId} step ${x.grantStep}`).join('; ');

  it('edge: HEAD and the Edge key on a fresh key; the chain starts at the lib\'s genesis',
    async ({ device, assert, signal, log }) => {
      await device.restart({ signal });
      await device.unlock(ctx.PINS.primary, { signal });
      const h = await head(device, { signal });
      const pub = await pubkey(device, { signal });
      const deviceId = deviceIdOf(pub);
      log(`seq ${h.seq === SEQ_NONE ? 'none' : h.seq}, device ${Buffer.from(deviceId).toString('hex')}, live ${JSON.stringify(h.live)}, owed ${h.owed}`);
      assert.ok(crypto.createPublicKey({ key: Buffer.concat([P256_SPKI, Buffer.from([4]), pub]), format: 'der', type: 'spki' }), 'not a P-256 point');
      if (h.seq === SEQ_NONE) assert.bytes(Buffer.from(h.head), Buffer.from(chain.genesis(deviceId)), 'an empty chain\'s head is not the genesis');
    });

  it('edge: a certification - at a press, one link on the chain, signed by the owner key (not the checkpoint key) naming that link; the no-press statement is retired; the owner keys are read without signing',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      assert.equal(await edge(device, RETIRED_STATEMENT, Buffer.alloc(32, 1), { signal, text: true }), 'EDGE:0A', 'the no-press owner statement still answers');
      const before = await head(device, { signal });
      const st = await certifyOf(device, 'okt bench', { signal });
      const after = await head(device, { signal });
      log(`certified at #${st.seq}, owner ${Buffer.from(st.owner).toString('hex').slice(0, 16)}…`);
      assert.ok(st.ok, 'the certification does not verify under the owner key it carries');
      assert.ok(st.echoed, 'the reply does not echo the subject');
      assert.equal(st.approval, 1, 'a pressed certification does not say it was pressed');
      assert.equal(after.seq, before.seq === SEQ_NONE ? 0 : before.seq + 1, 'the certification did not write exactly one link');
      assert.equal(st.seq, after.seq, 'the certification does not name its own link');
      const [l] = await pickup(device, after.seq, 1, { signal });
      const fl = chain.decodeLink(l.link);
      assert.equal(JSON.stringify([fl.op, fl.decision, fl.slot, fl.flags]), JSON.stringify([18, 1, 0, 1]), 'the link is not a pressed certify');
      assert.bytes(Buffer.from(fl.subject), Buffer.from(st.subject), 'the link does not carry the certified subject');
      assert.ok(!Buffer.from(st.owner).equals(Buffer.from(st.pub)), 'the owner key is the checkpoint key - it must carry no salt, the checkpoint key does');
      const read = await ownerKeysOf(device, { signal });
      assert.ok(Buffer.from(read.owner).equals(Buffer.from(st.owner)), 'the owner key read is not the one that signed');
      assert.equal((await head(device, { signal })).seq, after.seq, 'reading the owner keys wrote a link');
    });

  it('edge: an ordinary press writes no link and owes nothing, budget or not; a budget use owes its receipt - a timeout does not clear it, a late receipt pays it, a second is refused (R16, 2026-10-06)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const before = await head(device, { signal });
      const first = before.seq === SEQ_NONE ? 0 : before.seq + 1;

      /* no budget: an ordinary press signs and writes nothing (the chain holds only Edge's own records) */
      await ordinaryPress(device, 'okt edge ordinary', { signal });
      const h0 = await head(device, { signal });
      assert.equal(h0.seq, before.seq, 'an ordinary press wrote a link');
      assert.equal(h0.owed, 0, 'an ordinary press owes a receipt');

      /* a budget use: self-pressed, owes its receipt */
      const b = await openBudget(device, 2, 'okt: one paid use', { signal });
      const payload = agentPayload('okt edge paid 1');
      assert.equal(await txStartFor(device, (await head(device, { signal })).head, payload, { signal }), 'EDGE:00');
      const paid = await selfPressedSign(device, Buffer.concat([payload]), { signal });
      const hp = await head(device, { signal });
      assert.equal(hp.owed, 1, 'the budget use does not owe its receipt');

      /* under the live budget: an ordinary press, and one left to time out - no link, the debt stays */
      await ordinaryPress(device, 'okt edge ordinary under a budget', { signal });
      const primed = device.log.count(PRIMED);
      sendAgentSign(device, sha256(Buffer.from('okt edge never pressed')));
      await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
      await device.sleep(23000, { signal }); /* never pressed: the 20 s fade */
      const afterTimeout = await head(device, { signal });
      assert.equal(afterTimeout.seq, hp.seq, 'an ordinary press or its timeout wrote a link');
      assert.equal(afterTimeout.owed, 1, 'the timeout cleared the debt');

      const msg = 'okt: paid use 1';
      const t = await receipt(device, paid.seq, msg, { signal });
      assert.equal(t.seq, afterTimeout.seq + 1, 'the receipt reply is not the receipt link\'s seq');
      const again = await edge(device, RECEIPT, Buffer.concat([u32(paid.seq), Buffer.from([0]), sha256(Buffer.from(msg))]), { signal, text: true });
      assert.equal(again, 'EDGE:08', 'a second receipt for one use was taken');

      const { h, fields: f, links } = await verifyFrom(device, first, before.head, { signal, assert, log });
      log(trail(f));
      assert.bytes(Buffer.from(t.head), Buffer.from(h.head), 'the receipt reply is not the key\'s head');
      assert.equal(h.owed, 0);
      assert.ok(f.every((x) => x.op !== OP_SIGN || x.decision === SELF_PRESS), `a sign link that is not a budget use: ${trail(f)}`);
      const use = receipts.pairReceipts(links, { [paid.seq]: msg }).uses.find((u) => u.seq === paid.seq);
      assert.equal(use.status, 'receipted');
      assert.equal(use.message, msg, 'the receipt\'s message does not match its link');
      /* one of its two uses left: not fulfilled, so still live - a revoke ends it, and its link says revoked */
      assert.ok((await head(device, { signal })).live.includes(b.grantId), 'a half-used budget ended at its receipt');
      assert.equal(await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true }), 'EDGE:00');
      const hv = await head(device, { signal });
      const [rv] = (await pickup(device, hv.seq, 1, { signal })).map((r) => chain.decodeLink(r.link));
      assert.equal(JSON.stringify([rv.op, rv.grantId, rv.decision]), JSON.stringify([7, b.grantId, END_REVOKED]), 'the revoke\'s link does not say revoked');
    });

  it('edge: a budget signed at a press pays only started uses; a TX start pays for its own request only, and nothing starts while a receipt is owed (R10, R13, R13a, R18)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const before = await head(device, { signal });
      const pub = await pubkey(device, { signal });

      const b = await openBudget(device, 2, 'okt: sign two test messages', { signal });
      log(`budget ${b.grantId}: ${b.uses} uses, opened at chain #${b.chainSeq}`);
      assert.ok((await head(device, { signal })).live.includes(b.grantId), 'HEAD does not list the new budget as live');

      /*
       * The budget's genesis is signed THROUGH the chain: the press answers with a
       * checkpoint over the grant-create link, and that link's subject commits to G
       *   SHA256("OKEDGE-GRANT-v1" || scopes || reason_hash || G || lifetime)
       */
      assert.equal(b.ckpt.readUInt32LE(0), b.chainSeq, 'the checkpoint is not over the grant-create link');
      /* it carries no head: the host welds the grant link onto the head it held, and only that head verifies */
      assert.ok(b.ckpt.subarray(4, 36).every((x) => x === 0), 'the opening confirmation revealed the head');
      const [opened] = await pickup(device, b.chainSeq, 1, { signal });
      const openedHead = chain.weld(before.head, opened.link);
      assert.ok(checkpointVerifies(pub, b.chainSeq, openedHead, b.sig, await pubkeyPq(device, 0, { signal }), b.sigPq), 'the opening checkpoint does not verify over the welded head (both halves)');
      const scopesEnc = Buffer.from([1, OP_SIGN, 222, 2, 0]);
      /* ... and (R11a) ends with the derived scope's full label: the identity the person approved */
      const wantSubject = sha256(Buffer.concat([Buffer.from('OKEDGE-GRANT-v1'), scopesEnc, b.reasonHash, Buffer.from(b.G), Buffer.from([0, 0]), OKT_LABEL]));
      assert.bytes(Buffer.from(chain.decodeLink(opened.link).subject), wantSubject, 'the grant-create link does not commit to G and the lifetime');

      /* a request that skips TX start is an ordinary press, even with a live budget - not Edge: no link, nothing owed (2026-10-06) */
      const kept = [];
      const h0 = await head(device, { signal });
      await ordinaryPress(device, 'okt budget message 0', { signal });
      const h0b = await head(device, { signal });
      assert.equal(JSON.stringify([h0b.seq, h0b.owed]), JSON.stringify([h0.seq, 0]), 'an unstarted use under a live budget wrote a link or owes');

      /* grant -> start -> use -> receipt -> start -> use -> receipt */
      const pl1 = agentPayload('okt budget message 1');
      assert.equal(await txStartFor(device, h0b.head, pl1, { signal }), 'EDGE:00');
      const s1 = await selfPressedSign(device, pl1, { signal });
      assert.equal(await txStartFor(device, (await head(device, { signal })).head, pl1, { signal }), 'EDGE:0C', 'TX start went through while a receipt was owed (R18)');
      assert.equal(await edge(device, GRANT_CREATE, Buffer.alloc(58, 0).fill(1, 0, 1), { signal, text: true }), 'EDGE:0C', 'a budget opened while a receipt was owed (R10)');
      const t1 = await receipt(device, s1.seq, 'okt: 1', { signal });
      await catchUp(device, kept, b.chainSeq, { signal });

      /*
       * R13a (spec session, 2026-10-06): a TX start pays for ITS request after ITS head,
       * nothing else - and anything else is REFUSED, not pressed: no prompt, no
       * link, the TX start used up, counted in HEAD byte 60. A stale head shows at the
       * sign; so does another program's request slipped in after a good TX start. The
       * agent's own request then has no start left: an ordinary press (no link) until
       * it TX starts again.
       */
      const r0 = (await head(device, { signal })).refusedTx;
      const plStale = agentPayload('okt budget: started on a stale head');
      assert.equal(await txStartFor(device, h0b.head, plStale, { signal }), 'EDGE:00');
      assert.equal(await refusedSign(device, plStale, { signal }), 'EDGE:1C', 'a sign started on a stale head was not refused');
      const plMine = agentPayload('okt budget: the request the agent started for');
      const plOther = agentPayload('okt budget: another program slipped in');
      assert.equal(await txStartFor(device, t1.head, plMine, { signal }), 'EDGE:00');
      assert.equal(await refusedSign(device, plOther, { signal }), 'EDGE:1C', 'another request after the TX start was not refused');
      const hr = await head(device, { signal });
      assert.equal(hr.seq, t1.seq, 'a refused sign wrote a link');
      assert.equal(hr.refusedTx - r0, 2, 'the two refused signs were not both counted');
      await ordinaryPress(device, 'okt budget: the agent\'s own, its start used up', { signal });
      assert.equal((await head(device, { signal })).seq, hr.seq, 'the refusals or the ordinary press wrote a link');

      const pl2 = agentPayload('okt budget message 2');
      assert.equal(await txStartFor(device, hr.head, pl2, { signal }), 'EDGE:00');
      const s2 = await selfPressedSign(device, pl2, { signal });
      const t2 = await receipt(device, s2.seq, 'okt: 2', { signal });
      assert.equal(await txStartFor(device, t2.head, agentPayload('okt budget message 3'), { signal }), 'EDGE:0D', 'TX start went through under a used-up budget');
      const kh = await catchUp(device, kept, b.chainSeq, { signal });

      const links = kept;
      const verdict = chain.verify(links, { fromSeq: b.chainSeq, fromHead: before.head, expectHead: { seq: kh.seq, head: kh.head } });
      assert.ok(verdict.ok, `the library rejects the key's chain: ${JSON.stringify(verdict.failure)}`);
      const f = links.map((l) => chain.decodeLink(l.link));
      log(trail(f));
      const at = (seq) => f[seq - b.chainSeq];
      assert.equal(at(b.chainSeq).op, OP_GRANT_CREATE);
      assert.equal(at(b.chainSeq).grantId, b.grantId);
      assert.equal(JSON.stringify([at(s1.seq).decision, at(s1.seq).grantId, at(s1.seq).grantStep]), JSON.stringify([SELF_PRESS, b.grantId, 1]));
      assert.equal(JSON.stringify([at(s2.seq).decision, at(s2.seq).grantStep]), JSON.stringify([SELF_PRESS, 2]));
      /* the chain holds only Edge's own records: every sign link is a budget use (2026-10-06) */
      assert.ok(f.every((x) => x.op !== OP_SIGN || x.decision === SELF_PRESS), `a sign link that is not a budget use: ${trail(f)}`);
      /* R16: a self-press OWES; v1 sets no other bit above the budget's (no STARTED, no PREV_NO_RECEIPT) */
      const bits = (p) => at(p.seq).flags & 0xfc;
      for (const p of [s1, s2]) assert.equal(bits(p), OWES_RECEIPT, `#${p.seq}: a self-press must carry bit 4 and nothing above bit 1 but it`);

      /* each reveal belongs to G and to what was signed (the MAC is the host's to compute) */
      const spends = [s1, s2].map((s, i) => {
        const value = links[s.seq - b.chainSeq].reveal;
        const subject = new Uint8Array(sha256(s.payload));
        const mac = new Uint8Array(crypto.createHmac('sha256', value).update(subject).digest());
        return { step: i + 1, value, mac, subject };
      });
      assert.equal(JSON.stringify(grants.checkSpends(b.G, b.uses, spends)), '{"ok":true,"spent":2}');
      const paired = receipts.pairReceipts(links);
      for (const s of [s1, s2]) assert.equal(paired.uses.find((u) => u.seq === s.seq).status, 'receipted', `use #${s.seq}`);

      /* fulfilled - both uses made and receipted: the key ended it itself at the last receipt (completed), no revoke */
      const done = f[f.length - 1];
      assert.equal(JSON.stringify([done.op, done.grantId, done.decision]), JSON.stringify([7, b.grantId, END_COMPLETED]), 'the key did not complete the fulfilled budget');
      assert.ok(!(await head(device, { signal })).live.includes(b.grantId), 'a completed budget is still listed as live');
      assert.equal(await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true }), 'EDGE:07', 'a completed budget could still be revoked');
    });

  it('edge: a held budget pays for nothing; resume takes a press and waits for owed receipts (R15a)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const b = await openBudget(device, 2, 'okt: hold me', { signal });
      assert.equal(await edge(device, GRANT_HOLD, u32(b.grantId), { signal, text: true }), 'EDGE:00');
      let h = await head(device, { signal });
      assert.equal(JSON.stringify(h.held), JSON.stringify([b.grantId]), 'HEAD does not report the budget on hold');
      assert.equal(await txStartFor(device, h.head, agentPayload('okt held'), { signal }), 'EDGE:0D', 'TX start went through under a held budget');
      /* B7 stage 2: a refused TX start writes no link, but HEAD byte 60 counts it */
      assert.equal((await head(device, { signal })).refusedTx, Math.min(255, h.refusedTx + 1), 'HEAD byte 60 did not count the refused TX start');
      assert.equal((await head(device, { signal })).seq, h.seq, 'a refused TX start wrote a link');

      /* while a use owes, resume is refused (R18) - the debt from another budget's paid use (only budget uses owe, 2026-10-06) */
      const b2 = await openBudget(device, 1, 'okt: a debt while held', { signal });
      const pl2 = agentPayload('okt held: paid by the other budget');
      assert.equal(await txStartFor(device, (await head(device, { signal })).head, pl2, { signal }), 'EDGE:00');
      const p = await selfPressedSign(device, pl2, { signal });
      const resumeReq = (headBytes) => Buffer.concat([u32(b.grantId), Buffer.from(headBytes)]);
      assert.equal(await edge(device, GRANT_RESUME, resumeReq((await head(device, { signal })).head), { signal, text: true }), 'EDGE:0C', 'resume went through while a receipt was owed');
      const t = await receipt(device, p.seq, 'okt: paid while held', { signal });

      /* R27: only on the head the host verified */
      assert.equal(await edge(device, GRANT_RESUME, resumeReq(new Uint8Array(32).fill(1)), { signal, text: true }), 'EDGE:0B', 'resume went through on a head the host never verified');
      assert.equal(await edge(device, GRANT_CREATE, grantRequest(1, sha256(Buffer.from('stale')), new Uint8Array(32).fill(1)), { signal, text: true }), 'EDGE:0B', 'a budget opened on a head the host never verified');
      assert.equal(await edge(device, GRANT_RESUME, resumeReq(t.head), { signal, text: true, press: true }), 'EDGE:00');
      h = await head(device, { signal });
      assert.equal(JSON.stringify(h.held), JSON.stringify([]), 'still on hold after the resume');
      assert.equal(await txStartFor(device, h.head, agentPayload('okt resumed'), { signal }), 'EDGE:00');

      /* from the grant-create link on, welded and checked by the library */
      const [opened] = await pickup(device, b.chainSeq, 1, { signal });
      const { fields } = await verifyFrom(device, b.chainSeq + 1, b.openedHead, { signal, assert });
      const ops = fields;
      log(trail(ops));
      const hold = ops.find((x) => x.op === OP_GRANT_HOLD);
      const resume = ops.find((x) => x.op === OP_GRANT_RESUME);
      assert.ok(hold && hold.grantId === b.grantId && !(hold.flags & PRESS_OBSERVED), 'no grant-hold link (or it claims a press)');
      assert.ok(resume && resume.grantId === b.grantId && (resume.flags & PRESS_OBSERVED), 'no pressed grant-resume link');
      /* the debt was the other budget's paid use: it OWES */
      const pl = ops.find((x) => x.seq === p.seq);
      assert.equal(JSON.stringify([pl.decision, pl.grantId, pl.flags & OWES_RECEIPT]), JSON.stringify([SELF_PRESS, b2.grantId, OWES_RECEIPT]), 'the debt is not the other budget\'s paid use');
      await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true });
      await edge(device, GRANT_REVOKE, u32(b2.grantId), { signal, text: true }).catch(() => {}); /* used up: it may have ended at its receipt */
    });

  /*
   * Only budget uses owe and nothing TX starts while one is owed (R18), so the key keeps
   * one owed use or none. One owed budget use is settled.
   */
  it('edge: SETTLE takes a press; a restart keeps the debt; an unpressed settle does nothing (R16, R18)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const before = await head(device, { signal });
      await openBudget(device, 1, 'okt: one use, to be settled', { signal }); /* the restart ends it; the debt stays */
      const plw = agentPayload('okt settle 0');
      assert.equal(await txStartFor(device, (await head(device, { signal })).head, plw, { signal }), 'EDGE:00');
      const uses = [await selfPressedSign(device, plw, { signal })];
      let h = await head(device, { signal });
      assert.equal(h.owed, 1, 'the budget use does not owe its receipt');
      /* picked up now: a restart keeps only the latest link in RAM, as a host's copy would */
      const first = before.seq === SEQ_NONE ? 0 : before.seq + 1;
      const kept = await pickup(device, first, h.seq - first + 1, { signal });

      /* a restart (lock) does not clear a debt */
      await device.restart({ signal });
      await device.unlock(ctx.PINS.primary, { signal });
      h = await head(device, { signal });
      assert.equal(h.owed, 1, 'the restart cleared the debt');

      /* unpressed, the settle does nothing */
      const primed = device.log.count(PRIMED);
      device.sendVendor({ msg: OKEDGE, slot: SETTLE, payload: Buffer.alloc(0) });
      await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal }).catch(() => {});
      await device.sleep(23000, { signal });
      h = await head(device, { signal });
      assert.equal(h.owed, 1, 'a settle nobody pressed cleared the debt');

      const [w] = await edge(device, SETTLE, null, { signal, press: true });
      const ws = seqHead(w);
      h = await head(device, { signal });
      assert.equal(h.owed, 0);
      assert.equal(ws.seq, h.seq);

      const links = kept.concat(await pickup(device, ws.seq, 1, { signal }));
      const result = chain.verify(links, { fromSeq: first, fromHead: before.head, expectHead: { seq: h.seq, head: h.head } });
      assert.ok(result.ok, `the library rejects the key's chain: ${JSON.stringify(result.failure)}`);
      const wl = chain.decodeLink(links[links.length - 1].link);
      log(trail([wl]));
      assert.equal(JSON.stringify([wl.op, wl.decision, wl.flags & PRESS_OBSERVED, wl.grantId]), JSON.stringify([OP_RECEIPT, NEEDS_REVIEW, PRESS_OBSERVED, uses[0].seq]));
      assert.bytes(Buffer.from(wl.subject), Buffer.from(receipts.settleSubject(uses[0].seq)), 'the settle subject does not name the use it settled');
      const paired = receipts.pairReceipts(links);
      assert.equal(paired.uses.find((u) => u.seq === uses[0].seq).status, 'settled', `use #${uses[0].seq}`);
    });

  /*
   * SETTLE ENDS THE BUDGET (Brad, 2026-10-10: "its more secure to just end the budget instead
   * of allowing it to be continue to be used; this will force a new budget to be created by the
   * agent"). Settled while the budget is still live - a signer that died mid-stream - the key ends
   * it first, with its grant-end link, then writes the settle; the old budget pays for nothing.
   */
  it('edge: a SETTLE while a budget is live ends it first (grant-end link, then the settle); its uses are over',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const b = await openBudget(device, 2, 'okt: two uses, settled after one', { signal });
      const pl = agentPayload('okt settle live 0');
      assert.equal(await txStartFor(device, (await head(device, { signal })).head, pl, { signal }), 'EDGE:00');
      const use = await selfPressedSign(device, pl, { signal });
      let h = await head(device, { signal });
      assert.ok(h.live.includes(b.grantId) && h.owed === 1, 'one use made and owed, the budget still live');

      const [w] = await edge(device, SETTLE, null, { signal, press: true });
      const ws = seqHead(w);
      h = await head(device, { signal });
      assert.equal(JSON.stringify([h.owed, h.live.includes(b.grantId)]), '[0,false]', 'the settle left the budget live');
      const [end, settled] = (await pickup(device, ws.seq - 1, 2, { signal })).map((r) => chain.decodeLink(r.link));
      log(trail([end, settled]));
      assert.equal(JSON.stringify([end.op, end.grantId, end.decision]), JSON.stringify([7, b.grantId, END_SETTLED]), 'no grant-end link (settled) for the settled budget');
      assert.equal(JSON.stringify([settled.op, settled.decision, settled.grantId]), JSON.stringify([OP_RECEIPT, NEEDS_REVIEW, use.seq]));
      /* the agent's next use needs a new budget: nothing can pay now */
      assert.equal(await txStartFor(device, h.head, agentPayload('okt settle live 1'), { signal }), 'EDGE:0D');
    });

  /*
   * The plugin backup section (DESIGN.md 6; the loader's 0xFB section). Edge keeps
   * version, seq, head and the owed uses. EVERY RESTORE CONTINUES THE LOG (Brad,
   * 2026-10-08: "you cant reset bitcoin, so i cant reset our log"; restore-then-replay
   * went as overkill): restored onto the very device that made it, the key draws a new
   * salt - a new device id, never a second writer of the old chain - and its first
   * link is a continue naming the backup's chain, seq and head, the debt carried.
   */
  it('edge: a backup restored onto the device that made it continues the log - a new device id, a continue link first, the debt carried (R28)',
    async ({ device, assert, signal, log }) => {
      const { backup } = ctx.kit;
      const PASSPHRASE = 'okt edge backup passphrase 2026-10-02';
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });

      /* a backup key, which takes config mode - first, as its restart would end the covering budget */
      await device.enterConfigMode(ctx.PINS.primary, { signal });
      let since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({
        msg: ctx.okmsg.MSG.OKSETPRIV, slot: 131,
        payload: Buffer.concat([Buffer.from([161]), sha256(Buffer.from(PASSPHRASE, 'utf8'))]),
      });
      const set = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Successfully|Error/, timeoutMs: 10000, signal });
      assert.match(ctx.okmsg.text(set), /Successfully set Backup Passphrase/);
      /* a slot label too: the proof on older firmware checks it comes back */
      since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: ctx.okmsg.MSG.OKSETSLOT, slot: 2, field: 1, payload: 'edgebkup' });
      const labelled = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Successfully|Error/, timeoutMs: 10000, signal });
      assert.ok(!/Error/.test(ctx.okmsg.text(labelled)), ctx.okmsg.text(labelled));
      await device.restart({ signal });
      await device.unlock(ctx.PINS.primary, { signal });

      /* only budget uses owe (2026-10-06): the debt at the backup is a budget's paid use */
      await openBudget(device, 2, 'okt: a debt before the backup', { signal });
      const plb = agentPayload('okt edge before the backup');
      assert.equal(await txStartFor(device, (await head(device, { signal })).head, plb, { signal }), 'EDGE:00');
      const owedAtBackup = await selfPressedSign(device, plb, { signal });
      const atBackup = await head(device, { signal });
      const backupDeviceId = deviceIdOf(await pubkey(device, { signal }));
      assert.equal(atBackup.owed, 1);

      /* the backup: hold button 1, the key types it */
      let started = false;
      for (let attempt = 1; attempt <= 6 && !started; attempt++) {
        device.log.clear();
        device.keys.clear();
        device.pressLine([{ button: 1, hold: 'hold' }]);
        started = await Promise.any([
          device.log.waitFor(/Backing up Label Number/, { timeoutMs: 5000, signal }),
          device.waitKeystrokes(/-----BEGIN ONLYKEY BACKUP-----/, { timeoutMs: 5000, signal }),
        ]).then(() => true, () => device.keystrokes.length > 0);
      }
      assert.ok(started, 'the device never started a backup');
      /* a hard key types at keyboard speed: the kit's own backup test waits as long (10-backup-restore) */
      await device.waitKeystrokes(/-----END ONLYKEY BACKUP-----/, { timeoutMs: 600000, signal });
      const parsed = backup.parse(device.keystrokes);
      assert.ok(parsed && parsed.data.length, 'no backup data');
      log(`backup: ${parsed.data.length} bytes, taken at chain #${atBackup.seq}`);
      /*
       * Kept for the older-firmware proof (node-onlykey-emulator
       * test/restore-plugin-backup.js and its stored fixture): the same backup
       * restored onto a v3.0.4 emulator, which has no plugin code at all.
       */
      const keep = require('path').join(require('os').tmpdir(), 'okt-plugin-backup.json');
      require('fs').writeFileSync(keep, JSON.stringify({
        passphrase: PASSPHRASE, slot: 2, label: 'edgebkup', data: Buffer.from(parsed.data).toString('hex'),
        /* R28: the chain this backup came from - the next run restores it onto "another device" */
        edge: { deviceId: Buffer.from(backupDeviceId).toString('hex'), seq: atBackup.seq, head: Buffer.from(atBackup.head).toString('hex'), owed: [owedAtBackup.seq] },
      }));
      log(`kept for the older-firmware restore: ${keep}`);

      const stBefore = await ownerKeysOf(device, { signal });
      const ownerBefore = stBefore.owner;
      /* a link the backup does not have: lost with the restore - the continue link names the backup's head, not this one */
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await receipt(device, owedAtBackup.seq, 'okt: paid after the backup', { signal });
      assert.equal((await head(device, { signal })).seq, atBackup.seq + 1);

      /* the restore onto THIS device (config mode) */
      await device.enterConfigMode(ctx.PINS.primary, { signal });
      const gen = device.generation;
      for (const payload of backup.toRestorePackets(parsed.data)) {
        device.sendVendor({ msg: ctx.okmsg.MSG.OKRESTORE, payload });
        await device.sleep(50, { signal });
      }
      await device.waitForReboot({ from: gen, timeoutMs: 90000, signal });
      await device.waitReady({ signal });
      await device.ensureUnlocked(ctx.PINS.primary, { signal });

      const h = await head(device, { signal });
      const id = deviceIdOf(await pubkey(device, { signal }));
      log(`restored this device's own backup of ${Buffer.from(backupDeviceId).toString('hex')} at #${atBackup.seq}: now chain ${Buffer.from(id).toString('hex')} at #${h.seq}, owed ${h.owed}`);
      assert.ok(!Buffer.from(id).equals(Buffer.from(backupDeviceId)), 'the restored key kept its old device id - it would write a second history of that chain');
      assert.equal(h.seq, atBackup.seq + 1, 'the continue link is not the next seq after the backup\'s head');
      assert.equal(h.owed, 1, 'the debt did not carry into the new chain');
      const [c] = await pickup(device, h.seq, 1, { signal });
      const fc = chain.decodeLink(c.link);
      assert.equal(JSON.stringify([fc.op, fc.grantId, fc.flags]), JSON.stringify([16, 1, 0]), 'the first link is not a continue carrying one debt');
      const want = sha256(Buffer.concat([Buffer.from('OKEDGE-CONTINUE-v1'), Buffer.from(backupDeviceId), u32(atBackup.seq), Buffer.from(atBackup.head), u32(owedAtBackup.seq)]));
      assert.bytes(Buffer.from(fc.subject), want, 'the continue subject does not commit to the backup\'s chain, head and debt');
      assert.bytes(Buffer.from(h.head), Buffer.from(chain.weld(chain.genesis(id), c.link)), 'the continue is not welded onto the new device\'s genesis');
      /* the same OnlyKey secret: the owner key is the same before and after - that is how another device knows the log is yours */
      const after2 = await ownerKeysOf(device, { signal });
      assert.ok(Buffer.from(after2.owner).equals(Buffer.from(ownerBefore)), 'the owner key changed with the restore - a restored key would no longer be recognised as yours');
      assert.ok(Buffer.from(after2.ownerPq).equals(Buffer.from(stBefore.ownerPq)), 'the owner ML-DSA key changed with the restore');
      assert.ok(!Buffer.from(after2.pubPq).equals(Buffer.from(stBefore.pubPq)), 'the checkpoint ML-DSA key survived the restore - it must follow the new salt');
      await receipt(device, owedAtBackup.seq, 'okt: the carried debt paid on the new chain', { signal });
      assert.equal((await head(device, { signal })).owed, 0, 'a receipt on the new chain did not pay the carried debt');
    });

  it('edge: a TX start pays for exactly its request - RSA sign, ECC sign, RSA decrypt and a multi-packet sign each self-press, with the lib\'s subject in the link (R13a)',
    async ({ device, assert, signal, log }) => {
      const { pqc } = ctx.kit;
      const RSA_2048 = 2;
      const FEATURE_DECRYPT = 32;
      const FEATURE_SIGN = 64;
      const P256 = 2;
      const rsa = () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = privateKey.export({ format: 'jwk' });
        return { publicKey, pq: Buffer.concat([Buffer.from(jwk.p, 'base64url'), Buffer.from(jwk.q, 'base64url')]) };
      };
      const rsaSign = rsa();
      const rsaDecrypt = rsa();
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      const eccScalar = ecdh.getPrivateKey();
      const eccPub = crypto.createPublicKey({ key: Buffer.concat([P256_SPKI, ecdh.getPublicKey()]), format: 'der', type: 'spki' });

      /* the keys, in one config-mode session (as 19-rsa-keys and 14-stored-keys load them) */
      await pqc.readyForKeygen(device, { signal });
      let since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: ctx.okmsg.MSG.OKSETSLOT, slot: 1, field: 22, payload: Buffer.from([1]) });
      await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Success|Error/, timeoutMs: 8000, signal });
      for (const k of [{ slot: 2, type: RSA_2048 | FEATURE_SIGN, pq: rsaSign.pq }, { slot: 1, type: RSA_2048 | FEATURE_DECRYPT, pq: rsaDecrypt.pq }]) {
        since = device.mark(ctx.IFACE.VENDOR);
        for (let i = 0; i < k.pq.length; i += 57) {
          device.sendVendor({ msg: ctx.okmsg.MSG.OKSETPRIV, slot: k.slot, field: k.type, payload: k.pq.subarray(i, i + 57) });
          await device.sleep(150, { signal });
        }
        const ack = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Successfully|Error/, timeoutMs: 20000, signal });
        assert.match(ctx.okmsg.text(ack), /Successfully set RSA Key/, `RSA slot ${k.slot}: ${ctx.okmsg.text(ack)}`);
      }
      since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: ctx.okmsg.MSG.OKSETPRIV, slot: 101, field: P256 | FEATURE_SIGN, payload: eccScalar });
      const eack = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Success|Error/, timeoutMs: 30000, signal });
      assert.ok(!/Error/.test(ctx.okmsg.text(eack)), `ECC slot 101: ${ctx.okmsg.text(eack)}`);
      await device.sleep(500, { signal });
      await device.restart({ signal });
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });

      const b = await openBudget(device, [
        { op: OP_SIGN, slot: 2, cap: 1 },
        { op: OP_SIGN, slot: 101, cap: 1 },
        { op: OP_DECRYPT, slot: 1, cap: 1 },
        { op: OP_SIGN, slot: 222, cap: 1, label: OKT_LABEL },
      ], 'okt: one of each op type', { signal });

      const rsaMessage = Buffer.from('okt edge RSA sign');
      const eccMessage = Buffer.from('okt edge ECC sign');
      const secret = crypto.randomBytes(32);
      const longMessage = Buffer.alloc(100, 0x5a); /* + the identity hash: 132 bytes, three packets */
      const cases = [
        { name: 'RSA sign (slot 2)', msg: ctx.okmsg.MSG.OKSIGN, slot: 2, op: OP_SIGN, payload: sha256(rsaMessage), want: 256,
          check: (out) => crypto.verify('sha256', rsaMessage, rsaSign.publicKey, out) },
        { name: 'ECC sign (slot 101)', msg: ctx.okmsg.MSG.OKSIGN, slot: 101, op: OP_SIGN, payload: sha256(eccMessage), want: 64,
          check: (out) => crypto.verify('sha256', eccMessage, { key: eccPub, dsaEncoding: 'ieee-p1363' }, out) },
        { name: 'RSA decrypt (slot 1, five packets)', msg: ctx.okmsg.MSG.OKDECRYPT, slot: 1, op: OP_DECRYPT,
          payload: crypto.publicEncrypt({ key: rsaDecrypt.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, secret), want: 32,
          check: (out) => out.equals(secret) },
        { name: 'agent sign (code 222, three packets)', msg: ctx.okmsg.MSG.OKSIGN, slot: 222, op: OP_SIGN,
          payload: Buffer.concat([longMessage, sha256(Buffer.from('okt edge identity'))]), want: 64, check: (out) => out.length === 64 },
      ];
      for (const c of cases) {
        const h = await head(device, { signal });
        const subject = grants.requestSubject(new Uint8Array(c.payload));
        assert.equal(await txStartFor(device, h.head, c.payload, { signal }), 'EDGE:00', `${c.name}: TX start refused`);
        const sent = device.mark(ctx.IFACE.VENDOR);
        sendChunked(device, c.msg, c.slot, c.payload);
        /* no press: an started budget pays */
        const deadline = Date.now() + 10000;
        let out = Buffer.concat(device.reportsSince(ctx.IFACE.VENDOR, sent));
        while (out.length < c.want && Date.now() < deadline) {
          await device.sleep(100, { signal });
          out = Buffer.concat(device.reportsSince(ctx.IFACE.VENDOR, sent));
        }
        out = out.subarray(0, c.want);
        const after = await headPast(device, h.seq, { signal });
        const [l] = await pickup(device, after.seq, 1, { signal });
        const f = chain.decodeLink(l.link);
        log(`${c.name}: #${f.seq} decision ${f.decision} slot ${f.slot} subject ${Buffer.from(f.subject).toString('hex').slice(0, 16)} lib ${Buffer.from(subject).toString('hex').slice(0, 16)}`);
        assert.equal(JSON.stringify([f.op, f.decision, f.slot, f.grantId]), JSON.stringify([c.op, SELF_PRESS, c.slot, b.grantId]), `${c.name}: not a self-press under the budget`);
        assert.bytes(Buffer.from(f.subject), Buffer.from(subject), `${c.name}: the firmware's subject is not the library's requestSubject`);
        /* what came back, in the failure itself: a wrong result is diagnosed from the bytes (GitHub run 40627579932
           failed here once, on ECC slot 101, with nothing to read but this line) */
        assert.ok(c.check(out), `${c.name}: the result does not check out - ${out.length} of ${c.want} bytes: ${ctx.okmsg.text(out) || out.toString('hex').slice(0, 64)}`);
        await receipt(device, f.seq, `okt: ${c.name}`, { signal });
      }
      await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true });
    });

  /*
   * R19 NOT BUILT (spec session, 2026-10-03: the agent's commit key is a
   * derived classic key - D2 - so R19 waits; prove today's behaviour). A
   * composite PQC-PGP signature is TWO OKSIGNs to the RSA slot holding the
   * key: [0x00 | digest] -> Ed25519 (64 B), [0x01 | digest] -> ML-DSA-65
   * (3309 B). Under a budget covering that slot the first half is started and
   * self-pressed, and OWES its receipt (R16); so the second half cannot be
   * started (R18: nothing automatic while a receipt is owed) and goes through
   * only with a physical press - a pressed link, not paid by the budget.
   */
  it('edge: a composite signature under a budget today - the first half is paid and owes its receipt, so the second half needs an ordinary press, no link (R19 not built)',
    async ({ device, assert, signal, log }) => {
      const { pqc } = ctx.kit;
      const RSA_SLOT = 1;
      const PQC_PGP_KEYTYPE_BYTE = 0x67; /* KEYTYPE_PQC_PGP | DECRYPT | SIGN */
      const blob = crypto.randomBytes(160);
      await pqc.readyForKeygen(device, { signal });
      let since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: ctx.okmsg.MSG.OKSETSLOT, slot: RSA_SLOT, field: 22, payload: Buffer.from([1]) }); /* a single press, not a code */
      await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Success|Error/, timeoutMs: 8000, signal });
      since = device.mark(ctx.IFACE.VENDOR);
      for (let i = 0; i < blob.length; i += 57) {
        device.sendVendor({ msg: ctx.okmsg.MSG.OKSETPRIV, slot: RSA_SLOT, field: PQC_PGP_KEYTYPE_BYTE, payload: blob.subarray(i, i + 57) });
        await device.sleep(150, { signal });
      }
      const ack = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Successfully|Error/, timeoutMs: 15000, signal });
      assert.ok(!/^Error/.test(ctx.okmsg.text(ack).trim()), `loading the composite key failed: ${ctx.okmsg.text(ack)}`);
      await device.sleep(500, { signal });
      await device.restart({ signal });
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });

      const b = await openBudget(device, [{ op: OP_SIGN, slot: RSA_SLOT, cap: 2 }], 'okt: a composite signature', { signal });
      const digest = sha256(Buffer.from('okt edge composite commit'));
      const collect = async (sent, want, ms) => {
        const deadline = Date.now() + ms;
        let out = Buffer.concat(device.reportsSince(ctx.IFACE.VENDOR, sent));
        while (out.length < want && Date.now() < deadline) {
          await device.sleep(100, { signal });
          out = Buffer.concat(device.reportsSince(ctx.IFACE.VENDOR, sent));
        }
        return out.subarray(0, want);
      };

      /* half 1, Ed25519: started, the budget pays, and it owes its receipt */
      const half1 = Buffer.concat([Buffer.from([0x00]), digest]);
      let h = await head(device, { signal });
      assert.equal(await txStartFor(device, h.head, half1, { signal }), 'EDGE:00', 'half 1: TX start refused');
      let sent = device.mark(ctx.IFACE.VENDOR);
      sendChunked(device, ctx.okmsg.MSG.OKSIGN, RSA_SLOT, half1);
      assert.equal((await collect(sent, 64, 10000)).length, 64, 'half 1: no Ed25519 signature');
      let after = await headPast(device, h.seq, { signal });
      const f1 = chain.decodeLink((await pickup(device, after.seq, 1, { signal }))[0].link);
      log(`half 1: #${f1.seq} decision ${f1.decision} flags ${f1.flags} grant ${f1.grantId}`);
      assert.equal(JSON.stringify([f1.decision, f1.grantId, f1.flags & OWES_RECEIPT]), JSON.stringify([SELF_PRESS, b.grantId, OWES_RECEIPT]), 'half 1: not a self-press that owes its receipt');

      /* half 2, ML-DSA-65: the TX start is refused while half 1's receipt is owed (R18) ... */
      const half2 = Buffer.concat([Buffer.from([0x01]), digest]);
      h = await head(device, { signal });
      const tx2 = await txStartFor(device, h.head, half2, { signal });
      assert.notEqual(tx2, 'EDGE:00', 'half 2 was started while half 1 owed its receipt');
      log(`half 2: TX start refused ${tx2}`);
      /*
       * ... so it waits for a physical press - an ORDINARY press (2026-10-06): not
       * the budget's, not Edge, no link, nothing owed; half 1 is still the only debt
       */
      sent = device.mark(ctx.IFACE.VENDOR);
      sendChunked(device, ctx.okmsg.MSG.OKSIGN, RSA_SLOT, half2);
      await device.sleep(1500, { signal });
      assert.equal(Buffer.concat(device.reportsSince(ctx.IFACE.VENDOR, sent)).length >= 3309, false, 'half 2 was signed without a press');
      device.press(1);
      assert.equal((await collect(sent, 3309, 20000)).length, 3309, 'half 2: no ML-DSA-65 signature after the press');
      const h2 = await head(device, { signal });
      log(`half 2: head #${h2.seq} owed ${h2.owed}`);
      assert.equal(h2.seq, h.seq, 'half 2 (an ordinary press) wrote a link');
      assert.equal(h2.owed, 1, 'half 2 owes, or half 1\'s debt went');

      /* half 1's receipt, then the budget ends */
      await receipt(device, f1.seq, 'okt: composite half 1', { signal });
      await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true });
    });

  /* R15b: a budget lives its lifetime from the press, and the lifetime is in its opening link */
  it('edge: a budget expires after its lifetime - nothing starts under it, HEAD drops it, and its opening link carries the lifetime (R15b)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const b = await openBudget(device, 2, 'okt: one minute', { signal, lifetime: 1 });
      const [opened] = await pickup(device, b.chainSeq, 1, { signal });
      assert.bytes(Buffer.from(chain.decodeLink(opened.link).subject),
        Buffer.from(grants.grantSubject({ scopes: scopesOf(2), reasonHash: b.reasonHash, genesis: b.G, lifetime: 1 })),
        'the opening link does not carry the 1-minute lifetime');
      let h = await head(device, { signal });
      assert.ok(h.live.includes(b.grantId));
      assert.equal(await txStartFor(device, h.head, agentPayload('okt before expiry'), { signal }), 'EDGE:00');
      /* in 10 s steps, reading HEAD each time: the kit's watchdog wants progress every 30 s */
      const until = Date.now() + 62000;
      while (Date.now() < until) {
        await device.sleep(Math.min(10000, Math.max(0, until - Date.now())), { signal });
        h = await head(device, { signal });
      }
      log(`after 62 s: live ${JSON.stringify(h.live)}`);
      assert.ok(!h.live.includes(b.grantId), 'HEAD still lists an expired budget');
      assert.equal(await txStartFor(device, h.head, agentPayload('okt after expiry'), { signal }), 'EDGE:0D', 'TX start went through under an expired budget');
    });

  /* R11 (Brad, 2026-10-02: back to 1024): a budget of 1024 uses opens - G is 1,024 hashes - and 1025 is refused */
  it('edge: a budget of 1024 uses opens at a press; 1025 is refused (R11)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      let h = await head(device, { signal });
      /* encoded by hand: the library already refuses 1025 on the host - this is the firmware's own check */
      const raw = (caps) => {
        const req = Buffer.alloc(58);
        req[0] = caps.length;
        caps.forEach(([slot, cap], i) => { req[1 + 4 * i] = OP_SIGN; req[2 + 4 * i] = slot; req.writeUInt16LE(cap, 3 + 4 * i); });
        sha256(Buffer.from('okt: too many')).copy(req, 17);
        Buffer.from(h.head).copy(req, 52, 0, 6);
        return req;
      };
      /* on stored slots (RSA2, ECC1): this is the use cap, not R11a's identity rule */
      assert.equal(await edge(device, GRANT_CREATE, raw([[2, 1025]]), { signal, text: true }), 'EDGE:04', 'a 1025-use budget was taken');
      assert.equal(await edge(device, GRANT_CREATE, raw([[2, 1000], [101, 25]]), { signal, text: true }), 'EDGE:04', 'two scopes summing to 1025 were taken');
      const b = await openBudget(device, 1024, 'okt: 1024 uses', { signal });
      log(`budget ${b.grantId}: ${b.uses} uses`);
      assert.equal(b.uses, 1024);
      /* G really is H^1024 of the seed: the first reveal hashes back to it in 1024 steps - checked on the first self-press */
      h = await head(device, { signal });
      const pl = agentPayload('okt: the first of 1024');
      assert.equal(await txStartFor(device, h.head, pl, { signal }), 'EDGE:00');
      const s1 = await selfPressedSign(device, pl, { signal });
      const [l] = await pickup(device, s1.seq, 1, { signal });
      const f = chain.decodeLink(l.link);
      assert.equal(JSON.stringify([f.decision, f.grantStep]), JSON.stringify([SELF_PRESS, 1]));
      const spend = { step: 1, value: l.reveal, subject: new Uint8Array(sha256(pl)), mac: new Uint8Array(crypto.createHmac('sha256', l.reveal).update(sha256(pl)).digest()) };
      assert.equal(JSON.stringify(grants.checkSpends(b.G, 1024, [spend])), '{"ok":true,"spent":1}', 'the first reveal of a 1024-use budget does not hash back to G');
      await receipt(device, s1.seq, 'okt: 1 of 1024', { signal });
      await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true });
    });

  /* R24: the person accepts a range as lost - a pressed link with the spec layout (the tab's red banner) */
  it('edge: LOSS {from, to} takes a press and links the accepted range; a range past the head is refused (R24)',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      let h = await ensureChain(device, 12, { signal }); /* #2 must be out of the ring (8) */
      assert.equal(await edge(device, LOSS, Buffer.concat([u32(0), u32(h.seq + 5)]), { signal, text: true }), 'EDGE:12', 'a loss past the head was taken');
      assert.equal(await edge(device, LOSS, Buffer.concat([u32(2), u32(1)]), { signal, text: true }), 'EDGE:12', 'a backwards range was taken');
      const [r] = await edge(device, LOSS, Buffer.concat([u32(0), u32(1)]), { signal, press: true });
      const seq = r.readUInt32LE(0);
      h = await head(device, { signal });
      assert.equal(seq, h.seq);
      const [l] = await pickup(device, seq, 1, { signal });
      const f = chain.decodeLink(l.link);
      /* #2 is long out of the key's ring (8) by now, so the LOSS names no next link: zeros */
      assert.ok(seq - 1 - 2 >= 8, `the story is too short for #2 to be out of the ring (head #${seq - 1})`);
      assert.equal(JSON.stringify([f.op, f.decision, f.slot, f.flags & PRESS_OBSERVED, f.grantId, f.grantStep, Buffer.from(f.subject).readUInt32LE(0), Buffer.from(f.subject).subarray(4).every((x) => x === 0)]),
        JSON.stringify([11, APPROVE, 0, PRESS_OBSERVED, 0, 0, 1, true]), 'the LOSS link is not the spec layout');

      /*
       * R24 (Brad, 2026-10-02): when the key holds link to+1 - its latest, or one
       * in the ring - the subject carries the first 28 bytes of SHA-256 of it,
       * from the key's own memory.
       */
      const named = async (to) => {
        const [want] = await pickup(device, to + 1, 1, { signal });
        const [rr] = await edge(device, LOSS, Buffer.concat([u32(to), u32(to)]), { signal, press: true });
        const [ll] = await pickup(device, rr.readUInt32LE(0), 1, { signal });
        const sub = Buffer.from(chain.decodeLink(ll.link).subject);
        assert.equal(sub.readUInt32LE(0), to);
        assert.bytes(sub.subarray(4), sha256(Buffer.from(want.link)).subarray(0, 28));
      };
      h = await head(device, { signal });
      await named(h.seq - 1); /* to+1 = the latest link */
      h = await head(device, { signal });
      await named(h.seq - 3); /* to+1 = a link in the ring */
    });

  /*
   * Agent registration is gone (Brad, 2026-10-08: "so the claude key thing is overkill"; "lets
   * cut it out"): a computer is trusted by its Bluetooth pairing, the key keeps no agent. The old
   * AGENT_ADD sub-op (0x15) is an unknown request now: refused at once, no press asked, no link.
   */
  it('edge: the retired AGENT_ADD (0x15) is refused as unknown - no press, no link',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const before = await head(device, { signal });
      const t = await edge(device, RETIRED_AGENT_ADD, crypto.randomBytes(32), { signal, text: true });
      assert.match(t, /^EDGE:0A/i, 'the retired AGENT_ADD was not refused as unknown');
      assert.equal((await head(device, { signal })).seq, before.seq, 'the retired AGENT_ADD wrote a link');
    });

  it('edge: a budget on a derived code covers one identity - another identity on the same code is neither paid for nor made to owe (R11a)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const other = sha256(Buffer.from('okt someone else'));
      const payloadAs = (text, label) => Buffer.concat([sha256(Buffer.from(text)), label]);
      /* read each link right after the use that made it: the key holds only its last 8 */
      const fieldsOf = async (seq) => chain.decodeLink((await pickup(device, seq, 1, { signal }))[0].link);

      /* no label staged: a derived-code scope is refused (EDGE:03); stored slots never needed one */
      const h0 = await head(device, { signal });
      assert.equal(await edge(device, GRANT_CREATE, grantRequest(2, sha256(Buffer.from('r')), h0.head), { signal, text: true }), 'EDGE:03',
        'a budget on a derived code without an identity was taken');

      /* a live budget for OKT_LABEL: direct presses by either identity are ordinary - no link, nothing owed (2026-10-06) */
      const b = await openBudget(device, 2, 'okt: the test identity, 2 signs', { signal });
      const hb = await head(device, { signal });
      const sendDirect = async (text, payload) => {
        const primed = device.log.count(PRIMED);
        const since = device.mark(ctx.IFACE.VENDOR);
        sendChunked(device, ctx.okmsg.MSG.OKSIGN, 222, payload);
        await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
        await device.sleep(500, { signal });
        device.press(1);
        await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
      };
      await sendDirect('theirs', payloadAs('okt other identity, direct', other));
      await sendDirect('ours', agentPayload('okt our identity, direct'));
      const hd = await head(device, { signal });
      assert.equal(JSON.stringify([hd.seq, hd.owed]), JSON.stringify([hb.seq, 0]), 'a direct press (either identity) wrote a link or owes');

      /*
       * a TX start for another identity's request: no budget pays it, so the sign is an
       * ordinary request - the press decides, no link, nothing owed (Brad, 2026-10-08:
       * refusing it was a misreading of "budget or no go"). The TX start is spent there:
       * our own TX start right after still works.
       */
      const plOther = payloadAs('okt other identity, started', other);
      assert.equal(await txStartFor(device, hd.head, plOther, { signal }), 'EDGE:00');
      await sendDirect('theirs, started', plOther);
      const ho = await head(device, { signal });
      assert.equal(JSON.stringify([ho.seq, ho.owed]), JSON.stringify([hd.seq, 0]), 'an unpaid started sign wrote a link or owes');
      const pl = agentPayload('okt our identity, started');
      assert.equal(await txStartFor(device, (await head(device, { signal })).head, pl, { signal }), 'EDGE:00');
      const paid = await selfPressedSign(device, pl, { signal });
      const fp = await fieldsOf(paid.seq);
      log(trail([fp]));
      assert.equal(JSON.stringify([fp.decision, fp.grantId]), JSON.stringify([SELF_PRESS, b.grantId]), 'the budget did not pay for its own identity');
      await receipt(device, paid.seq, 'okt: ours, started', { signal });
      assert.equal(await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true }), 'EDGE:00');
    });

  it('edge: a checkpoint is two signatures over the head - the P-256 key\'s and its ML-DSA-65 twin\'s, both required',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const h = await ensureChain(device, 1, { signal }); /* an empty chain has no head to sign */
      const pub = await pubkey(device, { signal });
      const pubPq = await pubkeyPq(device, 0, { signal });
      const ownerPq = await pubkeyPq(device, 1, { signal });
      assert.equal(pubPq.length, PQ_PK);
      assert.ok(!Buffer.from(pubPq).equals(Buffer.from(ownerPq)), 'the checkpoint key and the owner key are the same ML-DSA key');
      const t0 = Date.now();
      /* the key gives no head and no free checkpoint: HEAD's head bytes are zero, CHECKPOINT is unknown */
      assert.ok(h.keyHead.every((x) => x === 0), 'HEAD revealed the head');
      assert.equal(h.caps & 1, 1, 'HEAD byte 59 does not say CERTIFY_HEADPROOF');
      assert.equal(await edge(device, RETIRED_CHECKPOINT, null, { signal, text: true }), 'EDGE:0A', 'CHECKPOINT still answers');
      /* a head the kit did not weld is refused; the welded one is confirmed */
      const wrong = Buffer.from(h.head); wrong[0] ^= 1;
      assert.equal(await edge(device, PROVE_HEAD, Buffer.concat([u32(h.seq), wrong]), { signal, text: true }), 'EDGE:0B', 'a wrong head was confirmed');
      const rs = await edge(device, PROVE_HEAD, Buffer.concat([u32(h.seq), Buffer.from(h.head)]), { signal, reports: 2 + PQ_SIG_REPORTS });
      log(`the hybrid confirmation: ${rs.length} reports in ${Date.now() - t0} ms`);
      const [c, s] = rs;
      const sigPq = joined(rs.slice(2), PQ_SIG);
      assert.ok(checkpointVerifies(pub, h.seq, h.head, s, pubPq, sigPq), 'the checkpoint does not verify (both halves)');
      assert.equal(c.readUInt32LE(0), h.seq);
      assert.bytes(c.subarray(4, 36), Buffer.from(h.head));
      /* and over THIS head only */
      assert.ok(!checkpointVerifies(pub, h.seq, new Uint8Array(32).fill(1), s, pubPq, sigPq), 'a checkpoint verified over another head');
      /* each half alone is not a checkpoint: a flipped byte in the ML-DSA half, or the owner's ML-DSA key */
      const bad = Uint8Array.from(sigPq); bad[100] ^= 1;
      assert.ok(!checkpointVerifies(pub, h.seq, h.head, s, pubPq, bad), 'a checkpoint with a broken ML-DSA half verified');
      assert.ok(!checkpointVerifies(pub, h.seq, h.head, s, ownerPq, sigPq), 'the checkpoint\'s ML-DSA half verified under the owner key');
      /* PICKUP carries the link, never its head */
      const [last] = await pickup(device, h.seq, 1, { signal });
      assert.equal(last.head, null, 'PICKUP revealed a head');
    });

  /*
   * THE AGENT SERVICE ON THE REAL EDGE FIRMWARE (Edge Phase 2, build step 1 -
   * onlykey-edge SPEC.md: "emulator first, no hardware"). The lib's
   * own edge-agent (edge/cli/agent.js) over the kit's emulator (the kit's
   * libstack), the phone's side in-process (approve.approveRequest), presses
   * by the emulator. A scratch repo: `git commit -S` inside `onlykey-js edge exec`, an
   * ssh sign on the exec's endpoint bound to a pinned host - each a self-press
   * paid by the budget, each receipted. And the must-fail-safely checks
   * (daily-loop §3): the shared endpoint is a press, a skipped receipt and a
   * stale head refuse the next exec before it runs, Hold refuses it too.
   */
  it('edge: the agent service on the emulator - a signed commit and an ssh sign paid by the budget and receipted; there is no shared endpoint; skipped receipt, stale head and Hold refuse the next exec',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const net = require('net');
      const { execFileSync } = require('child_process');
      const { request, approve, client, codes } = ctx.requireLib('node-onlykey-lib/edge');
      const { startEdgeAgent } = ctx.requireLib('node-onlykey-lib/cli/edge-agent');
      /* one CLI (CLI.md, 2026-10-06): okedge is gone - onlykey-js edge's commands, asking the service's control endpoint */
      const commands = ctx.requireLib('node-onlykey-lib/edge/cli/commands');
      const control = ctx.requireLib('node-onlykey-lib/cli/edge-control');
      const wire = ctx.requireLib('node-onlykey-lib/cli/ssh-wire');
      const bindLib = ctx.requireLib('node-onlykey-lib/cli/ssh-session-bind');
      const hexOf = (b) => Buffer.from(b).toString('hex');
      const pressSoon = () => { setTimeout(() => device.press(1), 900); };

      const lib = await ctx.kit.libstack.composeLib(device);
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okt-edge-agent-'));
      control.setHome(home); /* a test home: setHome, never the env (CLI.md §5) */
      let svc = null;
      try {
        const { okcrypto, transport } = lib.services;
        let edgeSvc = null;
        ctx.requireLib('node-onlykey-lib/plugins/edge')({ transport }, (err, s) => { if (err) throw err; edgeSvc = s.edge; });

        /* the phone, in-process: a paired computer (no agent key since 2026-10-08 - the pairing says who), Yes, and the press the key waits for */
        const seen = new Set();
        const channel = {
          async send(msg) {
            const r = await approve.approveRequest(msg, {
              edge: edgeSvc, from: 'pc-okt', seen, ask: async () => 'approve',
              verifyCopy: async () => ({ ok: true, head: (await edgeSvc.head()).head }), onPress: pressSoon, timeoutMs: 30000,
            });
            return r.dropped ? null : r;
          },
        };
        const c = client.createEdgeClient({ edge: edgeSvc, channel });

        /* a host key standing in for github.com, pinned */
        const hk = crypto.generateKeyPairSync('ed25519');
        const hostBlob = Buffer.concat([wire.string(Buffer.from('ssh-ed25519')), wire.string(hk.publicKey.export({ format: 'der', type: 'spki' }).subarray(12))]);
        /*
         * the agent identity the phone keeps (lib SPEC H7): the record `edge setup` makes - its certificate made on
         * this key (two signatures, a press each) - handed to the agent's start, which makes none itself
         */
        const openpgp = ctx.requireLib('node-onlykey-lib/crypto/pgp');
        const uid = 'Claude (okt agent) <claude@okt>';
        const made = await ctx.requireLib('node-onlykey-lib/keychain').cert.makeCertificate(okcrypto, openpgp, { label: uid, version: 2, expires: 0, onPress: pressSoon });
        const identity = {
          ssh: 'ssh://claude@okt', gpgUid: uid, committer: { name: 'Claude (okt agent)', email: 'claude@okt' }, expires: 0,
          cert: { armored: made.armored, fingerprint: made.fingerprint, created: made.created, expires: made.expires, signPublic: Buffer.from(made.signPublic).toString('hex') },
        };
        svc = await startEdgeAgent({
          okcrypto, client: c, edge: edgeSvc, identity, pins: [bindLib.fingerprint(hostBlob)], openpgp,
          shimCommand: ctx.resolveLib('node-onlykey-lib/edge/cli/gpg-shim').split(path.sep).join('/'),
          log, confirm: pressSoon, /* any plain sign: a press */
        });
        log(`ssh key: ${svc.sshLine}`);
        assert.equal(svc.fingerprint, made.fingerprint, 'the agent serves the certificate made on this key');
        const lastLink = async () => { const h = await edgeSvc.head(); return chain.decodeLink((await edgeSvc.pickup(h.seq, 1))[0].link); };
        const run = async (args) => { const lines = []; const code = await commands.main(args, { out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), ask: control.ask }); log(lines.join(' | ')); return { code, lines }; };

        /* A1: one Yes + press for the work budget */
        let r = await run(['budget', '--reason', 'okt: commit and push', '--ssh', '3', '--gpg', '3', '--ttl', '30']);
        assert.equal(r.code, 0, r.lines.join('\n'));
        let head = r.lines.find((l) => l.startsWith('head = ')).slice(7);

        /* A4: a signed commit inside onlykey-js edge exec - a self-press paid by the budget, then its receipt */
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'okt-edge-repo-'));
        execFileSync('git', ['-C', repo, 'init', '-q']);
        execFileSync('git', ['-C', repo, 'config', 'user.name', 'Claude (okt agent)']);
        execFileSync('git', ['-C', repo, 'config', 'user.email', 'claude@okt']);
        r = await run(['exec', '--head', head, '--reason', 'commit: okt edge', '--', 'git', '-C', repo, 'commit', '-q', '--allow-empty', '-S', '-m', 'okt: signed by the agent']);
        assert.equal(r.code, 0, r.lines.join('\n'));
        let f = await lastLink();
        assert.equal(JSON.stringify([f.decision, f.grantId !== 0]), JSON.stringify([codes.DECISION.SELF_PRESS, true]), 'the commit signature was not paid by the budget');
        assert.match(execFileSync('git', ['-C', repo, 'cat-file', 'commit', 'HEAD']).toString(), /\ngpgsig -----BEGIN PGP SIGNATURE-----/);
        let seq = Number(/link #(\d+)/.exec(r.lines.find((l) => l.startsWith('signed:')))[1]);
        r = await run(['receipt', String(seq), '--msg', 'committed okt: signed by the agent']);
        head = r.lines.find((l) => l.startsWith('head = ')).slice(7);

        /* A4: an ssh sign on the exec's endpoint, bound to the pinned host */
        const sshSign = async (sockPath, bound = true) => {
          const sid = crypto.randomBytes(32);
          const sig = crypto.sign(null, sid, hk.privateKey);
          const bind = Buffer.concat([Buffer.of(wire.MSG.EXTENSION), wire.string(Buffer.from(bindLib.SESSION_BIND)), wire.string(hostBlob), wire.string(sid),
            wire.string(Buffer.concat([wire.string(Buffer.from('ssh-ed25519')), wire.string(sig)])), Buffer.of(0)]);
          const data = Buffer.concat([wire.string(sid), Buffer.of(50), wire.string(Buffer.from('git')), wire.string(Buffer.from('ssh-connection'))]);
          const keyBlob = wire.publicKeyBlob('ed25519', Buffer.from(svc.sshLine.split(' ')[1], 'base64').subarray(19));
          const msgs = [...(bound ? [bind] : []), Buffer.concat([Buffer.of(wire.MSG.SIGN_REQUEST), wire.string(keyBlob), wire.string(data), wire.uint32(0)])];
          const sock = net.connect(sockPath);
          await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
          const replies = [];
          const feed = wire.createDeframer((m) => replies.push(m));
          sock.on('data', (d) => feed(d));
          for (const m of msgs) {
            const want = replies.length + 1;
            sock.write(wire.frame(m));
            const until = Date.now() + 30000;
            while (replies.length < want && Date.now() < until) await device.sleep(100, { signal });
          }
          sock.destroy();
          return replies[replies.length - 1];
        };
        const ex = await svc.agent.openExec({ head, reason: 'push okt to origin/master' });
        assert.equal((await sshSign(ex.sshPath))[0], wire.MSG.SIGN_RESPONSE);
        const [sshLink] = await ex.close();
        assert.equal(sshLink && sshLink.paid, true, 'the ssh sign was not paid by the budget');
        f = await lastLink();
        assert.equal(f.decision, codes.DECISION.SELF_PRESS);

        /* must fail safely: a skipped receipt refuses the next exec before it runs */
        r = await run(['exec', '--head', svc.agent.budget().head(), '--reason', 'skipped receipt', '--', 'git', '--version']);
        assert.equal(r.code, 1);
        assert.match(r.lines.join('\n'), /receipt owed for #/);
        r = await run(['receipt', String(sshLink.seq), '--msg', 'pushed okt']);
        head = r.lines.find((l) => l.startsWith('head = ')).slice(7);

        /* there is no shared endpoint (CLI.md §4, 2026-10-06): the agent's key is reached only through an exec, under the budget */
        assert.equal(svc.sharedPath, undefined, 'the service still serves a shared endpoint');

        /* must fail safely: a stale head; Hold from the phone */
        r = await run(['exec', '--head', '00'.repeat(32), '--reason', 'stale', '--', 'git', '--version']);
        assert.match(r.lines.join('\n'), /--head is not the budget's head/);
        await edgeSvc.hold(svc.agent.budget().grantId);
        r = await run(['exec', '--head', svc.agent.budget().head(), '--reason', 'held', '--', 'git', '--version']);
        assert.match(r.lines.join('\n'), /on hold/);

        r = await run(['end']);
        assert.match(r.lines.join('\n'), /ended/);
      } finally {
        if (svc) await svc.close();
        await lib.destroy();
        control.setHome(null);
      }
    });

  /*
   * R28 (onlykey-edge SPEC.md, decided 2026-10-04): one chain per physical
   * device. "Another device restored from the same backup" is exactly what this
   * file sees across two runs: every run starts from the kit's cached
   * 'initialized' snapshot (the same K132) but makes a NEW salt on its first Edge
   * request. So the backup the R26 test kept LAST run (read when this file loads), restored here, comes
   * from another device: the key must start its own chain with a continue link -
   * the next seq, on its own genesis, carrying the debts - and never write onto
   * the backup's chain (R26 replay is for a device's own chain only). LAST in the
   * file: the restore brings in that run's keys, which no later test expects.
   */
  it('edge: a backup from another device starts this device\'s own chain - a continue link first, the debts carried, never a second writer (R28)',
    async ({ device, assert, signal, log, skip }) => {
      /* read when this file was loaded: the same-device restore test above has since kept THIS run's backup */
      const kept = keptAtLoad;
      if (!kept) skip('no backup kept by an earlier run yet - the same-device restore test keeps one; run this file again');
      if (!kept.edge) skip('the kept backup predates R28 (it does not name its chain) - run this file again');
      const from = { deviceId: Buffer.from(kept.edge.deviceId, 'hex'), seq: kept.edge.seq, head: Buffer.from(kept.edge.head, 'hex'), owed: kept.edge.owed };

      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const mine = deviceIdOf(await pubkey(device, { signal }));
      assert.ok(!Buffer.from(mine).equals(from.deviceId), 'this run has the same Edge device id as the last one - the salt is not per device');

      /* the backup key the backup was made under, then the restore (config mode) */
      await device.enterConfigMode(ctx.PINS.primary, { signal });
      let since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({
        msg: ctx.okmsg.MSG.OKSETPRIV, slot: 131,
        payload: Buffer.concat([Buffer.from([161]), sha256(Buffer.from(kept.passphrase, 'utf8'))]),
      });
      const set = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Successfully|Error/, timeoutMs: 10000, signal });
      assert.match(ctx.okmsg.text(set), /Successfully set Backup Passphrase/);
      await device.restart({ signal });
      await device.unlock(ctx.PINS.primary, { signal });
      await device.enterConfigMode(ctx.PINS.primary, { signal });
      const gen = device.generation;
      for (const payload of ctx.kit.backup.toRestorePackets(Buffer.from(kept.data, 'hex'))) {
        device.sendVendor({ msg: ctx.okmsg.MSG.OKRESTORE, payload });
        await device.sleep(50, { signal });
      }
      await device.waitForReboot({ from: gen, timeoutMs: 90000, signal });
      await device.waitReady({ signal });
      await device.ensureUnlocked(ctx.PINS.primary, { signal });

      const h = await head(device, { signal });
      const pub = await pubkey(device, { signal });
      const id = deviceIdOf(pub);
      log(`restored a backup of chain ${kept.edge.deviceId} at #${from.seq} (owed ${from.owed.join(',')}): now chain ${Buffer.from(id).toString('hex')} at #${h.seq}, owed ${h.owed}`);
      assert.ok(!Buffer.from(id).equals(from.deviceId), 'the restored key took the backup\'s chain id - it would be a second writer of that chain');
      /* not "the same id as before": a restore brings back the backup's K132, and the id is HKDF(this device's salt, K132) - what must hold is that it is never the backup's chain (checked above) */
      assert.equal(h.seq, from.seq + 1, 'the continue link is not the next seq after the backup\'s head');
      assert.equal(h.owed, from.owed.length, 'the debts did not carry into the new chain');

      const [c] = await pickup(device, h.seq, 1, { signal });
      const f = chain.decodeLink(c.link);
      assert.equal(f.op, 16, 'the first link is not a continue');
      assert.equal(f.grantId, from.owed.length, 'grant_id is not the number of debts carried');
      assert.equal(f.flags, 0);
      const seqs = from.owed.map((n) => u32(n));
      const want = sha256(Buffer.concat([Buffer.from('OKEDGE-CONTINUE-v1'), from.deviceId, u32(from.seq), from.head, ...seqs]));
      assert.bytes(Buffer.from(f.subject), want, 'the continue subject does not commit to the backup\'s chain, head and debts');
      assert.bytes(Buffer.from(h.head), Buffer.from(chain.weld(chain.genesis(id), c.link)), 'the continue is not welded onto this device\'s own genesis');
      assert.bytes(Buffer.from(h.head), Buffer.from(c.head));
    });

  /*
   * OVER WEBAUTHN (Brad, 2026-10-28: Edge needs a WebAuthn path, so the web app can be the key's host for agents). The
   * same Edge, reached through the WebAuthn tunnel alone: the lib composed as a page composes it (kit lib/webenv.js),
   * with its edge plugin. Edge's own requests go as OKEDGE through okcrypto's supplied ctap (okcrypto.tunnelRequest),
   * answered by this plugin's okplugin_edge_ctap() when ctap_bridge is built in; a budget's sign is an ordinary agent
   * OKSIGN over the tunnel, paid by the budget's self-press. Each answer is checked against what USB says, and the
   * grant's checkpoint carries its ML-DSA-65 twin - an answer of its own over WebAuthn (SUB.MORE).
   */
  it('edge: over WebAuthn - HEAD as over USB, a budget at a press (both checkpoint signatures), a sign it pays, the receipt, the links (ctap_bridge)',
    async ({ device, assert, signal, log }) => {
      await device.restart({ signal });
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const usb = await head(device, { signal });

      const Rectify = ctx.requireLib('@bmatusiak/rectify');
      const plugins = ['host', 'transport/tunnel', 'session', 'device', 'okcrypto', 'edge']
        .map((p) => ctx.requireLib(`node-onlykey-lib/plugins/${p}`));
      const { createWebAuthnCtap } = ctx.requireLib('node-onlykey-lib/transport/webauthn');
      const { window } = ctx.kit.webenv.create(device, { signal });
      plugins.config = { okcrypto: { ctap: createWebAuthnCtap({ credentials: window.navigator.credentials }) } };
      const app = await new Promise((resolve, reject) => {
        const a = Rectify.build(plugins, (err, started) => (err ? reject(err) : resolve(started)));
        a.start();
      });
      try {
        const { okcrypto, edge: web } = app.services;
        await okcrypto.connectTunnel();

        const h = await web.head();
        assert.equal(h.seq === null ? SEQ_NONE : h.seq, usb.seq, 'HEAD over WebAuthn: another seq than over USB');
        assert.bytes(Buffer.from(h.head), Buffer.from(usb.head), 'HEAD over WebAuthn: another head than over USB');

        /*
         * a budget at a press: one agent sign (code 222) for the test identity. The press lands once the key is waiting:
         * an Edge press prints no "Encrypted Buffer" (that is a sign's), so the cue is the grant's own seed - its
         * "Generating random number" - and then the USB test's 800 ms (edge(), press: true)
         */
        const SEEDED = /Generating random number of size = 32/g;
        const seeded = device.log.count(SEEDED);
        const g = await web.grant({
          scopes: [{ op: OP_SIGN, slot: 222, cap: 1, label: OKT_LABEL }],
          reasonHash: new Uint8Array(sha256(Buffer.from('okt: edge over webauthn'))),
          verifiedHead: h.head,
          onPress: () => {
            device.log.waitForCount(SEEDED, seeded + 1, { timeoutMs: 20000, signal })
              .then(() => device.sleep(800, { signal })).then(() => device.press(1), () => {});
          },
        });
        log(`budget #${g.grantId} (${g.uses} use) at #${g.seq}; checkpoint #${g.checkpoint.seq}`);
        const { publicKey } = await web.publicKey();
        const pubPq = await web.publicKeyPq('checkpoint');
        assert.ok(checkpointVerifies(publicKey, g.checkpoint.seq, g.checkpoint.head, g.checkpoint.signature, pubPq, g.checkpoint.signaturePq),
          'the grant\'s checkpoint over WebAuthn: P-256 and ML-DSA-65 (SUB.MORE) do not both verify');

        /*
         * a CHECKPOINT on its own, no press: what a new device anchors its copy on instead of reading the key's
         * history (a web app opened in a fresh browser) - the key's head, signed with both halves, over WebAuthn
         */
        const now = await web.head();
        const cp = await web.checkpoint();
        log(`checkpoint alone: #${cp.seq} (head #${now.seq})`);
        assert.equal(cp.seq, now.seq, 'CHECKPOINT over WebAuthn: another seq than the head');
        assert.bytes(Buffer.from(cp.head), Buffer.from(now.head), 'CHECKPOINT over WebAuthn: another head than HEAD');
        assert.ok(checkpointVerifies(publicKey, cp.seq, cp.head, cp.signature, pubPq, cp.signaturePq),
          'CHECKPOINT over WebAuthn: P-256 and ML-DSA-65 (SUB.MORE) do not both verify');

        /* the sign the budget pays: TX start over WebAuthn, then the agent sign over the tunnel - no press */
        const message = agentPayload('okt edge over webauthn');
        const before = await web.head();
        await web.txStart(before.head, grants.requestSubject(new Uint8Array(message)));
        const sig = await okcrypto.sign(222, message, { expectBytes: 64 });
        assert.equal(sig.length, 64, 'the agent sign over the tunnel: not 64 bytes');
        const after = await web.head();
        const [l] = await web.pickup(after.seq, 1);
        const f = chain.decodeLink(l.link);
        assert.equal(JSON.stringify([f.op, f.decision, f.slot, f.grantId]), JSON.stringify([OP_SIGN, SELF_PRESS, 222, g.grantId]),
          'the sign over WebAuthn is not a self-press under the budget');
        assert.bytes(Buffer.from(f.subject), Buffer.from(grants.requestSubject(new Uint8Array(message))), 'its subject is not the library\'s requestSubject');

        /* the receipt over WebAuthn (it completes the budget), then every link since the grant (PICKUP: 3 per request) */
        const rc = await web.receipt(f.seq, 0, new Uint8Array(sha256(Buffer.from('okt: edge over webauthn receipt'))));
        const count = rc.seq - g.seq + 1;
        const links = await web.pickup(g.seq, count);
        assert.equal(links.length, count, `PICKUP over WebAuthn: ${links.length} of ${count} links`);
        links.forEach((x, i) => assert.equal(chain.decodeLink(x.link).seq, g.seq + i, `link ${i} is out of order`));
        const end = await web.head();
        assert.ok(!end.live.includes(g.grantId), 'the budget did not complete with its receipt');
        const usbEnd = await head(device, { signal });
        assert.bytes(Buffer.from(end.head), Buffer.from(usbEnd.head), 'the chain over WebAuthn and over USB end at different heads');
        log(`over WebAuthn: HEAD, GRANT_CREATE + press (checkpoint + ML-DSA), TX start, a paid sign, RECEIPT, PICKUP of ${count} - head #${end.seq}`);
      } finally {
        await app.destroy();
      }
    });

  /*
   * THE LOGIN BUDGET'S DERIVE (PROPOSAL-login-plan.md; Brad, 2026-10-29: "1 press = logs into our app", "we can change
   * the RFC"): a budget may pay derive_secret's touchless derive on slot 128 for the one label its scope names. Over
   * WebAuthn, as the web app asks: the grant at a press, a TX start for the exact request (mode || label hash), the
   * derive with no press - the same 32 bytes an ordinary derive gives - a self-press link (op 17) under the budget, owing
   * its receipt. Another label is not paid: field 30 asks its code, and no link is written.
   */
  const OP_DERIVE = 17;
  const hasDerive = !(ctx.build && Array.isArray(ctx.build.plugins)) || ctx.build.plugins.includes('derive_secret');
  it('edge: a budget pays a touchless derive_secret for the label its scope names - no press, a link that owes its receipt; another label asks its code (the login budget)',
    async ({ device, assert, signal, log, skip }) => {
      if (!hasDerive) return skip('this emulator was built without derive_secret');
      await device.restart({ signal });
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });

      const Rectify = ctx.requireLib('@bmatusiak/rectify');
      const plugins = ['host', 'transport/tunnel', 'session', 'device', 'okcrypto', 'edge']
        .map((p) => ctx.requireLib(`node-onlykey-lib/plugins/${p}`));
      const { createWebAuthnCtap } = ctx.requireLib('node-onlykey-lib/transport/webauthn');
      const { window } = ctx.kit.webenv.create(device, { signal });
      plugins.config = { okcrypto: { ctap: createWebAuthnCtap({ credentials: window.navigator.credentials }) } };
      const app = await new Promise((resolve, reject) => {
        const a = Rectify.build(plugins, (err, started) => (err ? reject(err) : resolve(started)));
        a.start();
      });
      try {
        const { okcrypto, edge: web } = app.services;
        await okcrypto.connectTunnel();
        const LABEL = 'okt login: the bucket';
        const OTHER = 'okt login: another label';
        const payloadOf = (label) => new Uint8Array(Buffer.concat([Buffer.from([1]), sha256(Buffer.from(label))]));
        /*
         * an ordinary derive asks its code (field 30's default): the code pressed as the host shows it. The lib calls
         * confirm BEFORE it sends (a host cannot know whether the key will ask), so an ask is counted only when the key
         * has not answered by the time a person would press - a derive the budget pays has answered by then.
         */
        let asked = 0;
        const code = async ({ digits, isAnswered }) => {
          await device.sleep(1500, { signal });
          if (isAnswered && isAnswered()) return;
          asked += 1;
          if (digits) device.pressLine(digits); else device.press(1);
        };
        const ordinary = Buffer.from(await okcrypto.deriveSecret(LABEL, { timeoutMs: 40000, confirm: code }));
        assert.equal(asked, 1, 'an ordinary derive did not ask its code');

        const SEEDED = /Generating random number of size = 32/g;
        const seeded = device.log.count(SEEDED);
        const h = await web.head();
        const g = await web.grant({
          /* two uses: the second keeps the budget live for the unpaid label below (a spent budget refuses every TX start) */
          scopes: [{ op: OP_DERIVE, slot: 128, cap: 2, derive: LABEL }],
          reasonHash: new Uint8Array(sha256(Buffer.from('okt: log in'))),
          verifiedHead: h.head,
          onPress: () => {
            device.log.waitForCount(SEEDED, seeded + 1, { timeoutMs: 20000, signal })
              .then(() => device.sleep(800, { signal })).then(() => device.press(1), () => {});
          },
        });
        log(`login budget #${g.grantId} (${g.uses} uses) at #${g.seq}`);

        /* the paid derive: TX start for its exact request, then the derive - nothing asked */
        const before = await web.head();
        await web.txStart(before.head, grants.requestSubject(payloadOf(LABEL)));
        asked = 0;
        const paid = Buffer.from(await okcrypto.deriveSecret(LABEL, { timeoutMs: 40000, confirm: code }));
        assert.equal(asked, 0, 'the derive the budget pays asked for a code');
        assert.bytes(paid, ordinary, 'a paid derive gave another secret than the ordinary one');
        const after = await web.head();
        assert.equal(after.seq, before.seq + 1, 'the paid derive wrote no link');
        const [l] = await web.pickup(after.seq, 1);
        const f = chain.decodeLink(l.link);
        assert.equal(JSON.stringify([f.op, f.decision, f.slot, f.grantId]), JSON.stringify([OP_DERIVE, SELF_PRESS, 128, g.grantId]),
          'the paid derive is not a self-press under the login budget');
        assert.ok(f.reservedZero, 'the lib does not read the derive link as well-formed');
        assert.bytes(Buffer.from(f.subject), Buffer.from(grants.requestSubject(payloadOf(LABEL))), 'its subject is not SHA-256 of the request');
        assert.equal(after.owed, 1, 'the paid derive does not owe its receipt');
        const rc = await web.receipt(f.seq, 0, new Uint8Array(sha256(Buffer.from('okt: the bucket opened'))));
        assert.ok(!(await web.head()).owed, 'the receipt did not pay the derive');

        /* another label under a TX start: no scope names it - its code is asked, no link */
        const b2 = await web.head();
        await web.txStart(b2.head, grants.requestSubject(payloadOf(OTHER)));
        asked = 0;
        await okcrypto.deriveSecret(OTHER, { timeoutMs: 40000, confirm: code });
        assert.equal(asked, 1, 'a derive no scope names was not asked its code');
        assert.equal((await web.head()).seq, b2.seq, 'an unpaid derive wrote a link');
        log(`a derive paid at #${f.seq} (receipt #${rc.seq}); another label asked its code, no link`);
        assert.equal(await edge(device, GRANT_REVOKE, u32(g.grantId), { signal, text: true }), 'EDGE:00');
      } finally {
        await app.destroy();
      }
    });
};
