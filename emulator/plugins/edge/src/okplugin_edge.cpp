/*
 * edge - the firmware half of OnlyKey Edge.
 *
 * The key records, in a hash chain only it extends, each use of a budget: a set number of
 * signs or decrypts a person approved once with a physical press. It adds only what the host
 * cannot be trusted to do, from facts it sees itself:
 *   1 the weld: every link is hashed onto the previous head, and the head pins the history;
 *   2 the budget decision: a sign/decrypt runs without a press only when a live budget pays
 *     for it and a TX start announced exactly that request; each use reveals the next value
 *     of the budget's hash series;
 *   3 one signature, with a key no other request reaches: a checkpoint over (seq, head). The
 *     press that opens a budget is answered with a checkpoint over its grant-create link,
 *     whose subject commits to the budget's genesis;
 *   4 the debt: every budget use owes a receipt, and while it is owed no TX start, budget
 *     opening or resume is accepted, until a receipt or a pressed SETTLE pays it - so at most
 *     one use is ever owed.
 * A second key, the owner key, signs a statement about this device for the host to show
 * which devices were made from the same OnlyKey secret.
 *
 * Every byte matches the host library's format (node-onlykey-lib/edge codes.js, chain.js,
 * grants.js, receipts.js); comments name the library function a format must equal.
 *
 * A budget's uses form a hash series: G = H^n(seed), n <= 1024; use i reveals
 * v_i = H^(n-i)(seed), so a verifier checks H^i(v_i) == G.
 *
 * Runs in the soft key, the desktop emulator and a developer hard key; where its two flash
 * sectors live differs between them (EDGE_REGION below).
 */
#include "core_pins.h" /* millis() */
#include "onlykey.h"
#include "okplugin_edge.h"
#include "sha256.h"
#include "uECC.h"
#include "okpqc.h" /* MLDSA_PK_SIZE, MLDSA_SK_SIZE, MLDSA_SIG_SIZE */
#include <string.h>

/* the firmware's ML-DSA-65 (mldsa-native, FIPS 204) and the buffers its users share */
extern "C" int PQCP_MLDSA_NATIVE_MLDSA65_keypair_internal(uint8_t *pk, uint8_t *sk, const uint8_t seed[32]);
extern "C" int PQCP_MLDSA_NATIVE_MLDSA65_signature(uint8_t *sig, size_t *siglen,
    const uint8_t *m, size_t mlen, const uint8_t *ctx, size_t ctxlen, const uint8_t *sk);
extern uint8_t ctap_buffer[];
extern uint8_t *large_resp_buffer;

extern uint8_t packet_buffer_details[5];
extern uint8_t profilemode;
extern uint8_t ecc_private_key[];
extern uint8_t ecc_public_key[];
extern uint8_t type;
extern int okeeprom_eeget_ecckey(uint8_t *ptr, int slot);
extern void okcrypto_hkdf_info(const void *salt, const void *inputKey, void *outputKey, const size_t L,
    const uint8_t *info, size_t info_len);

/* ------------------------------------------------------------ the format (lib codes.js) */

#define OP_SIGN 1
#define OP_DECRYPT 2
#define OP_GRANT_CREATE 6
#define OP_GRANT_END 7
#define OP_RECEIPT 8
#define OP_LOSS 11
#define OP_GRANT_HOLD 13
#define OP_GRANT_RESUME 14
/* op 15 is not written and not reused */
#define OP_CONTINUE 16 /* the first link of a restored device's own chain, carrying the backup's debt */
/* a touchless derive_secret a budget paid: slot 128, its label in the scope */
#define OP_DERIVE 17
#define DERIVE_SLOT 128
/* derive_secret's request (its okplugin_derive_secret.h, not included: edge needs no other plugin): mode || label hash */
#define DERIVE_TOUCHLESS 1
#define DERIVE_PAYLOAD 33
#define DECISION_SELF_PRESS 4
#define CODE_NEEDS_REVIEW 0x8F /* a SETTLE is linked as a receipt with this code and the press flag */
#define FLAG_PRESS_OBSERVED 0x01
#define FLAG_BUDGET_SPENT 0x02
#define FLAG_OWES_RECEIPT 0x10 /* this use owes a receipt */

#define SEQ_NONE 0xFFFFFFFFUL
#define LINK_BYTES 64
#define ID_BYTES 16

#define MAX_LIVE 4      /* live budgets at once */
#define MAX_SCOPES 4    /* scopes per budget */
#define MAX_USES 1024   /* uses per budget: up to 1,024 SHA-256 at the press and per reveal */
#define HELD 8          /* links held in RAM for pickup */
#define PRESS_MS 25000UL

/* ------------------------------------------------------------ flash: one small record */

/*
 * Two 2 KB sectors, A and B. OK_EMULATOR is defined by every emulator build (binding.gyp,
 * android/CMakeLists.txt) and never by the device toolchain, so it tells the two apart.
 * (Not OKEMU_FLASH_BASE: the Linux addon maps its flash at 0 and leaves that undefined.)
 *
 * - Emulators: base + 0x1000, from the firmware's own constant so it follows
 *   OKEMU_FLASH_BASE. On a Teensy that is the bootloader's; in an emulator it is
 *   file-backed and otherwise unused.
 * - A developer hard key (Teensy 3.2 flashed through HalfKay): 0x39800 and 0x3A000, the
 *   last two sectors before 3.1.0's data storage (flashstorestart, 0x3A800, whose 11
 *   sectors all have owners). The image is linked at 0 and its code grows up towards
 *   them; nothing addresses the sectors in between (ok-edge TODO.md, A1). The top two
 *   leave the code the most room: a DEBUG build of 3.1.0 + Edge ends near 0x38400. The
 *   hard-key build refuses an image whose code reaches 0x39800.
 *   NOT a production placement: on a key with the signed bootloader these sectors sit
 *   inside the window fw_hash() hashes for it (fwstartadr .. 0x3A05F), so every write
 *   here would change what the bootloader verifies.
 */
#ifdef OK_EMULATOR
#define EDGE_REGION ((uintptr_t)factorysectoradr - 0x4800)
#else
#define EDGE_REGION ((uintptr_t)0x39800)
#endif
#define EDGE_STATE_A (EDGE_REGION + 0x0000)
#define EDGE_STATE_B (EDGE_REGION + 0x0800)

/*
 * The record, 320 bytes, written to sector A or B in turn (the higher gen wins at load):
 *   0 magic "OKEDGEv1" . 8 gen u32 . 12 seq u32 . 16 head 32 . 48 owes (0 or 1) . 49..51 zero .
 *   52 the owed use (seq u32, head 32) . 88 last_link 64 . 152 salted . 153 cont . 154 salt 32 .
 *   186 cont_id 16 . 202..203 zero . 204 check: the first 4 bytes of SHA-256 over bytes 0..203.
 * A record with another magic, or whose check fails, is not read: with neither sector
 * readable the key starts an empty chain. Only the Edge region is ever written here.
 */
#define STATE_BYTES 208 /* a multiple of 4: flash takes words */
#define STATE_CHECKED 204
#define OWED_AT 52
#define LAST_AT 88
#define SALTED_AT 152
#define CONT_AT 153
#define SALT_AT 154
#define CONT_ID_AT 186
static const uint8_t MAGIC[8] = {'O', 'K', 'E', 'D', 'G', 'E', 'v', '1'};

struct owed_use { uint32_t seq; uint8_t head[32]; }; /* head[seq]: what its receipt subject names */

/* everything that survives a restart */
struct edge_state {
  uint32_t gen;
  uint32_t seq;               /* SEQ_NONE = no link yet */
  uint8_t head[32];           /* head[seq]; the genesis while seq == SEQ_NONE */
  uint8_t owes;               /* 1: the use in `owed` owes a receipt */
  struct owed_use owed;
  uint8_t last_link[LINK_BYTES]; /* the latest link, so a restart never loses it */
  /*
   * One chain per physical device: the salt is drawn on first use and lives only in this
   * record - never in the backup section. A restored key draws a new salt, so it has another
   * Edge key and another device id and writes its own chain from the first link.
   */
  uint8_t salted;
  uint8_t cont;                  /* a continue link is owed: CONT_FROM_ID */
  uint8_t salt[32];
  uint8_t cont_id[ID_BYTES];     /* the device id of the chain this one continues */
};
#define CONT_FROM_ID 1 /* a backup restored here */
static struct edge_state st;
static uint8_t loaded;

/* Is anything owed? Then no TX start, budget opening or resume is accepted. */
static int owes(void) { return st.owes; }

/* ------------------------------------------------------------ RAM only */

static struct {
  uint8_t ok;
  uint8_t pub[64];            /* the Edge public key, X||Y */
  uint8_t device_id[ID_BYTES];
} ident;

/*
 * A scope on a derived code (agent sign 201-203 / 221-223) names one identity: the first 16
 * bytes of its 32-byte derive label. Those codes are shared by every derived identity of a
 * curve; without the label, a budget for one identity would pay for every other on the code.
 */
#define LABEL_PREFIX 16
struct scope { uint8_t op, slot; uint16_t cap, used; uint8_t has_label; uint8_t label[LABEL_PREFIX]; };
/* a live budget: RAM only - a lock or reboot is a new process, so it ends with the session */
struct budget {
  uint32_t id;
  uint8_t nscopes, on_hold;   /* on_hold: pays for nothing, and no TX start counts it */
  struct scope scopes[MAX_SCOPES];
  uint16_t uses, used;
  uint32_t opened, lifetime_ms; /* millis() at the press, and how long it may live */
  uint8_t seed[32];
  uint8_t genesis[32];
};
static struct budget budgets[MAX_LIVE];

/*
 * GRANT_LABEL stages a derived-code scope's label for the NEXT GRANT_CREATE (no press: it
 * only narrows a request). A GRANT_CREATE consumes them, and 25 s without one clears them.
 */
#define LABEL_STAGE_MS 25000UL
static struct {
  uint8_t set[MAX_SCOPES];
  uint8_t label[MAX_SCOPES][32];
  unsigned long since;
} staged;

/* a derived code: the identity is in the request, not in the slot */
static int derived_code(uint8_t slot) {
  return (slot >= 201 && slot <= 203) || (slot >= 221 && slot <= 223);
}

/*
 * ONE self-press, started by TX start. RAM only, and any link clears it (weld_in), so it is
 * spent by the very next sign/decrypt whatever it decides, and a lock or reboot drops it.
 */
static uint8_t started;
/*
 * A TX start is bound to ONE request:
 *   token = SHA256("OKEDGE-TX-v1" || head || subject || intent)
 * subject = pend.subject, SHA-256 of exactly the bytes handed to okcore_prime_user_confirmation.
 * The key recomputes it from ITS head when the next sign/decrypt is primed; a request that is
 * not the announced one is refused and spends the TX start.
 */
static uint8_t tx_token[32];
/*
 * The intent: the first 16 bytes of SHA256("OKEDGE-INTENT-v1" || intent text), sent with the
 * TX start and covered by the token. The self-press link carries it in bytes 47-62, so the
 * use's purpose is in the chain before the signature exists. 16 zero bytes = no intent.
 */
static uint8_t tx_intent[16];
static uint8_t tx_has_intent;
/* the intent the next append_scoped writes into bytes 47-62 (a self-press with an intent), then cleared */
static const uint8_t *next_intent;

/*
 * TX starts refused since power-up, reported in HEAD byte 60. RAM only: a refused TX start
 * writes no link (any host could otherwise flood the chain and wear the flash), so this count
 * is the key's own evidence of refused attempts. Stops at 255.
 */
static uint8_t refused_tx;
static void status(uint8_t code);
static void refuse_tx(uint8_t code) {
  if (refused_tx < 255) refused_tx++;
  status(code);
}

/* the last links, with a self-press's reveal, for the host to pick up */
static struct held_link {
  uint8_t used;
  uint32_t seq;
  uint8_t link[LINK_BYTES];
  uint8_t head[32];
  uint8_t reveal[32];
} held[HELD];

/* the sign/decrypt that is waiting for its decision */
static struct {
  uint8_t active, opcode, slot, press;
  uint8_t has_intent; /* the TX start matched and named an intent: it goes into the self-press link */
  uint8_t refuse;     /* the status to refuse this request with (0 = none) */
  uint8_t intent[16];
  int8_t budget;
  uint8_t subject[32];
  /* on a derived code, the identity's label prefix - the request's last 32 bytes are its label */
  uint8_t has_label;
  uint8_t label[LABEL_PREFIX];
} pend;

/*
 * An OKEDGE request waiting for its physical press: opening a budget, resuming one, settling
 * the debt or accepting a loss. One at a time; a new one replaces it.
 */
enum { PRESS_GRANT = 1, PRESS_RESUME, PRESS_SETTLE, PRESS_LOSS };
static struct {
  uint8_t what;
  unsigned long since;
  uint32_t id;                /* PRESS_RESUME: the budget; PRESS_LOSS: to */
  uint32_t from;              /* PRESS_LOSS: from */
  /*
   * The head the host verified its copy up to (GRANT_CREATE: its first GRANT_HEAD_BYTES;
   * GRANT_RESUME: all 32). Checked when the request arrives AND again at the press: a link
   * written while the key waits would otherwise open the budget on a history the host never
   * checked.
   */
  uint8_t verified[32];
  uint8_t verified_len;
  struct budget b;            /* PRESS_GRANT: the budget to open */
  uint8_t reason[32];
  uint8_t scopes_enc[1 + 4 * MAX_SCOPES];
  uint8_t scopes_len;
  uint16_t lifetime;          /* PRESS_GRANT: minutes, 0 = DEFAULT_LIFETIME_MIN */
  uint8_t labels[MAX_SCOPES][32]; /* PRESS_GRANT: the full labels of derived-code scopes, for the subject */
  uint8_t web;                /* the request came over WebAuthn: the answer made at the press is stored there */
} press;

/* ------------------------------------------------------------ bytes and hashes */

static void put32(uint8_t *p, uint32_t v) {
  p[0] = v & 0xff; p[1] = (v >> 8) & 0xff; p[2] = (v >> 16) & 0xff; p[3] = (v >> 24) & 0xff;
}
static uint32_t get32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void put16(uint8_t *p, uint16_t v) { p[0] = v & 0xff; p[1] = (v >> 8) & 0xff; }
static uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

/* SHA-256 over an ASCII tag and up to three byte strings (lib hash.js H) */
static void H(uint8_t out[32], const char *tag, const uint8_t *a, size_t al,
    const uint8_t *b, size_t bl, const uint8_t *c, size_t cl) {
  SHA256_CTX ctx;
  sha256_init(&ctx);
  if (tag) sha256_update(&ctx, (const unsigned char *)tag, strlen(tag));
  if (a) sha256_update(&ctx, a, al);
  if (b) sha256_update(&ctx, b, bl);
  if (c) sha256_update(&ctx, c, cl);
  sha256_final(&ctx, out);
}

/*
 * Replies over WebAuthn: a request there has one stored answer (store_FIDO_response replaces it, at most
 * LARGE_RESP_BUFFER_SIZE bytes sealed), so the 64-byte replies made while okplugin_edge_ctap() handles a request - or
 * while a press that request waited for is decided - are collected in web_out and stored once, sealed with the transit
 * key. web_len is -1 when not collecting. A status reply while collecting drops what was collected: the text is the
 * answer. PICKUP over WebAuthn takes at most WEB_PICKUP_MAX links, so the collected answer stays under the 512-byte
 * poll chunk.
 *
 * An ML-DSA-65 signature does not fit one answer beside the replies before it (checkpoint, statement, a grant's
 * checkpoint): while collecting, mldsa_sign_reply() keeps what it would sign (web_more) instead, and OKEDGE_MORE signs
 * and stores it as an answer of its own. web_more holds only a digest this plugin computed for that answer; any other
 * request clears it.
 */
extern int outputmode;
#define WEB_PICKUP_MAX 3
static uint8_t web_out[2 * WEB_PICKUP_MAX * LINK_BYTES];
static int web_len = -1;
static struct {
  uint8_t set;
  uint8_t which;
  uint8_t digest[32];
} web_more;
static int to_web(void) { return outputmode == WEBAUTHN; }
static void web_flush(void) {
  int n = web_len;
  web_len = -1;
  if (n > 0) send_transport_response(web_out, n, 1, false);
  memset(web_out, 0, sizeof(web_out));
}

/* "EDGE:xx" - the only text the plugin sends (okplugin_edge.h lists the codes) */
static void status(uint8_t code) {
  static const char HEX[] = "0123456789ABCDEF";
  char s[8] = {'E', 'D', 'G', 'E', ':', HEX[code >> 4], HEX[code & 0x0f], 0};
  if (web_len >= 0) web_len = 0;
  hidprint(s);
}

static void hash_times(uint8_t out[32], const uint8_t v[32], unsigned times) {
  uint8_t x[32];
  memcpy(x, v, 32);
  for (unsigned k = 0; k < times; k++) H(x, NULL, x, 32, NULL, 0, NULL, 0);
  memcpy(out, x, 32);
  memset(x, 0, 32);
}

static void reply(const uint8_t *data, int len) {
  uint8_t r[64];
  memset(r, 0, sizeof(r));
  memcpy(r, data, len > 64 ? 64 : len);
  if (web_len >= 0) {
    if (web_len + 64 <= (int)sizeof(web_out)) {
      memcpy(web_out + web_len, r, 64);
      web_len += 64;
    }
    return;
  }
  send_transport_response(r, 64, to_web(), false);
}

/* seq . head: the answer of RECEIPT, SETTLE and LOSS - the head the next TX start must name */
static void reply_seq_head(void) {
  uint8_t r[36];
  put32(r, st.seq);
  memcpy(r + 4, st.head, 32);
  reply(r, 36);
}

/* ------------------------------------------------------------ the record */

static void state_encode(uint8_t rec[STATE_BYTES]) {
  uint8_t check[32];
  memset(rec, 0, STATE_BYTES);
  memcpy(rec, MAGIC, 8);
  put32(rec + 8, st.gen);
  put32(rec + 12, st.seq);
  memcpy(rec + 16, st.head, 32);
  rec[48] = st.owes;
  put32(rec + OWED_AT, st.owed.seq);
  memcpy(rec + OWED_AT + 4, st.owed.head, 32);
  memcpy(rec + LAST_AT, st.last_link, LINK_BYTES);
  rec[SALTED_AT] = st.salted;
  rec[CONT_AT] = st.cont;
  memcpy(rec + SALT_AT, st.salt, 32);
  memcpy(rec + CONT_ID_AT, st.cont_id, ID_BYTES);
  H(check, NULL, rec, STATE_CHECKED, NULL, 0, NULL, 0);
  memcpy(rec + STATE_CHECKED, check, 4);
}

static int state_decode(const uint8_t rec[STATE_BYTES], struct edge_state *s) {
  uint8_t check[32];
  if (memcmp(rec, MAGIC, 8) != 0) return 0;
  H(check, NULL, rec, STATE_CHECKED, NULL, 0, NULL, 0);
  if (memcmp(rec + STATE_CHECKED, check, 4) != 0) return 0; /* torn write: the other copy wins */
  s->gen = get32(rec + 8);
  s->seq = get32(rec + 12);
  memcpy(s->head, rec + 16, 32);
  s->owes = rec[48] == 1;
  s->owed.seq = get32(rec + OWED_AT);
  memcpy(s->owed.head, rec + OWED_AT + 4, 32);
  memcpy(s->last_link, rec + LAST_AT, LINK_BYTES);
  s->salted = rec[SALTED_AT] == 1;
  s->cont = rec[CONT_AT] == CONT_FROM_ID ? CONT_FROM_ID : 0;
  memcpy(s->salt, rec + SALT_AT, 32);
  memcpy(s->cont_id, rec + CONT_ID_AT, ID_BYTES);
  return 1;
}

/* double-buffered: write the OTHER sector, so a crash mid-write keeps the old record */
static void state_save(void) {
  uint8_t rec[STATE_BYTES];
  st.gen++;
  state_encode(rec);
  okcore_flashsector(rec, (unsigned long *)((st.gen & 1) ? EDGE_STATE_B : EDGE_STATE_A), STATE_BYTES);
}

static void hold(uint32_t seq, const uint8_t link[LINK_BYTES], const uint8_t head[32], const uint8_t *reveal) {
  struct held_link *h = &held[seq % HELD];
  h->used = 1;
  h->seq = seq;
  memcpy(h->link, link, LINK_BYTES);
  memcpy(h->head, head, 32);
  if (reveal) memcpy(h->reveal, reveal, 32); else memset(h->reveal, 0, 32);
}

/* the newer readable record of the two sectors; neither readable: an empty chain */
static void state_load(void) {
  if (loaded) return;
  uint8_t rec[STATE_BYTES];
  struct edge_state a, b;
  okcore_flashget_common(rec, (unsigned long *)EDGE_STATE_A, STATE_BYTES);
  int ha = state_decode(rec, &a);
  okcore_flashget_common(rec, (unsigned long *)EDGE_STATE_B, STATE_BYTES);
  int hb = state_decode(rec, &b);
  if (ha && (!hb || a.gen > b.gen)) st = a;
  else if (hb) st = b;
  else {
    memset(&st, 0, sizeof(st));
    st.seq = SEQ_NONE;
  }
  /* the latest link survives a restart, so it can still be picked up */
  if (st.seq != SEQ_NONE) hold(st.seq, st.last_link, st.head, NULL);
  loaded = 1;
}

/* ------------------------------------------------------------ the Edge key */

/*
 * HKDF over K132 (the key's own secret, made at PIN setup and kept in the backup) with the
 * given info string and optional 33-byte salt, into `out`. K132 is loaded into the
 * firmware's ECC globals to derive, so they are saved first and put back after: a pending
 * sign may be using them. 0 without a PIN (no K132).
 */
static int edge_secret_salted(const char *info, const uint8_t *salt33, uint8_t out[32]) {
  uint8_t t = 0;
  if (profilemode == NONENCRYPTEDPROFILE) return 0;
  okeeprom_eeget_ecckey(&t, 132);
  if (t == 0) return 0; /* no K132: no PIN set yet */
  uint8_t save_priv[32], save_pub[65], save_type = type;
  memcpy(save_priv, ecc_private_key, 32);
  memcpy(save_pub, ecc_public_key, 65);
  int ok = okcore_flashget_ECC(132) != 0;
  if (ok) okcrypto_hkdf_info(salt33, ecc_private_key, out, 32, (const uint8_t *)info, strlen(info));
  memcpy(ecc_private_key, save_priv, 32);
  memcpy(ecc_public_key, save_pub, 65);
  type = save_type;
  memset(save_priv, 0, 32);
  return ok;
}


/*
 * The Edge checkpoint key - and so the device id and the genesis - is
 * HKDF(salt = 0x28 . this device's salt, K132, "onlykey/edge/v1"), P-256. Only this key takes
 * the salt: every derived identity (SSH, PGP, the agents' keys) depends on K132 alone and is
 * the same on every device made from the same backup. There is no Edge key without a salt:
 * ensure_identity draws one before anything asks for the key.
 */
static int edge_key_with(const struct edge_state *s, uint8_t priv[32]) {
  if (!s->salted) return 0;
  uint8_t salt33[33];
  salt33[0] = 0x28;
  memcpy(salt33 + 1, s->salt, 32);
  int ok = edge_secret_salted("onlykey/edge/v1", salt33, priv);
  memset(salt33, 0, sizeof(salt33));
  return ok;
}
static int edge_private_key(uint8_t priv[32]) { return edge_key_with(&st, priv); }

/*
 * THE ML-DSA-65 TWINS. Each P-256 signature Edge makes - a checkpoint, an owner statement - has an
 * ML-DSA-65 signature beside it over the same digest (FIPS 204, pure, empty context), and a host
 * requires both: the pair holds while either algorithm does. The ML-DSA keys are derived like the
 * P-256 ones and never stored:
 *   checkpoint key: seed = HKDF(salt = 0x28 . this device's salt, K132, "onlykey/edge/mldsa/v1")
 *   owner key:      seed = HKDF(K132, "onlykey/edge/owner-mldsa/v1")             (no salt)
 * Keygen from the seed writes the expanded secret key (MLDSA_SK_SIZE) to ctap_buffer and the
 * public key (MLDSA_PK_SIZE) to pk; the caller wipes ctap_buffer.
 */
#define MLDSA_CHECKPOINT_KEY 0
#define MLDSA_OWNER_KEY 1
static int mldsa_keypair(uint8_t which, uint8_t *pk) {
  uint8_t seed[32], salt33[33];
  int ok;
  if (which == MLDSA_CHECKPOINT_KEY) {
    if (!st.salted) return 0;
    salt33[0] = 0x28;
    memcpy(salt33 + 1, st.salt, 32);
    ok = edge_secret_salted("onlykey/edge/mldsa/v1", salt33, seed);
    memset(salt33, 0, sizeof(salt33));
  } else {
    ok = edge_secret_salted("onlykey/edge/owner-mldsa/v1", NULL, seed);
  }
  if (ok) ok = PQCP_MLDSA_NATIVE_MLDSA65_keypair_internal(pk, ctap_buffer, seed) == 0;
  memset(seed, 0, sizeof(seed));
  return ok;
}

/*
 * An ML-DSA-65 public key, sent whole (MLDSA_PK_SIZE bytes in 64-byte reports). The public key
 * and then the signature use large_resp_buffer (3392 bytes): the vendor reply path streams
 * through its own resp_buffer.
 */
static void mldsa_pubkey_reply(uint8_t which) {
  int ok = mldsa_keypair(which, large_resp_buffer);
  memset(ctap_buffer, 0, MLDSA_SK_SIZE);
  if (!ok) { status(EDGE_SIGN_FAILED); return; }
  /* over WebAuthn large_resp_buffer becomes the stored answer, sealed in place: it is not wiped here */
  int web = to_web();
  send_transport_response(large_resp_buffer, MLDSA_PK_SIZE, web, false);
  if (!web) memset(large_resp_buffer, 0, MLDSA_PK_SIZE);
}

/* the ML-DSA-65 signature of a key over a 32-byte digest, sent whole (MLDSA_SIG_SIZE bytes) */
static int mldsa_sign_reply(uint8_t which, const uint8_t digest[32]) {
  if (web_len >= 0) {
    web_more.which = which;
    memcpy(web_more.digest, digest, 32);
    web_more.set = 1;
    return 1;
  }
  size_t siglen = 0;
  int ok = mldsa_keypair(which, large_resp_buffer)
        && PQCP_MLDSA_NATIVE_MLDSA65_signature(large_resp_buffer, &siglen, digest, 32, NULL, 0, ctap_buffer) == 0
        && siglen == MLDSA_SIG_SIZE;
  memset(ctap_buffer, 0, MLDSA_SK_SIZE);
  int web = to_web();
  if (ok) send_transport_response(large_resp_buffer, MLDSA_SIG_SIZE, web, false);
  if (!(ok && web)) memset(large_resp_buffer, 0, MLDSA_SIG_SIZE);
  return ok;
}

static void append(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32],
    uint32_t grant_id, uint16_t grant_step, const uint8_t *reveal);
static void append_scoped(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32],
    uint32_t grant_id, uint16_t grant_step, uint8_t scope, const uint8_t *reveal);

/* device_id = SHA256("OKEDGE-DEVICE-v1" || pubkey)[0..16] (lib chain.deviceIdOf) */
static int identity_of(const struct edge_state *s, uint8_t pub[64], uint8_t id[ID_BYTES]) {
  uint8_t priv[32], h[32];
  if (!edge_key_with(s, priv)) return 0;
  int ok = uECC_compute_public_key(priv, pub, uECC_secp256r1());
  memset(priv, 0, 32);
  if (!ok) return 0;
  H(h, "OKEDGE-DEVICE-v1", pub, 64, NULL, 0, NULL, 0);
  memcpy(id, h, ID_BYTES);
  return 1;
}

/*
 * The continue link: the first link of a restored device's own chain. It takes the NEXT seq
 * after the chain it continues (so a carried debt's seq never meets one of the new chain's)
 * and is welded onto the NEW genesis, not the old head:
 *   op = continue, decision = approve, flags 0 (no press: the restore already needed the
 *   person), grant_id = 1 when a debt is carried, else 0,
 *   subject = SHA256("OKEDGE-CONTINUE-v1" || old device_id 16 || old seq u32 ||
 *             old head 32 || the carried debt's seq u32, when there is one)
 * The debt (seq + head) stays owed here and are paid by receipt or settle on this chain; the
 * host keeps the old chain and its checkpoint key beside it, so the old history stays
 * checkable up to the head this names. Live budgets end.
 */
static void write_continue(const uint8_t old_id[ID_BYTES]) {
  uint8_t buf[ID_BYTES + 4 + 32 + 4], subject[32];
  memcpy(buf, old_id, ID_BYTES);
  put32(buf + ID_BYTES, st.seq);
  memcpy(buf + ID_BYTES + 4, st.head, 32);
  if (st.owes) put32(buf + ID_BYTES + 36, st.owed.seq);
  H(subject, "OKEDGE-CONTINUE-v1", buf, ID_BYTES + 36 + 4 * st.owes, NULL, 0, NULL, 0);
  memset(budgets, 0, sizeof(budgets));
  memset(held, 0, sizeof(held));
  started = 0;
  st.cont = 0;
  memset(st.cont_id, 0, ID_BYTES);
  /* head[-1] of the new chain = SHA256("OKEDGE-GENESIS-v1" || new device_id) */
  H(st.head, "OKEDGE-GENESIS-v1", ident.device_id, ID_BYTES, NULL, 0, NULL, 0);
  append(OP_CONTINUE, OKEDGE_DECISION_APPROVE, 0, 0, subject, st.owes, 0, NULL);
  state_save();
}

/* the public key and device id (RAM), and the genesis on a new chain; 0 without K132 */
static int ensure_identity(void) {
  state_load();
  if (ident.ok) return 1;
  /*
   * No salt yet - a new key, a wiped Edge state, or a backup restored here (which then
   * writes its continue link, CONT_FROM_ID). The salt is drawn now.
   */
  if (!st.salted) {
    uint8_t t = 0;
    okeeprom_eeget_ecckey(&t, 132);
    if (profilemode == NONENCRYPTEDPROFILE || t == 0) return 0; /* no K132 yet: nothing to salt for */
    RNG2(st.salt, 32);
    st.salted = 1;
    state_save();
  }
  if (!identity_of(&st, ident.pub, ident.device_id)) return 0;
  ident.ok = 1;
  if (st.cont == CONT_FROM_ID) {
    uint8_t old_id[ID_BYTES];
    memcpy(old_id, st.cont_id, ID_BYTES);
    write_continue(old_id);
    return 1;
  }
  if (st.seq == SEQ_NONE) {
    /* head[-1] = SHA256("OKEDGE-GENESIS-v1" || device_id)  (lib chain.genesis) */
    H(st.head, "OKEDGE-GENESIS-v1", ident.device_id, ID_BYTES, NULL, 0, NULL, 0);
    state_save();
  }
  return 1;
}

/*
 * The checkpoint: two signatures over (seq, head) (lib chain.checkpointDigest)
 *   SHA256("OKEDGE-CKPT-v1" || device_id || seq (u32 LE) || head)
 * by the P-256 checkpoint key and its ML-DSA-65 twin.
 * reply: seq u32 . head 32; then the 64-byte P-256 signature; then the ML-DSA-65 signature
 * (MLDSA_SIG_SIZE bytes).
 */
static void checkpoint(void) {
  uint8_t seq4[4], digest[32], sig[64], priv[32], r[36];
  put32(seq4, st.seq);
  H(digest, "OKEDGE-CKPT-v1", ident.device_id, ID_BYTES, seq4, 4, st.head, 32);
  int ok = edge_private_key(priv) && uECC_sign(priv, digest, 32, sig, uECC_secp256r1());
  memset(priv, 0, 32);
  if (!ok) { status(EDGE_SIGN_FAILED); return; }
  memcpy(r, seq4, 4);
  memcpy(r + 4, st.head, 32);
  reply(r, 36);
  reply(sig, 64);
  if (!mldsa_sign_reply(MLDSA_CHECKPOINT_KEY, digest)) status(EDGE_SIGN_FAILED);
}

/*
 * The owner statement. The owner key is HKDF(K132, "onlykey/edge/owner/v1") with NO salt,
 * so it is the same on every device made from the same OnlyKey secret: a host holding one
 * device's owner public key can tell which other logs were made with the same secret, while
 * each device's salt stays on that device. The key signs only a statement about ITSELF - its
 * device id, its checkpoint key, its current seq - and the hash of a nametag the host gives.
 * No press and no link: it writes nothing. The signature proves the key, not the nametag.
 *   digest = SHA256("OKEDGE-STATEMENT-v1" || device id 16 || checkpoint pubkey 64 ||
 *                   SHA256(ML-DSA checkpoint pubkey) 32 || seq u32 LE || nametag hash 32)
 *                                                          (lib grants.statementDigest)
 * so the statement names both of this device's checkpoint keys.
 * reply: seq . nametag hash, then the owner public key (X || Y), then the P-256 signature,
 * then the owner's ML-DSA-65 signature (MLDSA_SIG_SIZE bytes) over the same digest.
 */
static void statement(const uint8_t nametag_hash[32]) {
  uint8_t who[ID_BYTES + 64 + 32], seq4[4], digest[32], priv[32], pub[64], sig[64], r[36];
  memcpy(who, ident.device_id, ID_BYTES);
  memcpy(who + ID_BYTES, ident.pub, 64);
  int pq = mldsa_keypair(MLDSA_CHECKPOINT_KEY, large_resp_buffer);
  memset(ctap_buffer, 0, MLDSA_SK_SIZE);
  if (pq) H(who + ID_BYTES + 64, NULL, large_resp_buffer, MLDSA_PK_SIZE, NULL, 0, NULL, 0);
  memset(large_resp_buffer, 0, MLDSA_PK_SIZE);
  if (!pq) { status(EDGE_SIGN_FAILED); return; }
  put32(seq4, st.seq);
  H(digest, "OKEDGE-STATEMENT-v1", who, sizeof(who), seq4, 4, nametag_hash, 32);
  int ok = edge_secret_salted("onlykey/edge/owner/v1", NULL, priv)
        && uECC_compute_public_key(priv, pub, uECC_secp256r1())
        && uECC_sign(priv, digest, 32, sig, uECC_secp256r1());
  memset(priv, 0, 32);
  if (!ok) { status(EDGE_SIGN_FAILED); return; }
  memcpy(r, seq4, 4);
  memcpy(r + 4, nametag_hash, 32);
  reply(r, 36);
  reply(pub, 64);
  reply(sig, 64);
  if (!mldsa_sign_reply(MLDSA_OWNER_KEY, digest)) status(EDGE_SIGN_FAILED);
}

/* ------------------------------------------------------------ the weld */

/* SHA256("OKEDGE-SETTLE-v1" || the owed seq (u32 LE)) (lib receipts.settleSubject) */
static void settle_subject(const struct edge_state *s, uint8_t out[32]) {
  uint8_t seq4[4];
  put32(seq4, s->owed.seq);
  H(out, "OKEDGE-SETTLE-v1", seq4, 4, NULL, 0, NULL, 0);
}

/*
 * The weld - the one function every link goes through:
 *   head[n] = SHA256("OKEDGE-LINK-v1" || head[n-1] || link[n])   (lib chain.weld)
 * then the debt (lib receipts.keyDebts follows the same rule):
 *   - a self-pressed sign/decrypt whose link carries FLAG_OWES_RECEIPT owes a receipt. Nothing
 *     starts while one is owed, so the slot is always free when a use arrives;
 *   - a SETTLE - a receipt with code 0x8F, the press flag and the subject over the owed seq -
 *     clears it;
 *   - any other receipt pays its ref_seq (bytes 40-43), if that is the owed use.
 * The record is saved before the operation's result is released.
 */
static int weld_in(struct edge_state *s, const uint8_t link[LINK_BYTES], const uint8_t *reveal) {
  uint8_t head[32], w[32];
  uint32_t seq = get32(link);
  H(head, "OKEDGE-LINK-v1", s->head, 32, link, LINK_BYTES, NULL, 0);

  uint8_t op = link[4], decision = link[5];
  /* a use - a sign, a decrypt or a paid derive - may owe a receipt */
  if (op == OP_SIGN || op == OP_DECRYPT || op == OP_DERIVE) {
    if ((decision == OKEDGE_DECISION_APPROVE || decision == DECISION_SELF_PRESS) && (link[7] & FLAG_OWES_RECEIPT)) {
      s->owes = 1;
      s->owed.seq = seq;
      memcpy(s->owed.head, head, 32);
    }
  } else if (op == OP_RECEIPT) {
    settle_subject(s, w);
    int settled = decision == CODE_NEEDS_REVIEW && (link[7] & FLAG_PRESS_OBSERVED) && memcmp(link + 8, w, 32) == 0;
    if (s->owes && (settled || get32(link + 40) == s->owed.seq)) {
      s->owes = 0;
      memset(&s->owed, 0, sizeof(s->owed));
    }
  }
  s->seq = seq;
  memcpy(s->head, head, 32);
  memcpy(s->last_link, link, LINK_BYTES);
  started = 0; /* any link spends or clears the TX start */
  if (s == &st) {
    state_save();
    hold(seq, link, head, reveal);
  }
  return 1;
}

/* A link the key writes itself (lib chain.encodeLink), as its next seq. */
static void append(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32],
    uint32_t grant_id, uint16_t grant_step, const uint8_t *reveal) {
  append_scoped(op, decision, slot, flags, subject, grant_id, grant_step, 0, reveal);
}

/*
 * The link, 64 bytes:
 *   0 seq u32 . 4 op . 5 decision . 6 slot . 7 flags . 8 subject 32 . 40 grant_id u32 .
 *   44 grant_step u16 . 46 scope . 47 intent 16 . 63 version (OKEDGE_LINK_VERSION).
 * Byte 46: on a link that spends a budget (FLAG_BUDGET_SPENT), which of its scopes paid,
 * 1-based; on a grant-create, its scope count; 0 on every other link. The step and the
 * subject cannot say which scope paid - two scopes on the same op and slot differ only by
 * label - and a verifier needs each scope's own count.
 */
static void append_scoped(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32],
    uint32_t grant_id, uint16_t grant_step, uint8_t scope, const uint8_t *reveal) {
  uint8_t link[LINK_BYTES];
  memset(link, 0, sizeof(link));
  link[46] = scope;
  if (next_intent) { memcpy(link + 47, next_intent, 16); next_intent = NULL; }
  link[63] = OKEDGE_LINK_VERSION;
  put32(link, st.seq == SEQ_NONE ? 0 : st.seq + 1);
  link[4] = op;
  link[5] = decision;
  link[6] = slot;
  link[7] = flags;
  memcpy(link + 8, subject, 32);
  put32(link + 40, grant_id);
  put16(link + 44, grant_step);
  weld_in(&st, link, reveal);
}

/* ------------------------------------------------------------ budgets */

/*
 * What a budget may pay for: OKSIGN on the stored slots 1-4 and 101-116 and the agent sign
 * codes 201-203 / 221-223; OKDECRYPT on the stored slots only. Never FIDO2, config, backup,
 * keys, PINs, the hardened derive or the shared secret.
 */
static int scope_allowed(uint8_t op, uint8_t slot) {
  int stored = (slot >= 1 && slot <= 4) || (slot >= 101 && slot <= 116);
  if (op == OP_SIGN) return stored || (slot >= 201 && slot <= 203) || (slot >= 221 && slot <= 223);
  if (op == OP_DECRYPT) return stored;
  /*
   * The one derive a budget pays: derive_secret's touchless derive on slot 128, bound to one label (a scope without its
   * label is refused, as a derived code's). Never the touch derive, never the shared secret.
   */
  if (op == OP_DERIVE) return slot == DERIVE_SLOT;
  return 0;
}

/*
 * A budget lives `lifetime` minutes from its press (0 = 12 hours). millis() counts from boot,
 * and a reboot ends every budget anyway, so the clock never resets inside a budget's life -
 * the same works on a hard key, which has no real-time clock. Wrap-safe like the 25 s press
 * window. An expired budget is simply gone: it pays for nothing, HEAD stops listing it, and
 * its slot is free; no grant-end link is written - the host tells expiry from the lifetime in
 * its grant-create link.
 */
#define DEFAULT_LIFETIME_MIN 720
static int alive(const struct budget *b) {
  return b->id && (uint32_t)(millis() - b->opened) <= b->lifetime_ms;
}

/* unlocked, out of config mode, nothing owed: the only state a budget can pay in */
static int budgets_may_pay(void) {
  return unlocked == true && configmode == false && !owes();
}

/* does the head the host verified (its first n bytes) still match the key's? */
static int head_is(const uint8_t *verified, uint8_t n) { return memcmp(verified, st.head, n) == 0; }

/* a scope matches op and slot - and, on a derived code, the identity's label */
static int scope_matches(const struct scope *sc, uint8_t op, uint8_t slot, const uint8_t *label) {
  if (sc->op != op || sc->slot != slot) return 0;
  if (!sc->has_label) return 1;
  return label && memcmp(sc->label, label, LABEL_PREFIX) == 0;
}

/* the live budget that pays for this use: started, may pay, alive, not on hold, a scope with room; -1 = none */
static int budget_for(uint8_t op, uint8_t slot, const uint8_t *label, struct scope **sc_out) {
  if (!started || !budgets_may_pay()) return -1;
  for (int i = 0; i < MAX_LIVE; i++) {
    struct budget *b = &budgets[i];
    if (!alive(b) || b->on_hold || b->used >= b->uses) continue;
    for (int j = 0; j < b->nscopes; j++) {
      struct scope *sc = &b->scopes[j];
      if (scope_matches(sc, op, slot, label) && sc->used < sc->cap) {
        *sc_out = sc;
        return i;
      }
    }
  }
  return -1;
}

/* a TX start needs a budget that could pay for something: live, not on hold, uses left */
static int any_budget_payable(void) {
  for (int i = 0; i < MAX_LIVE; i++)
    if (alive(&budgets[i]) && !budgets[i].on_hold && budgets[i].used < budgets[i].uses) return 1;
  return 0;
}

static struct budget *live_budget(uint32_t id) {
  for (int i = 0; i < MAX_LIVE; i++) if (id && budgets[i].id == id && alive(&budgets[i])) return &budgets[i];
  return NULL;
}

/*
 * How a budget ended - byte 5 (decision) of its grant-end link. Expiry and a lock or reboot
 * write no link: the budget is simply gone from RAM.
 */
#define END_COMPLETED 1 /* every use made and receipted: the key ends it itself */
#define END_REVOKED 2   /* ended early by GRANT_REVOKE */
#define END_SETTLED 3   /* ended early by a settle - incomplete; the settle receipt after it names the open uses */

/* ends a live budget: its RAM is cleared and a grant-end link names it and how it ended */
static void end_budget(struct budget *b, uint8_t how) {
  uint8_t zero[32] = {0};
  uint32_t id = b->id;
  memset(b, 0, sizeof(*b));
  append(OP_GRANT_END, how, 0, 0, zero, id, 0, NULL);
}

/*
 * A fulfilled budget completes itself: once nothing is owed, every live budget whose uses are
 * all made ends with END_COMPLETED - no host step, so a spent budget never sits live until it
 * expires. Called after each receipt.
 */
static void complete_fulfilled(void) {
  if (owes()) return;
  for (int i = 0; i < MAX_LIVE; i++)
    if (alive(&budgets[i]) && budgets[i].used >= budgets[i].uses) end_budget(&budgets[i], END_COMPLETED);
}

static void press_drop(void) {
  memset(&press, 0, sizeof(press));
}

/*
 * wait for the physical press; okplugin_edge_primed forces it (USER_INPUT_PRESS). The LED pulses
 * yellow (wheel position 43) while the press is awaited, as OKSIGN pulses purple (213) and
 * OKDECRYPT turquoise (128) before their confirmation.
 */
#define EDGE_PRESS_COLOR 43
static void press_wait(uint8_t what, const uint8_t subject[32]) {
  press.what = what;
  press.since = millis();
  press.web = to_web();
  fadeon(EDGE_PRESS_COLOR);
  okcore_prime_user_confirmation(OKEDGE, 0, (uint8_t *)subject, 32);
}

/* GRANT_LABEL {scope index u8, label 32} - no press, no link; it only narrows the next GRANT_CREATE */
static void grant_label(const uint8_t *buffer) {
  uint8_t j = buffer[6];
  if (j >= MAX_SCOPES) { status(EDGE_BAD_SCOPES); return; }
  if (!staged.since || (unsigned long)(millis() - staged.since) > LABEL_STAGE_MS) memset(&staged, 0, sizeof(staged));
  memcpy(staged.label[j], buffer + 7, 32);
  staged.set[j] = 1;
  staged.since = millis();
  if (!staged.since) staged.since = 1; /* 0 means "nothing staged" */
  status(EDGE_OK);
}

/*
 * GRANT_CREATE: [6] scope count, [7..22] scopes (op, slot, cap u16 LE) x4, [23..54] reason
 * hash, [56..57] lifetime u16 (minutes), [58..63] the first GRANT_HEAD_BYTES of the head the
 * host verified its copy up to (a report has no room for all 32). Checked in order: nothing
 * owed, the head, the scope count, each scope (allowed, cap >= 1, a derived code with its
 * staged label), the total uses. The seed and G = H^n(seed) are made here; the budget opens
 * only at the physical press (grant_pressed).
 */
#define GRANT_HEAD_BYTES 6
static void grant_create(const uint8_t *buffer) {
  uint8_t n = buffer[6];
  unsigned uses = 0;
  /* this GRANT_CREATE consumes what GRANT_LABEL staged - fresh only (25 s) */
  int fresh = staged.since && (unsigned long)(millis() - staged.since) <= LABEL_STAGE_MS;
  uint8_t have[MAX_SCOPES];
  uint8_t labels[MAX_SCOPES][32];
  memcpy(have, staged.set, sizeof(have));
  memcpy(labels, staged.label, sizeof(labels));
  memset(&staged, 0, sizeof(staged));
  press_drop();
  if (owes()) { status(EDGE_RECEIPT_OWED); return; }
  if (!head_is(buffer + 58, GRANT_HEAD_BYTES)) { status(EDGE_STALE_HEAD); return; }
  memcpy(press.verified, buffer + 58, GRANT_HEAD_BYTES);
  press.lifetime = get16(buffer + 56);
  press.verified_len = GRANT_HEAD_BYTES;
  if (n < 1 || n > MAX_SCOPES) { status(EDGE_BAD_SCOPES); return; }
  press.scopes_enc[0] = n;
  for (int j = 0; j < n; j++) {
    const uint8_t *p = buffer + 7 + 4 * j;
    struct scope *sc = &press.b.scopes[j];
    sc->op = p[0];
    sc->slot = p[1];
    sc->cap = get16(p + 2);
    if (!scope_allowed(sc->op, sc->slot) || sc->cap < 1) { press_drop(); status(EDGE_SCOPE_NOT_ALLOWED); return; }
    if (derived_code(sc->slot) || sc->op == OP_DERIVE) {
      /* a derived code names one identity, a derive its label - or the budget is refused (EDGE:03) */
      if (!fresh || !have[j]) { press_drop(); status(EDGE_SCOPE_NOT_ALLOWED); return; }
      sc->has_label = 1;
      memcpy(sc->label, labels[j], LABEL_PREFIX);
      memcpy(press.labels[j], labels[j], 32);
    }
    uses += sc->cap;
    memcpy(press.scopes_enc + 1 + 4 * j, p, 4);
  }
  if (uses > MAX_USES) { press_drop(); status(EDGE_TOO_MANY_USES); return; }
  press.scopes_len = 1 + 4 * n;
  press.b.nscopes = n;
  press.b.uses = (uint16_t)uses;
  memcpy(press.reason, buffer + 23, 32);
  RNG2(press.b.seed, 32);
  hash_times(press.b.genesis, press.b.seed, press.b.uses);
  uint8_t what[32];
  H(what, NULL, press.reason, 32, press.b.genesis, 32, press.scopes_enc, press.scopes_len);
  press_wait(PRESS_GRANT, what);
}

/*
 * The press: link grant-create, whose subject commits to the budget (lib grants.grantSubject)
 *   SHA256("OKEDGE-GRANT-v1" || scopes || reason_hash || G || lifetime u16 ||
 *          each derived-code scope's full label, in scope order)
 * and answer with a checkpoint over that link - the key's signature on G.
 * reply: id u32 . uses u16 . G 32 . the link's seq u32; then the checkpoint.
 */
static void grant_pressed(void) {
  int slot = -1;
  if (owes()) { status(EDGE_RECEIPT_OWED); return; } /* a use slipped in while it waited */
  if (!head_is(press.verified, press.verified_len)) { status(EDGE_STALE_HEAD); return; }
  for (int i = 0; i < MAX_LIVE; i++) if (!alive(&budgets[i])) { slot = i; break; } /* an expired budget's slot is free */
  if (slot < 0) { status(EDGE_LIVE_FULL); return; }

  uint32_t seq = st.seq == SEQ_NONE ? 0 : st.seq + 1;
  uint32_t id = seq + 1; /* the seq of its grant-create link, plus one (0 = no budget) */
  uint8_t subject[32], r[42];
  SHA256_CTX ctx;
  sha256_init(&ctx);
  sha256_update(&ctx, (const unsigned char *)"OKEDGE-GRANT-v1", 15);
  sha256_update(&ctx, press.scopes_enc, press.scopes_len);
  sha256_update(&ctx, press.reason, 32);
  sha256_update(&ctx, press.b.genesis, 32);
  uint8_t life[2];
  put16(life, press.lifetime);
  sha256_update(&ctx, life, 2); /* the lifetime the person approved */
  /* then the full labels of derived-code scopes, in scope order - the identities the person approved */
  for (int j = 0; j < press.b.nscopes; j++)
    if (press.b.scopes[j].has_label) sha256_update(&ctx, press.labels[j], 32);
  sha256_final(&ctx, subject);
  press.b.id = id;
  press.b.opened = millis();
  press.b.lifetime_ms = (uint32_t)(press.lifetime ? press.lifetime : DEFAULT_LIFETIME_MIN) * 60000UL;
  budgets[slot] = press.b;
  /* byte 46 of the opening carries its scope count, so every spend of it names one of 1..N */
  append_scoped(OP_GRANT_CREATE, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, subject, id, 0, press.b.nscopes, NULL);

  put32(r, id);
  put16(r + 4, press.b.uses);
  memcpy(r + 6, press.b.genesis, 32);
  put32(r + 38, seq);
  reply(r, 42);
  checkpoint();
}

/* the press that lets a held budget pay again (refused while a receipt is owed) */
static void resume_pressed(void) {
  struct budget *b = live_budget(press.id);
  if (!b) { status(EDGE_NO_SUCH_BUDGET); return; }
  if (owes()) { status(EDGE_RECEIPT_OWED); return; }
  if (!head_is(press.verified, press.verified_len)) { status(EDGE_STALE_HEAD); return; }
  if (b->on_hold) {
    uint8_t zero[32] = {0};
    b->on_hold = 0;
    append(OP_GRANT_RESUME, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, zero, b->id, 0, NULL);
  }
  status(EDGE_OK);
}

/*
 * The way out for a debt nobody will receipt: one press clears it. Linked as a receipt,
 * code 0x8F (needs review), the press flag, grant_id = the owed seq, and
 *   subject = SHA256("OKEDGE-SETTLE-v1" || the owed seq (u32 LE))   (lib receipts.settleSubject)
 */
static void settle_pressed(void) {
  if (!owes()) { status(EDGE_NO_RECEIPT_WAITING); return; } /* paid while it waited */
  /*
   * A settle ends every live budget first, held or not, each with its grant-end link: a debt
   * cleared by a press must not leave a budget that goes on paying. More uses take a new budget
   * and its own press.
   */
  for (int i = 0; i < MAX_LIVE; i++) if (alive(&budgets[i])) end_budget(&budgets[i], END_SETTLED);
  uint8_t subject[32];
  settle_subject(&st, subject);
  append(OP_RECEIPT, CODE_NEEDS_REVIEW, 0, FLAG_PRESS_OBSERVED, subject, st.owed.seq, 0, NULL); /* the weld clears the debt */
  reply_seq_head();
}

/*
 * LOSS subject: to (u32 LE), then the first 28 bytes of SHA-256(link to+1) when the key holds
 * that link - its latest, or one in the ring - from its own memory. Its predecessor is in the
 * lost range, so its own bytes can never be welded again; this is the key naming them, and a
 * host counts the copy's #to+1 only when it hashes to this. Not held (or past the head):
 * zeros, and the host offers #from..#to+1 instead.
 */
static void loss_subject(uint32_t to, uint8_t subject[32]) {
  memset(subject, 0, 32);
  put32(subject, to);
  if (st.seq == SEQ_NONE || to == SEQ_NONE || to >= st.seq) return; /* no link to+1 in this chain */
  uint32_t next = to + 1;
  const uint8_t *link = NULL;
  if (next == st.seq) link = st.last_link;
  else {
    struct held_link *h = &held[next % HELD];
    if (h->used && h->seq == next) link = h->link;
  }
  if (!link) return;
  uint8_t d[32];
  H(d, NULL, link, LINK_BYTES, NULL, 0, NULL, 0);
  memcpy(subject + 4, d, 28);
}

/*
 * LOSS {from, to}, at a press: the person accepts #from..#to as unrecoverable - no copy
 * anywhere holds it. One link: op = loss, decision approve, slot 0, the press flag,
 * grant_id = from, subject = loss_subject(to). It records the acceptance and pays no debt
 * (only a receipt or a settle does); a host then accepts a gap covered by it.
 * reply: seq . head after it.
 */
static void loss_pressed(void) {
  uint8_t subject[32];
  loss_subject(press.id, subject);
  append(OP_LOSS, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, subject, press.from, 0, NULL);
  reply_seq_head();
}

/* ------------------------------------------------------------ hooks */

/*
 * okcore_prime_user_confirmation(): an operation now waits for its decision.
 * An OKEDGE request always takes a physical press. A sign/decrypt is recorded in `pend`:
 * its subject (SHA-256 of exactly the bytes submitted), its label on a derived code, and -
 * when a TX start is pending - whether it is the announced request (else refused with
 * EDGE_TX_MISMATCH, no press, and the TX start is spent). A budget that pays it lets the
 * firmware's no-press path run it; otherwise it is an ordinary request and the person's
 * press decides.
 */
void okplugin_edge_primed(uint8_t opcode, uint8_t slot, const uint8_t *msg, size_t msg_len) {
  pend.active = 0;
  pend.budget = -1;
  if (opcode == OKEDGE) {
    user_input_mode = USER_INPUT_PRESS; /* a grant, resume, settle or loss always takes a physical press */
    return;
  }
  if (opcode != OKSIGN && opcode != OKDECRYPT) return;
  pend.active = 1;
  pend.has_intent = 0;
  pend.refuse = 0;
  pend.opcode = opcode;
  pend.slot = slot;
  H(pend.subject, NULL, msg, msg_len, NULL, 0, NULL, 0); /* SHA-256 of exactly what was submitted */
  /* a derived-code request is message || identity label (32): the label picks the derived key */
  pend.has_label = derived_code(slot) && msg_len >= 32;
  if (pend.has_label) memcpy(pend.label, msg + msg_len - 32, LABEL_PREFIX);
  state_load();
  if (started) {
    /* is this request, after THIS head, the one the TX start was for? */
    uint8_t t[32];
    H(t, "OKEDGE-TX-v1", st.head, 32, pend.subject, 32, tx_intent, 16); /* zeros when no intent */
    if (memcmp(t, tx_token, 32) != 0) {
      /*
       * Not the announced request: refused, not pressed - no prompt, no link. The TX start
       * is spent and the refusal is counted in HEAD byte 60. The core runs the request at
       * once without a press, and okplugin_edge_refused() answers EDGE:1C before anything
       * is signed.
       */
      started = 0;
      pend.refuse = EDGE_TX_MISMATCH;
      if (refused_tx < 255) refused_tx++;
      user_input_mode = USER_INPUT_NONE;
      pend.press = 0;
      return;
    }
    else if (tx_has_intent) { pend.has_intent = 1; memcpy(pend.intent, tx_intent, 16); }
  }
  struct scope *sc;
  int i = budget_for(opcode == OKSIGN ? OP_SIGN : OP_DECRYPT, slot, pend.has_label ? pend.label : NULL, &sc);
  if (i >= 0) {
    pend.budget = (int8_t)i;
    user_input_mode = USER_INPUT_NONE; /* a budget pays: the firmware's own no-press path runs it */
  } else if (started) {
    /*
     * The announced request, but no budget can pay it now (it expired, was held or ended in
     * between): it is an ordinary request - the person's press decides, and an ordinary
     * press writes no link. The TX start is spent here, or the person's own next request
     * would meet it and be refused as a mismatch.
     */
    started = 0;
  }
  pend.press = user_input_mode != USER_INPUT_NONE;
}

/*
 * The decision: approve (the press, or the no-press path a budget opened), deny or timeout.
 * For an OKEDGE request, an approve within PRESS_MS runs the pressed action. For a
 * sign/decrypt, only a budget use is linked: a self-press link that spends the budget,
 * reveals the next value of its series, carries the intent and owes a receipt. An ordinary
 * press - approved, denied or timed out - writes no link.
 */
void okplugin_edge_decision(int decision) {
  if (packet_buffer_details[0] == OKEDGE) {
    uint8_t what = press.what;
    int fresh = what && millis() - press.since <= PRESS_MS;
    /* a timeout or a wrong press: the core's own path ends the pulse (red) */
    if (decision != OKEDGE_DECISION_APPROVE) { press_drop(); return; }
    /* an approve that cannot be used ends the pulse red; a pressed action ends it green, as a finished OKSIGN */
    if (!fresh) { press_drop(); fadeoff(1); return; }
    /* a press asked for over WebAuthn: its answer is stored there, collected into one answer */
    uint8_t web = press.web;
    if (web) {
      outputmode = WEBAUTHN;
      web_more.set = 0;
      web_len = 0;
    }
    if (!ensure_identity()) {
      press_drop();
      fadeoff(1);
      status(EDGE_NEED_PIN);
      if (web) web_len = -1;
      return;
    }
    if (what == PRESS_GRANT) grant_pressed();
    else if (what == PRESS_RESUME) resume_pressed();
    else if (what == PRESS_SETTLE) settle_pressed();
    else if (what == PRESS_LOSS) loss_pressed();
    press_drop();
    if (web) web_flush();
    fadeoff(85);
    return;
  }
  if (!pend.active) return;
  if (decision == OKEDGE_DECISION_APPROVE && packet_buffer_details[0] != pend.opcode) return;
  pend.active = 0;
  if (!ensure_identity()) return; /* no K132 yet: nothing to chain to */
  uint8_t op = pend.opcode == OKSIGN ? OP_SIGN : OP_DECRYPT;
  if (decision == OKEDGE_DECISION_APPROVE && pend.budget >= 0) {
    struct scope *sc;
    if (budget_for(op, pend.slot, pend.has_label ? pend.label : NULL, &sc) == pend.budget) { /* still started, live, with room */
      struct budget *b = &budgets[pend.budget];
      uint8_t reveal[32];
      b->used++;
      sc->used++;
      hash_times(reveal, b->seed, b->uses - b->used); /* v_i = H^(n-i)(seed) (lib grants.reveal) */
      if (pend.has_intent) next_intent = pend.intent; /* the intent, welded in with the use */
      append_scoped(op, DECISION_SELF_PRESS, pend.slot, FLAG_OWES_RECEIPT | FLAG_BUDGET_SPENT, pend.subject, b->id, b->used,
                    (uint8_t)(sc - b->scopes + 1), reveal); /* byte 46: which scope paid */
      memset(reveal, 0, 32);
      return;
    }
  }
}

/*
 * A derive a budget pays. Asked by the core's derive gate (plugin.js hook) for a request it would otherwise put to field 30, with
 * that request's bytes: derive_secret's touchless payload, mode || label hash. Paid exactly as a sign is: announced by
 * its TX start (this request, after this head), a live budget with a DERIVE scope on slot 128 naming this label,
 * unlocked and nothing owed - then it is a self-press link that spends the budget, reveals the next value of its series,
 * carries the intent and owes a receipt, and the gate answers without asking. Anything else -> 0: the gate asks as it
 * always does (an announced derive no budget can pay spends its TX start, as a sign's does). A touch derive - a secret
 * the person reveals with a press - is never paid: the gate asks only for floor NONE, and the mode byte is checked.
 */
static uint8_t derive_intent[16];
int okplugin_edge_pay_derive(const uint8_t *payload, int len) {
  if (len != DERIVE_PAYLOAD || payload[0] != DERIVE_TOUCHLESS) return 0;
  state_load();
  if (!started) return 0;
  uint8_t subject[32], t[32];
  H(subject, NULL, payload, (size_t)len, NULL, 0, NULL, 0);
  H(t, "OKEDGE-TX-v1", st.head, 32, subject, 32, tx_intent, 16);
  int announced = memcmp(t, tx_token, 32) == 0;
  struct scope *sc;
  int i = announced && ensure_identity() ? budget_for(OP_DERIVE, DERIVE_SLOT, payload + 1, &sc) : -1;
  if (i < 0) {
    /* not the announced request, or nothing can pay it: an ordinary derive - the TX start is spent either way */
    started = 0;
    if (!announced && refused_tx < 255) refused_tx++;
    return 0;
  }
  struct budget *b = &budgets[i];
  uint8_t reveal[32];
  b->used++;
  sc->used++;
  hash_times(reveal, b->seed, b->uses - b->used); /* v_i = H^(n-i)(seed) (lib grants.reveal) */
  if (tx_has_intent) { memcpy(derive_intent, tx_intent, 16); next_intent = derive_intent; }
  append_scoped(OP_DERIVE, DECISION_SELF_PRESS, DERIVE_SLOT, FLAG_OWES_RECEIPT | FLAG_BUDGET_SPENT, subject, b->id, b->used,
                (uint8_t)(sc - b->scopes + 1), reveal);
  memset(reveal, 0, 32);
  return 1;
}

/*
 * Called first in okcore_run_pending_op (plugin.js hook), before the request runs. Refuses
 * (1) a request that did not match its TX start (EDGE:1C) and (2) a request primed to be paid
 * by a budget that can no longer pay (EDGE:0D): it must never run without a press and without
 * a link. -> 1 = refused.
 */
int okplugin_edge_refused(void) {
  if (!pend.active) return 0;
  if (pend.refuse) {
    uint8_t code = pend.refuse;
    pend.active = 0;
    pend.refuse = 0;
    status(code);
    return 1;
  }
  if (pend.budget >= 0 && !pend.press) {
    struct scope *sc;
    uint8_t op = pend.opcode == OKSIGN ? OP_SIGN : OP_DECRYPT;
    if (budget_for(op, pend.slot, pend.has_label ? pend.label : NULL, &sc) != pend.budget) {
      pend.active = 0;
      status(EDGE_NOTHING_TO_PAY);
      return 1;
    }
  }
  return 0;
}

/*
 * wipeflashdata(), and the DEBUG-only Edge wipe: both state sectors erased, live budgets and
 * held links dropped. The next Edge request draws a new salt: a new device id and a new
 * chain. Only the Edge region is written - no key, slot or setting outside it.
 */
void okplugin_edge_wipe(void) {
  uint8_t blank[4] = {0xff, 0xff, 0xff, 0xff};
  okcore_flashsector(blank, (unsigned long *)EDGE_STATE_A, 4);
  okcore_flashsector(blank, (unsigned long *)EDGE_STATE_B, 4);
  memset(budgets, 0, sizeof(budgets));
  memset(held, 0, sizeof(held));
  memset(&ident, 0, sizeof(ident));
  memset(&st, 0, sizeof(st));
  st.seq = SEQ_NONE;
  loaded = 1;
  started = 0;
  pend.active = 0;
  press_drop();
}

/* ------------------------------------------------------------ backup */

/*
 * The plugin backup section (the loader: node-onlykey-lib/cli/firmware-plugins.js), version 1:
 *   1 . seq u32 . head 32 . owes (0 or 1) . the owed use (seq u32, head 32) when owes . device id 16
 * The debt travels with the backup, because only a receipt or a settle may pay it - a
 * restore must not forgive it. The device id names the chain the restored key continues
 * (its continue link). Budgets end at a restore (their seeds are never stored); the links
 * themselves are the host's. The SALT IS NEVER HERE: a restored key must never become the
 * device that made the backup. A section of another version is not restored.
 */
int okplugin_edge_backup(uint8_t *out, int max) {
  state_load();
  if (!ensure_identity()) return 0;
  int len = 38 + 36 * st.owes + ID_BYTES;
  if (max < len || st.seq == SEQ_NONE) return 0; /* no chain yet: nothing to keep */
  out[0] = 1;
  put32(out + 1, st.seq);
  memcpy(out + 5, st.head, 32);
  out[37] = st.owes;
  if (st.owes) {
    put32(out + 38, st.owed.seq);
    memcpy(out + 42, st.owed.head, 32);
  }
  memcpy(out + 38 + 36 * st.owes, ident.device_id, ID_BYTES);
  return len;
}

/*
 * A restore always draws a new salt: the restored key is a device of its own - even on the
 * device that made the backup it can never write a second history under the old device id -
 * and its first link (continue) names the backup's chain, its seq and head, and carries the
 * debt, if any. The chain goes on from there, never from zero.
 */
void okplugin_edge_restore(const uint8_t *in, int len) {
  if (len < 38 || in[0] != 1 || in[37] > 1) return; /* a section this build does not know: keep what it has */
  uint8_t n = in[37];
  if (len < 38 + 36 * n + ID_BYTES) return;
  /* keep the record generation counting UP: the newer sector wins at load */
  state_load();
  uint32_t gen = st.gen;
  memset(&st, 0, sizeof(st));
  memset(&ident, 0, sizeof(ident));
  st.gen = gen;
  st.seq = get32(in + 1);
  memcpy(st.head, in + 5, 32);
  st.owes = n;
  if (n) {
    st.owed.seq = get32(in + 38);
    memcpy(st.owed.head, in + 42, 32);
  }
  /* the continue link is written on the first Edge request, once the new salt is drawn */
  st.cont = CONT_FROM_ID;
  memcpy(st.cont_id, in + 38 + 36 * n, ID_BYTES);
  memset(held, 0, sizeof(held));
  memset(budgets, 0, sizeof(budgets));
  started = 0;
  loaded = 1;
  state_save();
}

/* ------------------------------------------------------------ OKEDGE */

void okplugin_edge_recv(uint8_t *buffer) {
  if (!(initialized == true && unlocked == true && configmode == false)) return;
  if (!ensure_identity()) { status(EDGE_NEED_PIN); return; }
  if (press.what && millis() - press.since > PRESS_MS) press_drop(); /* never pressed */
  uint8_t r[64];
  memset(r, 0, sizeof(r));
  switch (buffer[5]) {
    case OKEDGE_HEAD: {
      /*
       * seq (SEQ_NONE = empty) . head (the genesis while empty) . oldest pickable seq .
       * live budget ids x4 . held mask (bit i = budget i on hold) . owes (0 or 1) . 58 reserved 0 .
       * 59 reserved 0 . 60 TX starts refused since power-up
       */
      uint32_t oldest = SEQ_NONE;
      uint8_t mask = 0;
      for (int i = 0; i < HELD; i++) if (held[i].used && held[i].seq < oldest) oldest = held[i].seq;
      put32(r, st.seq);
      memcpy(r + 4, st.head, 32);
      put32(r + 36, oldest);
      for (int i = 0; i < MAX_LIVE; i++) {
        int up = alive(&budgets[i]);
        put32(r + 40 + 4 * i, up ? budgets[i].id : 0);
        if (up && budgets[i].on_hold) mask |= 1 << i;
      }
      r[56] = mask;
      r[57] = st.owes;
      r[60] = refused_tx;
      reply(r, 62);
      return;
    }
    case OKEDGE_PICKUP: {
      /* from u32 . count u8 (<= 8); per link: the link, then its head + the reveal (zeros if none) */
      uint32_t from = get32(buffer + 6);
      uint8_t count = buffer[10] > HELD ? HELD : buffer[10];
      if (web_len >= 0 && count > WEB_PICKUP_MAX) { status(EDGE_BAD_RANGE); return; } /* over WebAuthn: one answer */
      for (uint32_t s = from; s < from + count; s++) {
        struct held_link *h = &held[s % HELD];
        if (!h->used || h->seq != s) { status(EDGE_NOT_HELD); return; }
      }
      for (uint32_t s = from; s < from + count; s++) {
        struct held_link *h = &held[s % HELD];
        reply(h->link, LINK_BYTES);
        memcpy(r, h->head, 32);
        memcpy(r + 32, h->reveal, 32);
        reply(r, 64);
      }
      return;
    }
    case OKEDGE_CHECKPOINT:
      checkpoint();
      return;
    case OKEDGE_PUBKEY:
      reply(ident.pub, 64);
      return;
    case OKEDGE_PUBKEY_PQ:
      mldsa_pubkey_reply(buffer[6] ? MLDSA_OWNER_KEY : MLDSA_CHECKPOINT_KEY);
      return;
    case OKEDGE_MORE: {
      /* over WebAuthn: the ML-DSA-65 signature the last answer left out; nothing is kept over USB */
      if (!web_more.set) { status(EDGE_UNKNOWN_REQUEST); return; }
      uint8_t which = web_more.which, digest[32];
      memcpy(digest, web_more.digest, 32);
      memset(&web_more, 0, sizeof(web_more));
      if (!mldsa_sign_reply(which, digest)) status(EDGE_SIGN_FAILED);
      memset(digest, 0, 32);
      return;
    }
    case OKEDGE_STATEMENT:
      statement(buffer + 6);
      return;
    case OKEDGE_GRANT_LABEL:
      grant_label(buffer);
      break;
    case OKEDGE_GRANT_CREATE:
      grant_create(buffer);
      return;
    case OKEDGE_GRANT_REVOKE: {
      /* ends a live budget, held or not; a debt it made stays owed */
      struct budget *b = live_budget(get32(buffer + 6));
      if (!b) { status(EDGE_NO_SUCH_BUDGET); return; }
      end_budget(b, END_REVOKED);
      status(EDGE_OK);
      return;
    }
#ifdef DEBUG
    /*
     * DEBUG builds only: the Edge state erased (okplugin_edge_wipe), so the next Edge request
     * starts a new chain with a new device id. No key outside the Edge region is touched. A
     * production build has no such case: it falls to "unknown sub-op".
     */
    case OKEDGE_WIPE_DEBUG:
      okplugin_edge_wipe();
      status(EDGE_OK);
      return;
#endif
    case OKEDGE_GRANT_HOLD: {
      /* no press - it only makes the key stricter. Holding a held budget links nothing. */
      uint32_t id = get32(buffer + 6);
      struct budget *b = live_budget(id);
      if (!b) { status(EDGE_NO_SUCH_BUDGET); return; }
      if (!b->on_hold) {
        uint8_t zero[32] = {0};
        b->on_hold = 1;
        append(OP_GRANT_HOLD, OKEDGE_DECISION_APPROVE, 0, 0, zero, id, 0, NULL);
      }
      status(EDGE_OK);
      return;
    }
    case OKEDGE_GRANT_RESUME: {
      /* id u32 . the head the host verified (32). A physical press; refused while a receipt is owed. */
      uint32_t id = get32(buffer + 6);
      uint8_t what[32];
      press_drop();
      if (!live_budget(id)) { status(EDGE_NO_SUCH_BUDGET); return; }
      if (owes()) { status(EDGE_RECEIPT_OWED); return; }
      if (!head_is(buffer + 10, 32)) { status(EDGE_STALE_HEAD); return; }
      memcpy(press.verified, buffer + 10, 32);
      press.verified_len = 32;
      press.id = id;
      H(what, "OKEDGE-RESUME", buffer + 6, 4, NULL, 0, NULL, 0);
      press_wait(PRESS_RESUME, what);
      return;
    }
    case OKEDGE_RECEIPT: {
      /*
       * ref_seq u32 . code u8 . msg_hash 32, for any owed use:
       *   SHA256("OKEDGE-RECEIPT-v1" || ref_seq || head[ref_seq] || code || msg_hash)
       * (lib receipts.receiptSubject), head[ref_seq] from the owed use. The message itself
       * never reaches the key. reply: seq . head after the receipt link - and after its budget's
       * grant-end link when this receipt completed it.
       */
      uint32_t ref = get32(buffer + 6);
      uint8_t code = buffer[10];
      if (!st.owes || st.owed.seq != ref) { status(EDGE_NO_RECEIPT_WAITING); return; }
      uint8_t ref4[4], subject[32];
      put32(ref4, ref);
      SHA256_CTX ctx;
      sha256_init(&ctx);
      sha256_update(&ctx, (const unsigned char *)"OKEDGE-RECEIPT-v1", sizeof("OKEDGE-RECEIPT-v1") - 1);
      sha256_update(&ctx, ref4, 4);
      sha256_update(&ctx, st.owed.head, 32);
      sha256_update(&ctx, &code, 1);
      sha256_update(&ctx, buffer + 11, 32);
      sha256_final(&ctx, subject);
      append(OP_RECEIPT, code, 0, 0, subject, ref, 0, NULL); /* the weld pays ref */
      complete_fulfilled(); /* its budget, if this was its last open use */
      reply_seq_head();
      return;
    }
    case OKEDGE_SETTLE: {
      /* a physical press ends every live budget and clears the debt (settle_pressed) */
      uint8_t what[32];
      press_drop();
      if (!owes()) { status(EDGE_NO_RECEIPT_WAITING); return; }
      H(what, "OKEDGE-SETTLE", st.head, 32, NULL, 0, NULL, 0);
      press_wait(PRESS_SETTLE, what);
      return;
    }
    case OKEDGE_TX_START: {
      /*
       * TX start {token 32, intent 16}: starts ONE self-press when nothing is owed and some
       * budget (alive, off hold, uses left) could pay; otherwise refused and counted, with no
       * link. Whether the token fits - this head, this request - is decided when the request
       * is primed (okplugin_edge_primed).
       */
      uint8_t has_intent = 0;
      for (int k = 0; k < 16; k++) has_intent |= buffer[38 + k];
      if (owes()) { refuse_tx(EDGE_RECEIPT_OWED); return; }
      if (!any_budget_payable()) { refuse_tx(EDGE_NOTHING_TO_PAY); return; }
      memcpy(tx_token, buffer + 6, 32);
      memcpy(tx_intent, buffer + 38, 16); /* zeros = no intent (still in the token) */
      tx_has_intent = has_intent;
      started = 1;
      status(EDGE_OK);
      return;
    }
    case OKEDGE_LOSS: {
      /* from u32 . to u32, a press. Only a past range (to at or before the head) can be lost. */
      uint32_t from = get32(buffer + 6), to = get32(buffer + 10);
      uint8_t what[32];
      press_drop();
      if (st.seq == SEQ_NONE || from > to || to > st.seq) { status(EDGE_BAD_RANGE); return; }
      press.from = from;
      press.id = to;
      H(what, "OKEDGE-LOSS", buffer + 6, 8, st.head, 32, NULL, 0);
      press_wait(PRESS_LOSS, what);
      return;
    }
    default:
      status(EDGE_UNKNOWN_REQUEST);
      return;
  }
}

/*
 * An OKEDGE message over WebAuthn (ok_extension.cpp's transit dispatch). The request is rebuilt in the vendor report's
 * layout - sub-op in [5], its arguments from [6], up to 58 bytes - so okplugin_edge_recv() reads it as it reads a
 * report. Its 64-byte replies are collected and stored as one answer, sealed; a status text is stored as it is sent.
 * A request that waits for a press stores nothing here: the browser's polls see the confirmation pending, and the
 * reply made at the press is stored sealed then.
 */
void okplugin_edge_ctap(const uint8_t *data, int len, uint8_t sub) {
  uint8_t buffer[64];
  memset(buffer, 0, sizeof(buffer));
  memset(buffer, 0xFF, 4);
  buffer[4] = OKEDGE;
  buffer[5] = sub;
  if (len > 0) memcpy(buffer + 6, data, len < 58 ? len : 58);
  outputmode = WEBAUTHN;
  if (sub == OKEDGE_MORE) {
    okplugin_edge_recv(buffer); /* an answer of its own, not collected */
  } else {
    web_more.set = 0;
    web_len = 0;
    okplugin_edge_recv(buffer);
    web_flush();
  }
  memset(buffer, 0, sizeof(buffer));
}
