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

/* C linkage, as fido2's solo.h and extensions.h declare them (a C++ declaration names another symbol: the build links,
   and the firmware dies at the first request on an undefined symbol) */
extern "C" {
int16_t bridge_u2f_to_solo(uint8_t *_appid, uint8_t *output, uint8_t *keyh, int keylen);
int is_extension_request(uint8_t *kh, int len);
}
/* C++ linkage, as fido2/extensions.cpp defines them and ctap.cpp declares them: no header gives them C linkage, and a
   compiler that decorates C++ variable names (MSVC) links a C-linkage declaration to a symbol that does not exist */
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

/*
 * THE USB STACK'S STATE, ON A DEBUG HARD KEY (Brad's connection bug, 2026-11-04: after a lockout restart and an unlock the
 * key said it sent its answer and the host heard nothing for 30-42 s). Every endpoint draws its packets from one pool of
 * NUM_USB_BUFFERS; a report written to an interface the sketch is not reading - the vendor interface while locked, the
 * console on a key not reading it - keeps one, and a send with none free gives up (vb_send: 5 x 100 ms, then dropped).
 * Measured on blue-key that evening: the pool was not it - the lost answer's send found 18 of 30 free, nothing queued,
 * nothing dropped, and the host still heard nothing until its next write. So now the endpoint's own two hardware slots
 * (the Kinetis buffer descriptors, even and odd): the controller owns a slot (BDT_OWN, 0x80) until the host takes its
 * packet. Said after an answer and when the next request lands - an answer still owned then is one the key is holding.
 * The descriptor table is private to usb_dev.c; its address is in the USB0_BDTPAGE registers. Never on the emulator.
 */
#if defined(DEBUG) && !defined(OK_EMULATOR)
#include "usb_dev.h"
/* [marker, vendor tx queued, even slot's descriptor byte, odd slot's] - one hex line (the hex sits within bytes of 0x39800) */
static void vb_slots(uint8_t marker) {
  volatile uint32_t *bdt = (volatile uint32_t *)((USB0_BDTPAGE1 << 8) | (USB0_BDTPAGE2 << 16) | (USB0_BDTPAGE3 << 24));
  uint8_t line[4] = {marker, (uint8_t)usb_tx_packet_count(RAWHID_TX_ENDPOINT2),
    (uint8_t)bdt[((RAWHID_TX_ENDPOINT2 << 2) | 2) * 2], (uint8_t)bdt[((RAWHID_TX_ENDPOINT2 << 2) | 3) * 2]};
  byteprint(line, 4);
}
#endif

static void vb_send(const uint8_t *data, int len) {
  uint8_t r[64];
  int at = 0;
#if defined(DEBUG) && !defined(OK_EMULATOR)
  uint8_t dropped = 0; /* reports given up after their fifth try */
#endif
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
    int tries = 0;
    for (; tries < 5; tries++) {
      if (RawHID.send2(r, 100)) break;
    }
#if defined(DEBUG) && !defined(OK_EMULATOR)
    if (tries == 5) dropped++;
#else
    (void)tries;
#endif
    if (at >= len) break;
  }
  memset(r, 0, sizeof(r));
#if defined(DEBUG) && !defined(OK_EMULATOR)
  /* one hex line after the answer, marked BB (no text: the hex sits within bytes of 0x39800): [BB, free buffers, vendor tx
     queued, reports DROPPED] */
  if (dropped) { uint8_t d[2] = {0xBD, dropped}; byteprint(d, 2); } /* BD n: n reports dropped */
  vb_slots(0xBB); /* BB: after the answer */
#endif
}

/*
 * No lock check here: the sketch reads the vendor interface only while unlocked (OnlyKey.ino recvmsg), so a locked key
 * never gets this far - the kit's first test. Leaving it out keeps the DEBUG test hex under the Edge region (0x39800) - as do the short refusals.
 */
void okplugin_vendor_bridge_recv(uint8_t *buffer) {
  uint8_t index = buffer[5] & 0x7f;
  uint8_t last = buffer[5] & 0x80;
#if defined(DEBUG) && !defined(OK_EMULATOR)
  if (index == 0) vb_slots(0xBA); /* BA: a request lands - the last answer's slots now */
#endif
  if (index == 0) vb_reset();
  if (index != req_next || req_have + VB_IN > (int)sizeof(req)) {
    vb_reset();
    hidprint("VB order");
    return;
  }
  memcpy(req + req_have, buffer + 6, VB_IN);
  req_have += VB_IN;
  req_next++;
  if (!last) return;

  int keylen = req[0] | (req[1] << 8);
  if (keylen <= 0 || 2 + keylen > req_have || keylen > 256 || !is_extension_request(req + 2, keylen)) {
    vb_reset();
    hidprint("VB req");
    return;
  }
  /* the key's own rpId: ctap_bridge's site */
  uint8_t rpid_hash[32];
  if (!okplugin_ctap_bridge_site_hash(rpid_hash)) {
    vb_reset();
    hidprint("VB site");
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
