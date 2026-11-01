# vendor_bridge - audit

**What it is for:** the WebAuthn tunnel - the transit key, the derives, the composite halves, the derived-key signs,
and OKPING's poll for a result - is read only on the CTAP path (`fido2/ok_extension.cpp bridge_to_onlykey`). A desktop
app has the vendor HID interface, but on Windows it reaches CTAP only through Windows' own WebAuthn, and over CTAP it
learns little of what the key did. This plugin carries the tunnel's request bytes over the vendor interface instead, so
a desktop host talks vendor only and gets the key's own answers (Brad, 2026-10-31: "i need to use vendor api instead
of ctap for desktop, so i need to bridge the vendor api to use ctap"). Development and testing, beside ctap_bridge;
removed before release with it.

**Requires ctap_bridge:** the rpId it acts as is ctap_bridge's configurable site (`okplugin_ctap_bridge_site_hash`) -
what is set in config mode, its built-in default while unset. A host never names an rpId (Brad: "we should use the
rpid set in the plugin that is configurable"). The builder refuses a build that has vendor_bridge without ctap_bridge.

## Hooks

| File | Where | What |
|---|---|---|
| okcore.cpp | after `#include "onlykey.h"` | the plugin header |
| okcore.cpp | before the vendor switch's `default:` | `case OKVENDORBRIDGE` (0x7D, 0xFD on the wire) |

## What it does

- Takes, over one or more vendor reports (index | 0x80 on the last), `[length u16][credential ID]` - exactly the bytes
  the tunnel puts in a getAssertion's allowList.
- Refuses while locked, with no site set, out of order, or when the bytes are not an extension request
  (`is_extension_request`, the same test `extend_fido2` makes).
- Calls `bridge_u2f_to_solo(site hash, output + 1, credential ID, length)` and sets `output[0]` to its status - what
  `extend_fido2` does on CTAP2, with the site's SHA-256 handed in as the appid, as the U2F entry does. Every check of
  the tunnel applies unchanged: `webcryptcheck` (the site is trusted through ctap_bridge's own hook), the transit
  key's authentication, CRYPTO_AUTH, the press for sign/decrypt, ctap_bridge's agent-code rules.
- Sends `[status][output]` back as vendor reports with `RawHID.send2` - not `send_transport_response`: the tunnel's
  operations leave `outputmode` at WEBAUTHN, which stores a result that finishes after a press for the next OKPING to
  collect, as on CTAP2.

## What it does NOT do

- No new operation: only what the tunnel already accepts reaches the key, with the tunnel's own rules.
- No storage. Its buffers are zeroed after each request.
- The CTAP path is untouched; the web app keeps it.
