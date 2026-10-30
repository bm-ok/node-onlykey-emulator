/*
 * edge - the firmware half of OnlyKey Edge. The key records each budget use in a hash
 * chain, opens budgets only at a physical press, signs checkpoints over its chain with a
 * key no other request reaches, and keeps the receipts its uses owe. The host library
 * (node-onlykey-lib/edge) builds the requests and stores and verifies the chain.
 */
#ifndef OKPLUGIN_EDGE_H
#define OKPLUGIN_EDGE_H

#include <stdint.h>
#include <stddef.h>

/* the vendor message, 0xF8 on the wire */
#define OKEDGE (TYPE_INIT | 0x78)

/* OKEDGE sub-ops (recv_buffer[5]) */
#define OKEDGE_HEAD 0x01
#define OKEDGE_PICKUP 0x02
/* 0x03 is unassigned: the key confirms a head only after a host proves it (OKEDGE_PROVE_HEAD) */
#define OKEDGE_PUBKEY 0x04        /* {which: 0 checkpoint key, 1 owner key}, no press: a P-256 public key X || Y */
#define OKEDGE_PUBKEY_PQ 0x05     /* {which: 0 checkpoint key, 1 owner key}, no press: an ML-DSA-65 public key */
/* 0x06 is unassigned: the owner key signs only through OKEDGE_CERTIFY */
#define OKEDGE_MORE 0x07          /* over WebAuthn only, no press: the ML-DSA-65 signature the last answer left out */
#define OKEDGE_CERTIFY 0x08       /* {subject 32}: a press, or a budget's CERTIFY scope after its TX start - a link, then the owner key signs the subject */
#define OKEDGE_PROVE_HEAD 0x09    /* {seq u32, head 32}, no press, no link: the host's head matches the key's - then the confirmation (both checkpoint signatures) */
/* HEAD byte 59: what this firmware does - hosts send the newer requests only when the bit is set */
#define OKEDGE_CAPS_CERTIFY_HEADPROOF 0x01 /* CERTIFY, PUBKEY {which}, PROVE_HEAD; the head is never revealed */
#define OKEDGE_GRANT_CREATE 0x10  /* a press: opens a budget */
#define OKEDGE_GRANT_LABEL 0x11   /* {scope index, label 32}, no press: a derived identity's label for the next GRANT_CREATE */
#define OKEDGE_GRANT_REVOKE 0x12  /* no press: ends a live budget */
#define OKEDGE_GRANT_HOLD 0x13    /* no press: a live budget pays for nothing until resumed */
#define OKEDGE_GRANT_RESUME 0x14  /* a press: a held budget pays again */
#define OKEDGE_RECEIPT 0x20       /* replies seq . head; the last open use of a budget ends it (completed) */
#define OKEDGE_SETTLE 0x21        /* a press: ends every live budget, then clears the owed receipt; replies seq . head */
#define OKEDGE_TX_START 0x22      /* {token 32, intent 16}: starts one budget self-press */
#define OKEDGE_LOSS 0x34          /* {from, to}, a press: records a range of links as lost */
#define OKEDGE_WIPE_DEBUG 0x7E    /* DEBUG builds only: erases the Edge state; no key outside it is touched */
/* 0x15 is not handled: it answers EDGE_UNKNOWN_REQUEST like any unknown sub-op */

/* byte 63 of every link this firmware writes */
#define OKEDGE_LINK_VERSION 1

/* Text replies are "EDGE:xx" - two hex digits; the host library turns each into words. */
#define EDGE_OK 0x00
#define EDGE_NEED_PIN 0x01           /* no K132 yet: set a PIN first */
#define EDGE_BAD_SCOPES 0x02         /* a budget has 1 to 4 scopes */
#define EDGE_SCOPE_NOT_ALLOWED 0x03  /* an op/slot a budget may not pay for, or a derived code without its label */
#define EDGE_TOO_MANY_USES 0x04      /* more than 1024 uses */
#define EDGE_LIVE_FULL 0x05          /* 4 budgets already live */
#define EDGE_SIGN_FAILED 0x06        /* the Edge key could not sign */
#define EDGE_NO_SUCH_BUDGET 0x07     /* no live budget with that id */
#define EDGE_NO_RECEIPT_WAITING 0x08 /* receipt: that use owes nothing; settle: nothing owed */
#define EDGE_NOT_HELD 0x09           /* pickup: that link is no longer held */
#define EDGE_UNKNOWN_REQUEST 0x0A
#define EDGE_STALE_HEAD 0x0B         /* the head the host verified is not the key's head */
#define EDGE_RECEIPT_OWED 0x0C       /* a receipt is owed: no TX start, GRANT_CREATE or GRANT_RESUME */
#define EDGE_NOTHING_TO_PAY 0x0D     /* no live budget off hold with uses left */
#define EDGE_BAD_RANGE 0x12          /* LOSS: from > to, or to past the key's head */
#define EDGE_TX_MISMATCH 0x1C        /* the sign is not the request its TX start was for: refused, the TX start is spent */

/* decisions, numbered as the host library's codes.js */
#define OKEDGE_DECISION_APPROVE 1
#define OKEDGE_DECISION_DENY 2
#define OKEDGE_DECISION_TIMEOUT 3

/* recvmsg(): an OKEDGE message */
void okplugin_edge_recv(uint8_t *buffer);
/* the WebAuthn transit dispatch: an OKEDGE message, its sub-op and argument bytes */
void okplugin_edge_ctap(const uint8_t *data, int len, uint8_t sub);
/* okcore_prime_user_confirmation(): an operation is waiting for its decision */
void okplugin_edge_primed(uint8_t opcode, uint8_t slot, const uint8_t *msg, size_t msg_len);
/* the decision points: the press (approve), a wrong challenge (deny), the 20 s fade (timeout) */
void okplugin_edge_decision(int decision);
/* before a primed sign/decrypt runs: 1 = refused (no press, no link) */
int okplugin_edge_refused(void);
/* wipeflashdata(): the key is being wiped */
void okplugin_edge_wipe(void);
/* the plugin backup section (version 1): seq, head, the owed use if any, and the device id */
int okplugin_edge_backup(uint8_t *out, int max);
void okplugin_edge_restore(const uint8_t *in, int len);

#endif
