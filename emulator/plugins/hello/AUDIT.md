# hello: what it changes

The demo firmware plugin. It exists to prove the plugin mechanism (`node-onlykey-lib/cli/firmware-plugins`), not to do anything useful. It lives here in node-onlykey-emulator, so ok-rn's `okemu/plugins/` keeps only the plugins ok-rn ships.

- **Staged only when asked:** `OKEMU_PLUGINS=hello npm run rebuild` (emulator). Without it, the firmware is the base build, byte for byte.
- **Soft key and emulator only:** never in a hard-key image. ok-rn can stage it too, with `OKEMU_PLUGINS=hello OKEMU_PLUGINS_DIR=<node-onlykey-emulator>/emulator/plugins`.

## Hooks (both in `okcore.cpp`, each anchor must occur exactly once)
1. After `#include "onlykey.h"`: `#include "plugins/hello/okplugin_hello.h"`.
2. Before the vendor switch's own `default:` in `recvmsg()` (the one whose next line is `if (profilemode != NONENCRYPTEDPROFILE && FTFL_FSEC == 0x44 && …)`): a `case OKHELLO:` that calls `okplugin_hello_recv()` and returns.

## New code
- `src/okplugin_hello.h`: `OKHELLO` = `TYPE_INIT | 0x7E` (`0xFE` on the wire).
- `src/okplugin_hello.cpp`: answers `HELLO from plugin hello` (`hidprint`), only if the key is initialized, unlocked and not in config mode.

## Tests (side-loaded, they leave with the folder)
- `tests/kit.test.js` (the onlykey-testing kit, on this emulator): the answer while unlocked, and nothing while locked.
- `tests/e2e.js` (ok-rn e2e, on the Pixel soft key): `OKHELLO` answers "HELLO from plugin hello" while unlocked.

## What it does not do
- No storage: no flash, no EEPROM.
- Reads no secret and changes no existing behaviour.
- In config mode the firmware's allow-list (`okcore.cpp:335`) drops `OKHELLO` before the switch, as it does any message not on that list.
