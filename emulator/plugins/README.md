# Firmware plugins

Experimental firmware features (owner, 2026-10-01). Each plugin is its own folder, so:
- it is **removed** by deleting the folder;
- it is **audited** by reading just the folder.

Hard keys never get them.

**Two homes:**
- This folder holds the **demo**, `hello`.
- ok-rn's `android/okemu/plugins/` holds the plugins ok-rn ships.

The loader that stages them is the same one for both: `node-onlykey-lib/cli/firmware-plugins`.

## Build the emulator with one
```
OKEMU_PLUGINS=hello npm run rebuild                                   # from this folder
OKEMU_PLUGINS=edge OKEMU_PLUGINS_DIR=<ok-rn>/android/okemu/plugins npm run rebuild
```
- **Without `OKEMU_PLUGINS`:** the base emulator, byte for byte.
- **With plugins:** `.stage/build.json` records `plugins` and `pluginsDir`, and the build keeps its own storage (`.onlykey-storage-plugins-<names>`), so the base emulator's data is never touched.

## Folder layout: `<plugins dir>/<name>/`
| File | What |
|---|---|
| `plugin.js` | the manifest: `name`, `minBase` (oldest firmware it is written for), `hooks`, `notes` |
| `src/` | the plugin's own C/C++, prefixed `okplugin_<name>_`; staged to `.stage/libraries/onlykey/plugins/<name>/` |
| `AUDIT.md` | every hook, every new message, every byte stored, and what it does not do |
| `tests/kit.test.js` | its emulator tests (the onlykey-testing kit): `module.exports = function register({it}, ctx)` |
| `tests/e2e.js` | its ok-rn soft-key tests (same shape) |

**Tests are side-loaded:**
- The kit's `01-protocol/38-softkey-plugins.test.js` reads `.stage/build.json` and registers each `<pluginsDir>/<name>/tests/kit.test.js`.
- Against a base emulator it skips.

**Hooks:** `{file, anchor, insert: 'before' | 'after', text}`.
- The anchor must occur **exactly once** in the staged file; otherwise the stage stops.
- Keep hooks to the minimum: an `#include`, and a `case` in the vendor switch.

## Plugins here
| Name | What |
|---|---|
| `hello` | demo: `OKHELLO` (0x7E) answers a fixed sentence while unlocked |
