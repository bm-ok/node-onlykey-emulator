/*
 * vendor_bridge: the WebAuthn tunnel's requests over the vendor HID interface, for a host that has it (a desktop app).
 *
 * The tunnel carries a request as the allowList credential ID of a CTAP2 getAssertion and its answer as the assertion's
 * signature: [status][data]. This message carries the same request bytes over the vendor interface and calls the same
 * entry the CTAP2 path calls (bridge_u2f_to_solo, as extend_fido2 does), so every operation of the tunnel - the transit
 * key, the derives, the composite halves, the derived-key signs, OKPING's poll for a result - works here unchanged, and
 * the answer comes back as vendor reports.
 *
 * OKVENDORBRIDGE (0xFD on the wire), while unlocked:
 *   request, one or more reports: buffer[5] = index (bits 0-6) | 0x80 on the last;
 *     buffer[6..63] = the next 58 bytes of: total length (u16 LE) . the credential ID
 *   the rpId is the key's own: ctap_bridge's configurable site (set in config mode; its default while unset) - a host
 *   never names one (Brad, 2026-10-31: "we should use the rpid set in the plugin that is configurable"). No site set:
 *   refused.
 *   answer, one or more reports: r[0] = 0xFD, r[1] = index (bits 0-6) | 0x80 on the last;
 *     the first carries the total length (u16 LE) in r[2..3] and data from r[4]; the rest data from r[2]
 *     data = [status][output] - the bytes a CTAP2 assertion's signature would hold
 *   refused (locked, no site, malformed, out of order): a text report, "Error vendor_bridge ...".
 */
#ifndef OKPLUGIN_VENDOR_BRIDGE_H
#define OKPLUGIN_VENDOR_BRIDGE_H

#include <stdint.h>

#define OKVENDORBRIDGE (TYPE_INIT | 0x7D)

void okplugin_vendor_bridge_recv(uint8_t *buffer);

#endif
