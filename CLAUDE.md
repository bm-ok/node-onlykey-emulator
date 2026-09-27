# OnlyKey workspace

**This repo is the entry point for the whole workspace, not just the emulator.**
It sits *beside* eight other checkouts in one folder — nine repos side by side,
with `okpqc-venv/` generated alongside them. That parent folder is not itself a
git repo, which is why this file lives here: it travels with the one repo you
clone first.

Each sibling is a *swap slot*: what is resolved is the directory NAME, so any of
them can be replaced wholesale (a fork, an upstream revision, a branch under
test) without anything else changing. Nothing is pinned.

## Setup — one command

```sh
./setup.sh          # from this directory
```

It provisions everything needed to run any repo in the workspace: the
`okpqc-venv` Python environment, this repo's native addon, `pm2`, nw.js for the
test kit, the Docker firmware toolchain, and `npm install` in each Node
component. It ends by calling `scripts/setup-permissions.sh` under sudo — the one
privileged step, which loads `uhid`, installs a udev rule, compiles `dummy_hcd`
and brings up the USB gadget.

- Safe to re-run; existing checkouts and an existing venv are left alone.
- `--clone` fetches any missing component repos into the parent folder. Cloning
  only this repo and running `./setup.sh --clone` builds the whole workspace
  from scratch.
- `--no-privileged` skips the sudo step (the emulator then has no device node,
  and every device-backed test skips itself).
- It prints a summary read back from the system at the end. Trust that over the
  fact that it finished.

Verify with the test kit, which reports what this host can actually reach:

```sh
cd ../onlykey-testing && node bin/okt.js caps
```

## Layout

| directory | what it is |
|---|---|
| `node-onlykey-emulator/` | this repo — runs the firmware as a Node native addon; owns `setup.sh` |
| `../OnlyKey-Firmware/` | the firmware sources |
| `../libraries/` | OnlyKey's vendored Arduino libraries |
| `../arduino-1.6.5-r5-teensy_127/` | Teensyduino toolchain (Docker; only gates building a device `.hex`) |
| `../onlykey.github.io/` | the WEB app + the `onlykey-fido2` device library |
| `../OnlyKey-App/` | the packaged nw.js desktop APP |
| `../python-onlykey/` | `onlykey-cli`, `age-plugin-onlykey` |
| `../lib-agent/` | the agent framework (`onlykey-agent`, `onlykey-gpg`) |
| `../onlykey-testing/` | the test kit — 78 files, 416 tests, emulator-first |
| `../okpqc-venv/` | **generated** by setup.sh, not a repo. Do not commit it anywhere. |

## Things that will mislead you

**Two different things are called "the app".** `onlykey.github.io` is the web
app (test section 3, driven by `lib/gui.js`, reaches the device over the
WebAuthn tunnel). `OnlyKey-App` is the packaged nw.js app (test section 4,
driven by `lib/app.js`, reaches it via `chrome.hid`). They share nothing but
process plumbing.

**`vm.mmap_min_addr` decides how much of the device works.** Use `4096`
(setup-permissions.sh sets it). The firmware's `certified_hw` sits at `0x5BB0`,
so at the default `65536` the device boots and answers HID, then segfaults the
moment it encrypts anything — storing a PIN included. `0` would map page zero and
is what nobody should run.

**The test kit degrades by SKIPPING, not failing.** A green run can mean the
device was never exercised. `node bin/okt.js caps` says which capabilities are
missing and why; check it before believing a pass.

**Three siblings are off-limits to this repo.** `onlykey-testing`,
`python-onlykey` and `lib-agent` must be satisfied *as they ship* — the emulator
adapts to them, never the reverse. Firmware changes go behind `#ifdef
OK_EMULATOR` with the original preserved in the `#else`.

## Running the emulator

```sh
pm2 start ecosystem.config.js     # pm2 restart == the firmware's CPU_RESTART()
pm2 logs onlykey-emulator         # firmware debug output
```
