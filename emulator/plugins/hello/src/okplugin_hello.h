/*
 * okplugin_hello - soft-key firmware plugin (ok-rn/android/okemu/plugins/hello).
 * One vendor message, answered with a fixed sentence. See ../../AUDIT.md.
 */
#ifndef OKPLUGIN_HELLO_H
#define OKPLUGIN_HELLO_H

#include <stdint.h>

#define OK_PLUGIN_HELLO 1
/* 0x7E: the vendor message ids in use end at 0x76 (OKWEBAUTHN); Edge's spec takes 0x78. */
#define OKHELLO (TYPE_INIT | 0x7E)

void okplugin_hello_recv(uint8_t *buffer);

#endif
