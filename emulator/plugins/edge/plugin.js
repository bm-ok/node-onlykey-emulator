'use strict';
/*
 * edge - OnlyKey Edge: budgets opened at a press, each budget use linked in the key's hash
 * chain, receipts owed per use, checkpoints signed over the chain. The hooks below wire it
 * into the core firmware; each anchor occurs exactly once in the 3.1.0 tree, soft key and
 * desktop emulator alike:
 *   1 okcore.cpp  include the plugin header
 *   2 okcore.cpp  the vendor switch: case OKEDGE
 *   3 okcore.cpp  okcore_prime_user_confirmation(): what is waiting for a decision
 *   4 okcore.cpp  okcore_run_pending_op(): a refused request ends here; else APPROVE, before it runs
 *   5 okcore.cpp  fadeoffafter20sec(): TIMEOUT
 *   6 OnlyKey.ino include the plugin header
 *   7 OnlyKey.ino the wrong-challenge branch: DENY
 *   8 okcore.cpp  wipeflashdata(): the Edge state is wiped with the key
 *   9-11          OKEDGE over WebAuthn (solo.cpp, ok_extension.cpp) - see the hooks below
 */
module.exports = {
  name: 'edge',
  minBase: '3.1.0',
  notes: 'OKEDGE 0xF8: budgets at a press, each use linked in the key\'s chain (soft key; developer hard key via tools/build-hardkey.sh)',
  /* a section in the backup: seq, head, the owed uses and the device id (okplugin_edge_backup) */
  backup: true,
  hooks: [
    {
      file: 'okcore.cpp',
      anchor: '#include "onlykey.h"\n',
      insert: 'after',
      text: '#include "plugins/edge/okplugin_edge.h"\n',
    },
    {
      file: 'okcore.cpp',
      anchor: '            default:\n                if (profilemode != NONENCRYPTEDPROFILE && FTFL_FSEC == 0x44 && integrityctr1 == integrityctr2) {\n',
      insert: 'before',
      text: '            case OKEDGE:\n                okplugin_edge_recv(recv_buffer);\n                return;\n',
    },
    {
      file: 'okcore.cpp',
      anchor: '    user_input_mode = okcore_user_input_mode_for_slot(slot);\n',
      insert: 'after',
      text: '    okplugin_edge_primed(opcode, slot, msg, msg_len);\n',
    },
    {
      file: 'okcore.cpp',
      anchor: 'void okcore_run_pending_op() {\n',
      insert: 'after',
      /* a refused request ends here: nothing runs, no link, the red fade */
      text: '    if (okplugin_edge_refused()) {\n        CRYPTO_AUTH = 0;\n        user_input_mode = USER_INPUT_CHALLENGE;\n        pending_op_no_press = 0;\n        pending_operation = 0;\n        packet_buffer_details[0] = 0;\n        fadeoff(1);\n        return;\n    }\n    okplugin_edge_decision(OKEDGE_DECISION_APPROVE);\n',
    },
    {
      file: 'okcore.cpp',
      anchor: '            hidprint("Timeout occured while waiting for confirmation on OnlyKey");\n',
      insert: 'before',
      text: '            okplugin_edge_decision(OKEDGE_DECISION_TIMEOUT);\n',
    },
    {
      file: 'sketch/OnlyKey.ino',
      anchor: '#include "onlykey.h"\n',
      insert: 'after',
      text: '#include "plugins/edge/okplugin_edge.h"\n',
    },
    {
      file: 'sketch/OnlyKey.ino',
      anchor: '        } else if (CRYPTO_AUTH) { //Wrong challenge was entered\n',
      insert: 'after',
      text: '            okplugin_edge_decision(OKEDGE_DECISION_DENY);\n',
    },
    {
      file: 'okcore.cpp',
      anchor: 'void wipeflashdata() {\n',
      insert: 'after',
      text: '    okplugin_edge_wipe();\n',
    },
    /*
     * OVER WEBAUTHN (Brad, 2026-10-28: Edge needs a WebAuthn path, so the web app can be the key's host for agents).
     * A browser reaches the key only through WebAuthn; these three carry OKEDGE there, behind ctap_bridge's switch
     * (its okplugin_ctap_bridge_allows() admits OKEDGE while it is on), the way derive_secret carries OKDERIVESECRET:
     *   9 solo.cpp          forward OKEDGE to the extension (solo.cpp does not include onlykey.h: the wire value)
     *  10 ok_extension.cpp  include the plugin header
     *  11 ok_extension.cpp  the transit dispatch: one OKEDGE request whole, before the 57-byte chunk loop - Edge reads
     *                       its arguments from [6] and GRANT_CREATE uses all 58 bytes
     * All three are `with: 'ctap_bridge'` (cli/firmware-plugins.js): the switch's gate is a ctap_bridge hook, so a build
     * without the bridge leaves them out and edge is the USB-only plugin it was.
     */
    { file: 'libraries/fido2/solo.cpp', anchor: '        case OKSIGN:\n', insert: 'after', text: '        case (TYPE_INIT | 0x78): /* OKEDGE, plugin edge */\n', with: 'ctap_bridge' },
    { file: 'libraries/fido2/ok_extension.cpp', anchor: '#include "onlykey.h"\n', insert: 'after', text: '#include "plugins/edge/okplugin_edge.h"\n', with: 'ctap_bridge' },
    {
      with: 'ctap_bridge',
      file: 'libraries/fido2/ok_extension.cpp',
      anchor: '                while (handle_len > 0) { // Max size packet minus header\n',
      insert: 'before',
      text: '                if (cmd == OKEDGE) {\n'
        + '                    okplugin_edge_ctap(client_handle, handle_len, opt1);\n'
        + '                    handle_len = 0;\n'
        + '                }\n',
    },
    /*
     *  12-13 ok_extension.cpp  THE DERIVE GATE ASKS EDGE FIRST (PROPOSAL-login-plan.md, the login budget; Brad,
     *                       2026-10-29: "we can change the RFC"): a request the gate would put to field 30 (floor
     *                       NONE - never a touch derive) is handed to okplugin_edge_pay_derive, which answers 1 only
     *                       for a touchless derive_secret its TX start announced and a live DERIVE scope pays - then
     *                       the gate lets it run with no press, and the use is a link. Not `with: 'ctap_bridge'`: the
     *                       gate serves every host (a browser, the CLI over CTAPHID), and the login plan works local
     *                       only. The function is declared here, so no header include depends on the bridge.
     */
    {
      file: 'libraries/fido2/ok_extension.cpp',
      anchor: 'static int web_agent_derive_gate(uint8_t floor_mode, const uint8_t *data, int len) {\n',
      insert: 'before',
      text: 'int okplugin_edge_pay_derive(const uint8_t *payload, int len); /* plugin edge */\n',
    },
    {
      file: 'libraries/fido2/ok_extension.cpp',
      anchor: '    uint8_t need = okcore_web_agent_derive_mode();\n',
      insert: 'after',
      text: '    if (floor_mode == USER_INPUT_NONE && okplugin_edge_pay_derive(data, len)) return 0; /* plugin edge: a budget pays it */\n',
    },
  ],
};
