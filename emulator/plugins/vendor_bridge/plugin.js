'use strict';
/*
 * vendor_bridge - the WebAuthn tunnel's requests over the vendor HID interface (Brad, 2026-10-31: "i need to use vendor
 * api instead of ctap for desktop, so i need to bridge the vendor api to use ctap"; "yes vendor bridge plugin").
 *
 * The derives, the transit key and the derived-key signs are read only on the CTAP path (ok_extension.cpp
 * bridge_to_onlykey); over CTAP a host learns little - on Windows the desktop app reaches CTAP only through Windows'
 * own WebAuthn. This plugin takes the very bytes the tunnel puts in a getAssertion's credential ID, over the vendor
 * interface, hands them to the same entry the CTAP2 path calls, and sends back [status][output] as vendor reports - so
 * a desktop host talks vendor only, and sees the key's own answers. The CTAP path is untouched; the web app keeps it.
 */
const INC = '#include "plugins/vendor_bridge/okplugin_vendor_bridge.h"\n';
module.exports = {
  name: 'vendor_bridge',
  minBase: '3.1.0',
  notes: 'the WebAuthn tunnel over the vendor interface: OKVENDORBRIDGE 0x7D carries a credential ID, answers [status][output]',
  /* no storage: nothing to move or leave behind */
  stateless: true,
  /* its rpId is ctap_bridge's configurable site (okplugin_ctap_bridge_site_hash) - Brad: "the rpid set in the plugin that is configurable" */
  requires: ['ctap_bridge'],
  hooks: [
    { file: 'okcore.cpp', anchor: '#include "onlykey.h"\n', insert: 'after', text: INC },
    {
      /* the vendor switch's own default (okcore.cpp recvmsg) */
      file: 'okcore.cpp',
      anchor: '            default:\n                if (profilemode != NONENCRYPTEDPROFILE && FTFL_FSEC == 0x44 && integrityctr1 == integrityctr2) {\n',
      insert: 'before',
      text: '            case OKVENDORBRIDGE:\n                okplugin_vendor_bridge_recv(recv_buffer);\n                return;\n',
    },
  ],
};
