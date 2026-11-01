/*
 * ctap_bridge: see okplugin_ctap_bridge.h.
 *
 * Storage: 50 bytes of EEPROM after the base firmware's last field (EEpos_webcrypt_policy).
 *   [0]      'D' = off; any other value = on
 *   [1]      the allowed rpId's length, 1..48; CB_SITE_NONE = none; any other value (unset) = CB_SITE_DEFAULT
 *   [2..49]  the allowed rpId (ASCII), compared as its SHA-256 with the request's rpId hash
 */
#include <string.h>
#include "onlykey.h"
#include "okplugin_ctap_bridge.h"
#include "sha256.h"

extern "C" {
void okeeprom_eeget_common(uint8_t *ptr, int addr, int len);
void okeeprom_eeset_common(uint8_t *ptr, int addr, int len);
}

#define CB_POS (EEpos_webcrypt_policy + EElen_webcrypt_policy)
#define CB_OFF 'D'
#define CB_SITE_MAX 48
#define CB_SITE_NONE 0xFE
/* the allowed rpId while none is stored and none was cleared */
#ifndef CB_SITE_DEFAULT
#define CB_SITE_DEFAULT "ok-edge.bmatusiak.workers.dev"
#endif

static int cb_on(void) {
  uint8_t v = 0;
  okeeprom_eeget_common(&v, CB_POS, 1);
  return v != CB_OFF;
}

/* the allowed rpId into site (NUL-terminated); its length, 0 when none */
static int cb_site(char *site) {
  uint8_t len = 0;
  okeeprom_eeget_common(&len, CB_POS + 1, 1);
  if (len == CB_SITE_NONE) { site[0] = 0; return 0; }
  if (len == 0 || len > CB_SITE_MAX) {
    strcpy(site, CB_SITE_DEFAULT);
    return strlen(site);
  }
  okeeprom_eeget_common((uint8_t *)site, CB_POS + 2, len);
  site[len] = 0;
  return len;
}

/* "ctap_bridge on|off site <rpId>|none" into line (24 + CB_SITE_MAX bytes) - the report, USB and tunnel alike */
static void cb_report(char *line) {
  char site[CB_SITE_MAX + 1];
  strcpy(line, "ctap_bridge ");
  strcat(line, cb_on() ? "on site " : "off site ");
  strcat(line, cb_site(site) ? site : "none");
}

int okplugin_ctap_bridge_allows(uint8_t cmd, uint8_t code) {
  if (!cb_on()) return 0;
  if (cmd == OKGETPUBKEY) return code == RESERVED_KEY_DERIVATION || code == DERIVATION_V2_PUBKEY_CODE;
  if (cmd == OKCTAPBRIDGE) return 1; /* its report, read only (okplugin_ctap_bridge_report_sealed) */
  if (cmd == (TYPE_INIT | 0x78)) return 1; /* OKEDGE: handled by the edge plugin's okplugin_edge_ctap() when it is built in */
  if (cmd == OKSIGN || cmd == OKDECRYPT) return (code >= 201 && code <= 204) || (code >= 221 && code <= 224);
  return 0;
}

/*
 * The request's rpId when no hash is handed in: a CTAP2 getAssertion (extend_fido2 passes no appid), read from the
 * request itself as webcryptcheck reads it - command 0x02, then the map's key 1, a CBOR text string. The text header is
 * one byte for a name under 24 characters and two (0x78, length) up to 255; the allowed site may be either.
 * Its length into *len, a pointer to the name; NULL when the request is not a getAssertion with an rpId first.
 */
static const uint8_t *cb_request_rpid(int *len) {
  extern uint8_t ctap_buffer[];
  if (ctap_buffer[0] != 0x02 || ctap_buffer[2] != 0x01) return NULL;
  uint8_t hdr = ctap_buffer[3];
  if ((hdr & 0xE0) == 0x60 && (hdr & 0x1F) < 24) { *len = hdr & 0x1F; return ctap_buffer + 4; }
  if (hdr == 0x78) { *len = ctap_buffer[4]; return ctap_buffer + 5; }
  return NULL;
}

/*
 * the allowed site's SHA-256 into hash: 1, or 0 when none is set - the rpId vendor_bridge acts as (Brad, 2026-10-31:
 * "we should use the rpid set in the plugin that is configurable"). The site, not the on/off byte: that one switches
 * the WebAuthn tunnel's extras.
 */
int okplugin_ctap_bridge_site_hash(uint8_t hash[32]) {
  char site[CB_SITE_MAX + 1];
  int len = cb_site(site);
  if (!len) return 0;
  SHA256_CTX ctx;
  sha256_init(&ctx);
  sha256_update(&ctx, (const uint8_t *)site, (size_t)len);
  sha256_final(&ctx, hash);
  memset(site, 0, sizeof(site));
  return 1;
}

int okplugin_ctap_bridge_site(const uint8_t *appid) {
  char site[CB_SITE_MAX + 1];
  int len;
  if (!cb_on() || !(len = cb_site(site))) return 0;
  if (!appid) {
    int n = 0;
    const uint8_t *name = cb_request_rpid(&n);
    return name && n == len && memcmp(name, site, (size_t)len) == 0;
  }
  uint8_t hash[32];
  SHA256_CTX ctx;
  sha256_init(&ctx);
  sha256_update(&ctx, (const uint8_t *)site, (size_t)len);
  sha256_final(&ctx, hash);
  return memcmp(hash, appid, 32) == 0;
}

extern uint8_t ecc_public_key[(MAX_ECC_KEY_SIZE * 2) + 1];

/*
 * The agent public key, as okcrypto_getpubkey derives it for codes 132 / 232, with the reply sealed by the tunnel's
 * transit key (send_transport_response encrypt = 1). buffer[7] is the key type, buffer[8..39] the identity hash.
 */
void okplugin_ctap_bridge_getpubkey(uint8_t *buffer) {
  uint8_t code = buffer[5];
  uint8_t type = buffer[7];
  int v2 = code == DERIVATION_V2_PUBKEY_CODE;
  if (type > KEYTYPE_CURVE25519 || (v2 && type == 0)) {
    hidprint("Error key type");
    return;
  }
  okcrypto_derive_key(type, buffer + 8, v2 ? RESERVED_KEY_DERIVATION : 0);
  send_transport_response(ecc_public_key, 64, 1, 0);
}

void okplugin_ctap_bridge_recv(uint8_t *buffer) {
  if (!(initialized == true && unlocked == true)) {
    hidprint("Error device locked");
    return;
  }
  uint8_t action = buffer[5];
  if (action != 0 && configmode == false) {
    hidprint("Error not in config mode");
    return;
  }
  uint8_t b;
  switch (action) {
    case 0:
      break;
    case 1:
    case 2:
      b = action == 2 ? CB_OFF : 0x01;
      okeeprom_eeset_common(&b, CB_POS, 1);
      break;
    case 3: {
      uint8_t len = buffer[6];
      if (len == 0 || len > CB_SITE_MAX) {
        hidprint("Error rpId length");
        return;
      }
      okeeprom_eeset_common(buffer + 7, CB_POS + 2, len);
      okeeprom_eeset_common(&len, CB_POS + 1, 1);
      break;
    }
    case 4:
      b = CB_SITE_NONE;
      okeeprom_eeset_common(&b, CB_POS + 1, 1);
      break;
    default:
      hidprint("Error unknown ctap_bridge action");
      return;
  }
  char line[24 + CB_SITE_MAX];
  cb_report(line);
  hidprint(line);
}

/*
 * The report over the WebAuthn tunnel, sealed by the transit key: the same text as over USB, so a browser learns the
 * key's site - the server it belongs to - the way every other host does. Read only: no action byte is read.
 */
void okplugin_ctap_bridge_report_sealed(void) {
  char line[24 + CB_SITE_MAX];
  cb_report(line);
  send_transport_response((uint8_t *)line, strlen(line), 1, 0);
}
