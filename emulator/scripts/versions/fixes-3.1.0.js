'use strict';

/**
 * The fixes found testing the 3.1.0 release candidate that its pinned libraries (fe9e293) do NOT carry yet, as
 * staged edits. With them the soft key runs the same firmware as a developer hard key built by
 * plugins/edge/tools/build-hardkey.sh (it `git am`s the same patch files on fe9e293), so a difference between the two
 * is never the base.
 *
 *   0012  okcore: the 20 s user timer stops when a request is decided, so it cannot answer "Timeout" for the next one
 *         (was the emulator plugin fix_usertimeout until 2026-10-26; sent to the maintainer 2026-10-26)
 *   0013  okcore: wiping an RSA slot clears its key type, so the wiped slot reads as empty (sent 2026-10-26)
 *   0017  fido2: a tunnel connect clears the duplicate mark of a request cut off before its final packet, so a new
 *         page's requests are not dropped as duplicates (2026-11-02; not sent)
 *   0018  okcore: a second-profile PIN added in config mode records the two-profile mode, so the primary profile's key
 *         is unwrapped with the secret it was wrapped with - before it, the primary PIN still unlocked and every slot
 *         and derived key read as something else (2026-11-03; not sent)
 *
 * SKIPPED (a SKIPPED file in its folder, beside its HOLD: the maintainer declined it - kept, never staged, never
 * proposed again):
 *   0014  okcrypto: clamp X25519 scalars (RFC 7748) - declined 2026-10-29: "We aren't going to change this as it
 *         changes peoples keys"
 *
 * GONE WITH THE RE-PIN to the maintainer's ok-80e3ba0-fe9e293 (2026-10-26) - upstream carries them, so they are no
 * longer staged; their patches and READMEs stay in this repository's history:
 *   0008  fido2: a repeated poll is served the same chunk again           - in fe9e293 as written
 *   0009  fido2: the version status after the transit key is bounded      - in fe9e293 as written
 *   0010  okcore: the nonce check sums the bytes it read, not always 32    - in fe9e293 as written
 *   0011  okcore: a composite PQC PGP key is backed up as its 160-byte blob - in fe9e293 in the maintainer's own form
 *
 * GENERATED below `module.exports` from the patch files in patches-3.1.0/ beside this file (each with its README -
 * the patch as the maintainer gets it) by gen-fixes.js: change or add the patch, then `node gen-fixes.js 3.1.0`
 * (`--check`: does this still match; `--verify <libraries checkout>`: every find string occurs once at fe9e293).
 *
 * Applied by v3.1.0.js as the version_control plugin's version.json lists them (byName); a build without that plugin
 * is the RC exactly as published - no patches (the compatibility matrix).
 * build.json records which, as `fixes`.
 */
module.exports = {
  names: ["0012", "0013", "0015", "0017", "0018"],
  experimental: ["0016"],
  held: ["0014"],
  byName: {
    "0012": [
      /* 0012-okcore-stop-the-20-s-user-timer-when-a-request-is-decided.patch */
      {
        file: "libraries/onlykey/okcore.cpp",
        edits: [
          ["// Runs the operation staged by done_process_packets(). CRYPTO_AUTH must\n// already be 4.\nvoid okcore_run_pending_op() {\n    derived_key_challenge_mode = 0;\n    stored_key_challenge_mode = 0;\n    if (packet_buffer_details[0] == OKSIGN) {\n",
           "// Runs the operation staged by done_process_packets(). CRYPTO_AUTH must\n// already be 4.\nvoid okcore_run_pending_op() {\n    cancelfadeoffafter20(); /* the request is decided: its 20 s wait for the user is over */\n    derived_key_challenge_mode = 0;\n    stored_key_challenge_mode = 0;\n    if (packet_buffer_details[0] == OKSIGN) {\n"],
        ],
      },
    ],
    "0013": [
      /* 0013-okcore-wiping-an-RSA-slot-clears-its-key-type.patch */
      {
        file: "libraries/onlykey/okcore.cpp",
        edits: [
          ["        flash_modify(buffer[5], temp, buffer, MAX_RSA_KEY_SIZE, 1);\n        //Write buffer to flash\n        okcore_flashset_common(tptr, (unsigned long *)adr, 2048);\n        hidprint(\"Successfully wiped RSA Private Key\");\n        blink(2);\n        return;\n",
           "        flash_modify(buffer[5], temp, buffer, MAX_RSA_KEY_SIZE, 1);\n        //Write buffer to flash\n        okcore_flashset_common(tptr, (unsigned long *)adr, 2048);\n        /* The key is gone, so clear its type as well, as an ECC wipe does\n         * (ecc_priv_flash stores the zeroed type byte). Left set, the slot\n         * still reads as an RSA key: okcore_flashget_RSA decrypts the zeroed\n         * flash into keystream and rsa_getpub answers its product. */\n        uint8_t no_key = 0;\n        okeeprom_eeset_rsakey(&no_key, (int)buffer[5]);\n        hidprint(\"Successfully wiped RSA Private Key\");\n        blink(2);\n        return;\n"],
        ],
      },
    ],
    "0015": [
      /* 0015-fido2-a-getAssertion-with-up-false-does-not-run-the-extension-request.patch */
      {
        file: "libraries/fido2/ctap.cpp",
        edits: [
          ["    }\n}\n\n// adds 2 to map, or 3 if add_user is true\nuint8_t ctap_end_get_assertion(CborEncoder *map, CTAP_credentialDescriptor *cred, uint8_t *auth_data_buf, unsigned int auth_data_buf_sz, uint8_t *clientDataHash) {\n    int ret;\n",
           "    }\n}\n\n#ifdef ENABLE_U2F_EXTENSIONS\n// True while an extension request is answered for a getAssertion with up\n// false. Such a request only asks whether the credential is known, so the\n// extension is not run: it runs once, for the request with user presence.\nstatic bool extension_silent = false;\n#endif\n\n// adds 2 to map, or 3 if add_user is true\nuint8_t ctap_end_get_assertion(CborEncoder *map, CTAP_credentialDescriptor *cred, uint8_t *auth_data_buf, unsigned int auth_data_buf_sz, uint8_t *clientDataHash) {\n    int ret;\n"],
          ["    // An extension op that writes back less than it claims (or nothing) must\n    // not return stack contents: the fallback below sends 72 bytes.\n    memset(sigder, 0, sizeof(sigder));\n    if (extend_fido2(&cred->credential.id, &cred->type, sigder)) {\n        // sigder[0] is the status byte; output_buffer_offset payload bytes follow,\n        // or none when output_buffer_size is 0.\n        extern uint16_t output_buffer_offset;\n",
           "    // An extension op that writes back less than it claims (or nothing) must\n    // not return stack contents: the fallback below sends 72 bytes.\n    memset(sigder, 0, sizeof(sigder));\n    if (!extension_silent && extend_fido2(&cred->credential.id, &cred->type, sigder)) {\n        // sigder[0] is the status byte; output_buffer_offset payload bytes follow,\n        // or none when output_buffer_size is 0.\n        extern uint16_t output_buffer_offset;\n"],
          ["        crypto_sha256_update(GA.rp.id, GA.rp.size);\n        crypto_sha256_final(getAssertionState.buf.authData.rpIdHash);\n\n        getAssertionState.buf.authData.flags = (1 << 0);\n        getAssertionState.buf.authData.flags |= (1 << 2);\n    } else\n#endif\n",
           "        crypto_sha256_update(GA.rp.id, GA.rp.size);\n        crypto_sha256_final(getAssertionState.buf.authData.rpIdHash);\n\n        // up false: the request only checks that the credential is known. It\n        // is answered with a plain assertion, without the user-present flag\n        // and without running the extension (ctap_end_get_assertion).\n        extension_silent = (GA.up == 0);\n        getAssertionState.buf.authData.flags = extension_silent ? 0 : (1 << 0);\n        getAssertionState.buf.authData.flags |= (1 << 2);\n    } else\n#endif\n"],
          ["    }\n\n    ret = ctap_end_get_assertion(&map, cred, (uint8_t *)&getAssertionState.buf, auth_data_buf_sz, GA.clientDataHash); // 1,2,3,4\n    check_retr(ret);\n\n    if (validCredCount > 1) {\n",
           "    }\n\n    ret = ctap_end_get_assertion(&map, cred, (uint8_t *)&getAssertionState.buf, auth_data_buf_sz, GA.clientDataHash); // 1,2,3,4\n#ifdef ENABLE_U2F_EXTENSIONS\n    extension_silent = false;\n#endif\n    check_retr(ret);\n\n    if (validCredCount > 1) {\n"],
        ],
      },
    ],
    "0016": [
      /* 0016-fido2-a-new-request-wipes-a-reply-already-delivered.patch */
      {
        file: "libraries/fido2/ok_extension.cpp",
        edits: [
          ["                    return 0;\n                }\n            }\n#ifdef DEBUG\n            Serial.println(\"Decrypted client handle\");\n            byteprint(client_handle, handle_len);\n",
           "                    return 0;\n                }\n            }\n            // A new request after the last reply was delivered whole: that\n            // reply is wiped now, not when the Wipedata timer fires, so this\n            // request is not answered with it. A repeated packet returned\n            // above and is still answered from the stored reply.\n            if (cmd != OKPING && pending_operation == CTAP2_ERR_DATA_WIPE &&\n                large_resp_buffer_offset && large_resp_buffer_cursor >= large_resp_buffer_offset) {\n                wipedata_now();\n            }\n#ifdef DEBUG\n            Serial.println(\"Decrypted client handle\");\n            byteprint(client_handle, handle_len);\n"],
        ],
      },
      /* 0016-fido2-a-new-request-wipes-a-reply-already-delivered.patch */
      {
        file: "libraries/onlykey/okcore.cpp",
        edits: [
          ["    // This is for staging large response via keyboard, not currently used\n    //if (store_keyboard_response()) return;\n\n    if (!n) {\n        n = RawHID.recv(recv_buffer, 0); // 0 timeout = do not wait\n        if (outputmode != RAW_USB && n) changeoutputmode(RAW_USB); //USB\n    }\n\n    //Integrity Check\n",
           "    // This is for staging large response via keyboard, not currently used\n    //if (store_keyboard_response()) return;\n\n    int from_rawhid = 0;\n    if (!n) {\n        n = RawHID.recv(recv_buffer, 0); // 0 timeout = do not wait\n        if (outputmode != RAW_USB && n) changeoutputmode(RAW_USB); //USB\n        from_rawhid = n > 0;\n    }\n\n    //Integrity Check\n"],
          ["        Serial.print(F(\"\\n\\nReceived packet\"));\n        byteprint(recv_buffer, 64);\n#endif\n\n        if (configmode == true && recv_buffer[4] != OKCONNECT && recv_buffer[4] != OKWIPESLOT && recv_buffer[4] != OKSETSLOT && recv_buffer[4] != OKSETPRIV && recv_buffer[4] != OKRESTORE && recv_buffer[4] != OKFWUPDATE && recv_buffer[4] != OKWIPEPRIV && recv_buffer[4] != OKGETLABELS && recv_buffer[4] != OKPIN && recv_buffer[4] != OKPINSEC && recv_buffer[4] != OKPINSD) {\n#ifdef DEBUG\n",
           "        Serial.print(F(\"\\n\\nReceived packet\"));\n        byteprint(recv_buffer, 64);\n#endif\n        // A request on the raw HID interface after the last WebAuthn reply\n        // was delivered whole: that reply is wiped now, not when the Wipedata\n        // timer fires. While it is held the main loop drops every sensed\n        // press, so a press this request waits for would be lost. A request\n        // that came through WebAuthn was handled in bridge_to_onlykey().\n        if (from_rawhid && pending_operation == CTAP2_ERR_DATA_WIPE &&\n            large_resp_buffer_offset && large_resp_buffer_cursor >= large_resp_buffer_offset) {\n            wipedata_now();\n        }\n\n        if (configmode == true && recv_buffer[4] != OKCONNECT && recv_buffer[4] != OKWIPESLOT && recv_buffer[4] != OKSETSLOT && recv_buffer[4] != OKSETPRIV && recv_buffer[4] != OKRESTORE && recv_buffer[4] != OKFWUPDATE && recv_buffer[4] != OKWIPEPRIV && recv_buffer[4] != OKGETLABELS && recv_buffer[4] != OKPIN && recv_buffer[4] != OKPINSEC && recv_buffer[4] != OKPINSD) {\n#ifdef DEBUG\n"],
          ["    fadeoff(0);\n}\n\nvoid wipetasks() {\n    packet_buffer_offset = 0;\n    memset(rsa_private_key, 0, MAX_RSA_KEY_SIZE);\n",
           "    fadeoff(0);\n}\n\n/* Set by wipedata_now(): the request being handled is in ctap_buffer. */\nstatic int wipe_keeps_request = 0;\n\nvoid wipetasks() {\n    packet_buffer_offset = 0;\n    memset(rsa_private_key, 0, MAX_RSA_KEY_SIZE);\n"],
          ["     * and the start of the message zeroed, so the request failed with\n     * CTAP1_ERR_INVALID_COMMAND. A stalled message is still dropped by\n     * ctaphid_check_timeouts(), and everything else is wiped as before. */\n    if (!ctaphid_buffering()) memset(ctap_buffer, 0, CTAPHID_BUFFER_SIZE);\n    memset(large_resp_buffer, 0, LARGE_RESP_BUFFER_SIZE);\n    memset(keyboard_buffer, 0, KEYBOARD_BUFFER_SIZE);\n    memset(packet_buffer_details, 0, sizeof(packet_buffer_details));\n",
           "     * and the start of the message zeroed, so the request failed with\n     * CTAP1_ERR_INVALID_COMMAND. A stalled message is still dropped by\n     * ctaphid_check_timeouts(), and everything else is wiped as before. */\n    if (!ctaphid_buffering() && !wipe_keeps_request) memset(ctap_buffer, 0, CTAPHID_BUFFER_SIZE);\n    memset(large_resp_buffer, 0, LARGE_RESP_BUFFER_SIZE);\n    memset(keyboard_buffer, 0, KEYBOARD_BUFFER_SIZE);\n    memset(packet_buffer_details, 0, sizeof(packet_buffer_details));\n"],
          ["    packet_buffer_details[1] = 0;\n}\n\nvoid fadeoffafter20() {\n    Usertimeout.startDelayed();\n}\n",
           "    packet_buffer_details[1] = 0;\n}\n\n/* Stop the Wipedata timer and wipe now what it would wipe. Called while a\n * request is handled: that request's CTAP message in ctap_buffer is kept. */\nvoid wipedata_now() {\n    SoftTimer.remove(&Wipedata);\n    if (configmode) return;\n    wipe_keeps_request = 1;\n    wipetasks();\n    wipe_keeps_request = 0;\n}\n\nvoid fadeoffafter20() {\n    Usertimeout.startDelayed();\n}\n"],
        ],
      },
      /* 0016-fido2-a-new-request-wipes-a-reply-already-delivered.patch */
      {
        file: "libraries/onlykey/okcore.h",
        edits: [
          ["extern bool fadeendafter2sec(Task *me);\nextern void typeoutbackup(Task *me);\nextern void wipedata();\nextern void wipetasks();\nextern void fadeoffafter20();\nextern void cancelfadeoffafter20();\n",
           "extern bool fadeendafter2sec(Task *me);\nextern void typeoutbackup(Task *me);\nextern void wipedata();\nextern void wipedata_now();\nextern void wipetasks();\nextern void fadeoffafter20();\nextern void cancelfadeoffafter20();\n"],
        ],
      },
    ],
    "0017": [
      /* 0017-fido2-a-tunnel-connect-clears-the-duplicate-mark-of-an-unfinished-request.patch */
      {
        file: "libraries/fido2/ok_extension.cpp",
        edits: [
          ["        outputmode = DISCARD; // Discard output\n        if (cmd == OKCONNECT && !CRYPTO_AUTH) {\n            large_buffer_offset = 0;\n            // Set time if not already set\n            set_time(client_handle);\n            memset(ecc_public_key, 0, sizeof(ecc_public_key));\n",
           "        outputmode = DISCARD; // Discard output\n        if (cmd == OKCONNECT && !CRYPTO_AUTH) {\n            large_buffer_offset = 0;\n            // Every OKCONNECT makes a new transit key below, so no packet sealed\n            // before it continues a request: the duplicate mark of a request that\n            // never reached its final packet is cleared with it.\n            last_request_opt3 = 0;\n            // Set time if not already set\n            set_time(client_handle);\n            memset(ecc_public_key, 0, sizeof(ecc_public_key));\n"],
        ],
      },
    ],
    "0018": [
      /* 0018-okcore-a-second-PIN-added-in-config-mode-keeps-the-profile-key-readable.patch */
      {
        file: "libraries/onlykey/okcore.cpp",
        edits: [
          ["    okeeprom_eeget_2ndprofilemode(&p2mode);\n    if (p2mode != NONENCRYPTEDPROFILE) { //profile key not used for plausible deniability mode or international fw\n#ifdef STD_VERSION\n        if (!initcheck) {\n            // Default to standard profile\n            p2mode = STDPROFILE2;\n            okeeprom_eeset_2ndprofilemode(&p2mode);\n",
           "    okeeprom_eeget_2ndprofilemode(&p2mode);\n    if (p2mode != NONENCRYPTEDPROFILE) { //profile key not used for plausible deniability mode or international fw\n#ifdef STD_VERSION\n        // The profile key is wrapped below under the shared secret of the two\n        // PINs, and an unlock unwraps it with that secret only when the mode\n        // is STDPROFILE2 (password.cpp). Record the mode whenever a second PIN\n        // is set, not only at first setup, so a second PIN added in config\n        // mode is unwrapped with the secret it was wrapped with.\n        if (p2mode != STDPROFILE2) {\n            // Default to standard profile\n            p2mode = STDPROFILE2;\n            okeeprom_eeset_2ndprofilemode(&p2mode);\n"],
        ],
      },
    ],
  },
};
