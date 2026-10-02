/*
 * okplugin_hello - see okplugin_hello.h and ../../AUDIT.md.
 *
 * Answers only an unlocked key outside config mode, like the firmware's own
 * handlers: a locked key answers no vendor request at all, and config mode is
 * for writes. It reads no secret and writes nothing.
 */
#include "onlykey.h"
#include "okplugin_hello.h"

void okplugin_hello_recv(uint8_t *buffer) {
  (void)buffer;
  if (initialized == true && unlocked == true && configmode == false) {
    hidprint("HELLO from plugin hello");
  }
}
