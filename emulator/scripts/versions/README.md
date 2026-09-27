# One stage script per firmware release

`stage.js` is the engine. What differs between releases lives here, one file
per entry in `ok-versions.json`:

```bash
node scripts/stage.js --list          # what OKEMU_VERSION accepts, and its status
node scripts/stage.js                 # the working tree, unchanged default
OKEMU_VERSION=v3.0.2 node scripts/stage.js
node scripts/version-probe.js         # do the patterns still match? builds nothing
npm run e2e:matrix                    # build and run EVERY release (from ok-rn/)
```

Some build options are gates rather than patches, because the sources arrive
on both sides of the defines - and one of them is not a define at all:

```bash
OKEMU_DEBUG=1             force the DEBUG gate ON  - the console, not a requirement
OKEMU_PRODUCTION=1        force it OFF, the way the firmware ships
OKEMU_STD=1               force the STANDARD edition on
OKEMU_STD=0               force the IN TRVL edition (STD_VERSION off)
OKEMU_ENFORCE_ORIGINS=1   a debug build that still obeys the origin table
```

## OKEMU_ENFORCE_ORIGINS - the one thing a debug build cannot show you

`webcryptcheck()` ends its `#ifdef DEBUG` block with

```c
return 2; // Trust all origins for debug firmware
```

and that single line switches off three mechanisms before any of them is read:
the trusted-origin table (`apps.crp.to`, `apps.onlykey.io`), field 31's
`OKWC_ALLOW_STORED_KEY`, and field 31's `OKWC_DISABLE_EXT` kill switch. 2 is
also the most permissive answer the function has, so on an ordinary debug build
all three read as "allowed" - every origin is served and every stored-key
request over FIDO2 succeeds.

That is not a gap in coverage. It is a gap that LOOKS like coverage: a test
expecting a refusal gets service instead, and cannot tell "the firmware does
not implement this" from "this build was never asked to".

Building production is not the way out - that build has no console, so it
cannot be given a PIN. `OKEMU_ENFORCE_ORIGINS=1` cuts the one return and keeps
everything else, which is the only combination in which the origin table and
field 31 are observable at all:

```bash
OKEMU_ENFORCE_ORIGINS=1 ./android/gradlew -p android :app:installDebug
```

It is recorded in `src/generated/firmware.json` as `enforcingOrigins` and in
the stage summary as an `origins:` row, so a result is never attributed to the
wrong build from memory. Check that row: the flag reaches staging through
Gradle's process environment, and a daemon started without it would stage a
trust-all tree while the command line said otherwise.

Off by default, because it changes what the device DOES rather than what it
reports - a third-party origin is refused instead of served, so suites using
one take a different branch (`10b-thirdPartyOrigin`). On a production build it
is redundant and says so: the return is inside `#ifdef DEBUG` and is not
compiled. Asking for it on a tree that has no such line - the 2019 beta has an
EMPTY `#ifdef DEBUG` block and needs no flag - fails the stage rather than
producing a tree labelled enforcing that is not.

**A release provisions with the gate OFF.** This used to say the opposite, and
it was wrong: the PIN bracket is not held entirely in `Serial.println`. The
firmware announces every step that matters with `hidprint` on the vendor
interface, ungated, in all nine pinned versions, and the library waits on those
— racing the console only where it exists. Verified on 2026-09-18 against a
working-tree build with the gate off. See
`FINDING-provisioning-needs-a-debug-build.md`, which is now resolved.

`OKEMU_DEBUG=1` still buys the debug console, which `pressLine()` and the
firmware's own `printf` output need. It is a convenience, not a prerequisite.

Sources come out of the pinned commit's **object database** - `git ls-tree` and
`git cat-file`, never a checkout - into `.stage-src/<version>/`, cached by
commit. `OnlyKey-Firmware` and `libraries` are read-only references and are
never written to.

## Why per-version files

This started as one `VERSION_PATCHES` array with an `optional` flag, and that
shape could not work. An optional patch that silently misses looks exactly like
one that was never needed, so a release could build with a fix half-applied and
nothing would say so.

A version script names its release, so every patch in it is known to belong
there and applying it is **mandatory** - a pattern that does not match is an
error, which is the signal that the pins moved. The file is also the only
sensible place to write down how far that release has actually been taken.

## Status is a ladder

    blocked  <  untried  <  stages  <  builds  <  boots  <  tested

Each rung is something somebody watched happen, not something that ought to
follow from the rung below. Patches applying is not linking; linking is not
booting. `boots` means the firmware completed OKCONNECT, which is the pass
condition here because it performs the NaCl key exchange and so exercises the
flash mapping - a bad mapping produces a device that boots, answers HID, and
faults the first time it encrypts anything.

## Adding a release

Copy the nearest neighbour, change `version` to match the filename, set
`status: 'untried'`, empty `notes`. Then:

1. `node scripts/version-probe.js <version>` - do the shared patterns and the
   ones you copied still match at those pins? Every miss is one edit to
   generalise or to add.
2. `OKEMU_VERSION=<version> node scripts/stage.js` - patches apply. Record the
   digest it prints as `expect: { digest: ... }`.
3. Build, install, watch for OKCONNECT. Raise `status` one rung at a time and
   say in `notes` what you saw.

A release can also DECLARE the build options it must be staged with, when its
pinned commit does not have them set:

```js
gates: { std: true },
```

That is v2.1.1's case — its commit has `STD_VERSION` commented out, so it builds
as the travel edition and cannot even be given a PIN. Declaring it means the
release is staged the same way whoever runs it. An environment variable still
wins. See `FINDING-a-pinned-release-is-the-travel-edition.md`.

Patches that more than one release needs go in `_shared.js` and are imported by
name. Nothing there is applied automatically - `v2.1.1` and `v2.1.0` import
none of it, because `Profile_Offset` was measured already consistent at those
commits.
