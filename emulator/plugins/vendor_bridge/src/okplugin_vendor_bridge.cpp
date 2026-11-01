/*
 * vendor_bridge: see okplugin_vendor_bridge.h.
 *
 * The answer is sent with RawHID directly, not send_transport_response: the tunnel's operations leave outputmode at
 * WEBAUTHN, which is what stores a result that finishes later (after a press) for the next OKPING to collect - as on
 * the CTAP2 path. Changing it here would send that later result out unasked.
 */
#include <string.h>
#include "onlykey.h"
#include "usb_rawhid.h"
#include "okplugin_vendor_bridge.h"
#include "plugins/ctap_bridge/okplugin_ctap_bridge.h"

int16_t bridge_u2f_to_solo(uint8_t *_appid, uint8_t *output, uint8_t *keyh, int keylen);
int is_extension_request(uint8_t *kh, int len);
extern uint16_t output_buffer_offset;
extern uint16_t output_buffer_size;

#define VB_IN 58                  /* request bytes per report */
#define VB_REQ_MAX (2 + 256 + VB_IN)  /* total length . credential ID, in whole reports */
#define VB_OUT_MAX (1 + 512)      /* status + one MAX_LARGE_RESP_CHUNK, as ctap.cpp's sigder */

static uint8_t req[VB_REQ_MAX];
static int req_have = 0;          /* bytes gathered so far */
static uint8_t req_next = 0;      /* the index expected next */
static uint8_t out[VB_OUT_MAX];

static void vb_reset(void) {
  memset(req, 0, sizeof(req));
  req_have = 0;
  req_next = 0;
}

static void vb_send(const uint8_t *data, int len) {
  uint8_t r[64];
  int at = 0;
  for (uint8_t index = 0;; index++) {
    memset(r, 0, sizeof(r));
    r[0] = 0xFD;
    int room = 62, start = 2;
    if (index == 0) {
      r[2] = len & 0xff;
      r[3] = (len >> 8) & 0xff;
      room = 60;
      start = 4;
    }
    int n = len - at > room ? room : len - at;
    memcpy(r + start, data + at, n);
    at += n;
    r[1] = index | (at >= len ? 0x80 : 0);
    for (int tries = 0; tries < 5; tries++) {
      if (RawHID.send2(r, 100)) break;
    }
    if (at >= len) break;
  }
  memset(r, 0, sizeof(r));
}

void okplugin_vendor_bridge_recv(uint8_t *buffer) {
  if (!(initialized == true && unlocked == true)) {
    vb_reset();
    hidprint("Error vendor_bridge device locked");
    return;
  }
  uint8_t index = buffer[5] & 0x7f;
  uint8_t last = buffer[5] & 0x80;
  if (index == 0) vb_reset();
  if (index != req_next || req_have + VB_IN > (int)sizeof(req)) {
    vb_reset();
    hidprint("Error vendor_bridge out of order");
    return;
  }
  memcpy(req + req_have, buffer + 6, VB_IN);
  req_have += VB_IN;
  req_next++;
  if (!last) return;

  int keylen = req[0] | (req[1] << 8);
  if (keylen <= 0 || 2 + keylen > req_have || keylen > 256 || !is_extension_request(req + 2, keylen)) {
    vb_reset();
    hidprint("Error vendor_bridge malformed request");
    return;
  }
  /* the key's own rpId: ctap_bridge's site */
  uint8_t rpid_hash[32];
  if (!okplugin_ctap_bridge_site_hash(rpid_hash)) {
    vb_reset();
    hidprint("Error vendor_bridge no site set");
    return;
  }
  /* as extend_fido2: [status][output]; with the rpId hash as the appid, as the U2F entry hands it in */
  memset(out, 0, sizeof(out));
  out[0] = (uint8_t)bridge_u2f_to_solo(rpid_hash, out + 1, req + 2, keylen);
  memset(rpid_hash, 0, sizeof(rpid_hash));
  int n = 1;
  if (output_buffer_size != 0 && output_buffer_offset && output_buffer_offset + 1 <= (int)sizeof(out)) n = output_buffer_offset + 1;
  vb_reset();
  vb_send(out, n);
  memset(out, 0, sizeof(out));
}
