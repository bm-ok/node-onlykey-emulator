/*
 * ctap_bridge: key features over CTAP (the WebAuthn tunnel) for a browser host.
 *
 * - the agent derivation codes (public key 132/232, sign and decrypt 201-204 / 221-224) pass the
 *   tunnel's stored-key gate, and OKGETPUBKEY is dispatched for them;
 * - one extra allowed site: an rpId (up to 48 characters), set in config mode, readable by the report; while none is
 *   stored, CB_SITE_DEFAULT (okplugin_ctap_bridge.cpp); cleared, none;
 * - all of it behind one byte, read as ON while unset; turned off or on in config mode.
 *
 * OKGETPUBKEY over the tunnel: the first payload byte is the key type (the tunnel puts its last-packet length in
 * byte 6, where the vendor message carries the key type), then the 32-byte identity hash.
 *
 * OKCTAPBRIDGE (0xFB on the wire), buffer[5] = action:
 *   0 report: "ctap_bridge on|off site <rpId>|none"  (while unlocked)
 *   1 on, 2 off                                   (config mode)
 *   3 site: buffer[6] = length, buffer[7..] = rpId  (config mode)
 *   4 clear the site: no extra site, not the default (config mode)
 */
#ifndef OKPLUGIN_CTAP_BRIDGE_H
#define OKPLUGIN_CTAP_BRIDGE_H

#include <stdint.h>

#define OKCTAPBRIDGE (TYPE_INIT | 0x7B)

void okplugin_ctap_bridge_recv(uint8_t *buffer);
int okplugin_ctap_bridge_allows(uint8_t cmd, uint8_t code);
int okplugin_ctap_bridge_site(const uint8_t *appid);
/* the allowed site's SHA-256: 1, or 0 when none (vendor_bridge's rpId) */
int okplugin_ctap_bridge_site_hash(uint8_t hash[32]);
void okplugin_ctap_bridge_getpubkey(uint8_t *buffer);
/* the report over the WebAuthn tunnel, sealed: the same text as over USB (read only) */
void okplugin_ctap_bridge_report_sealed(void);

#endif
