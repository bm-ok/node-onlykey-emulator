#!/usr/bin/env node
/*
 * stage.js - assemble the complete firmware compile tree for the soft key.
 *
 * ONE STAGER FOR EVERY BUILD OF THE FIRMWARE ON A HOST: the Node addon on
 * Linux (gcc) and Windows (clang-cl + lld-link), and the Android library.
 * It mirrors arduino-1.6.5-r5-teensy_127/in-docker-build.sh, which builds by
 * COPYING everything into a scratch Arduino tree rather than compiling in
 * place:
 *
 *     cp OnlyKey-Firmware/*.c *.h  -> core/        (shadows core files)
 *     cp libraries/*               -> libraries/
 *
 * We do the same into emulator/.stage, then overlay emulator/core-override/.
 * Nothing in the component checkouts beside this repo is ever written to. They
 * are read, copied, and patched in the copy.
 *
 * WHY ONE FILE. ok-rn's android/okemu/scripts/stage.js was ported from this
 * one on 2026-09-07 and then grew the edition, model and origin gates, the
 * staged-source digest, the clean-on-swap marker and the clang/64-bit fixes,
 * while this one grew the Windows (MSVC ABI) patches. Two copies of one
 * stager drift: a fix landed in one was a bug still open in the other. This
 * is the merge (owner, 2026-10-21): ok-rn's file as the base, this repo's
 * paths, and everything this file had that ok-rn's lacked.
 *
 * WHICH BUILD IT STAGES FOR is TARGET, below - not the machine it runs on.
 * A Windows host stages Android builds too, so a patch for the MSVC ABI must
 * not follow the host into an Android tree.
 *
 * Layout produced (all under .stage/, all disposable):
 *   .stage/core/        teensy3 core + OnlyKey USB stack + our overrides
 *   .stage/libraries/   OnlyKey's vendored Arduino libraries, plus the stock
 *                       Arduino Time, ADC and EEPROM libraries
 *   .stage/sketch/      OnlyKey.ino
 *   .stage/build.json   what was staged: version, pins, gates, target, plugins
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EMU = path.resolve(__dirname, '..');
const ROOT = path.resolve(EMU, '..');
/*
 * The components are checkouts beside this repo, not inside it - see setup.sh.
 *
 * OKEMU_CHECKOUTS names that folder when this repo is NOT beside them: consumed
 * as a package (another project's node_modules/node-onlykey-emulator), the
 * parent folder holds node_modules' neighbours, not OnlyKey-Firmware,
 * libraries and arduino-1.6.5-r5-teensy_127. Unset, nothing changes.
 */
const CHECKOUTS = process.env.OKEMU_CHECKOUTS
  ? path.resolve(process.env.OKEMU_CHECKOUTS)
  : path.resolve(ROOT, '..');
const ARDUINO = path.join(CHECKOUTS, 'arduino-1.6.5-r5-teensy_127', 'arduino-1.6.5-r5');
const CORE_SRC = path.join(ARDUINO, 'hardware', 'teensy', 'avr', 'cores', 'teensy3');
const TLIB = path.join(ARDUINO, 'hardware', 'teensy', 'avr', 'libraries');
/*
 * The two VERSION-PINNED trees.
 *
 * `let`, not `const`, because OKEMU_VERSION repoints them at a released
 * commit's sources instead of the working tree - see materialiseVersion().
 * Everything downstream reads these and needs no idea which it got.
 */
let FW = path.join(CHECKOUTS, 'OnlyKey-Firmware');
let LIB_SRC = path.join(CHECKOUTS, 'libraries');
const OVERRIDE = path.join(EMU, 'core-override');

/*
 * Released versions, unpacked by commit - see materialiseVersion(). Inside
 * this repo but gitignored: ~6 MB a version, and rebuilt from git on demand.
 */
const VERSION_CACHE = path.join(EMU, '.stage-src');

const STAGE = path.join(EMU, '.stage');
const STAGE_CORE = path.join(STAGE, 'core');
const STAGE_LIB = path.join(STAGE, 'libraries');
const STAGE_SKETCH = path.join(STAGE, 'sketch');

/** Multi-line replacement text is written as lines and joined with this. */
const NL = String.fromCharCode(10);

/* ------------------------------------------------ the build TARGET
 *
 *     OKEMU_TARGET=node-linux   the Node addon, gcc, Itanium C++ ABI
 *     OKEMU_TARGET=node-win32   the Node addon, clang-cl + lld-link, MSVC ABI
 *     OKEMU_TARGET=android      the Android library, NDK clang, Itanium ABI
 *     unset                     the Node addon for the machine running this
 *
 * A patch may be scoped to targets. Used sparingly - a fix that is correct
 * everywhere should apply everywhere, so the trees do not drift - but some
 * defects only exist against one ABI or one libc: MSVC mangles a global's
 * type and linkage into its symbol where Itanium mangles neither, and only
 * the UCRT owns a `_write` that collides. Silently changing every other build
 * to fix one would be worse than the drift.
 *
 * It is the TARGET, not process.platform, because the machine that stages is
 * not always the one the tree is for: a Windows host stages Android trees,
 * and an MSVC-ABI patch landing in one would change an Android build to fix a
 * Windows linker.
 *
 * Patches written before targets existed say `platform: 'win32'` or
 * `platform: 'linux'` (this file's and the version scripts' alike). Those are
 * Node addon platforms, so they map onto the two node targets and never onto
 * android - see patchTargets().
 */
const TARGETS = ['node-linux', 'node-win32', 'android'];
const TARGET = process.env.OKEMU_TARGET ||
  (process.platform === 'win32' ? 'node-win32' : 'node-linux');
const PLATFORM_TARGETS = { win32: ['node-win32'], linux: ['node-linux'] };

/**
 * The targets a patch applies to, or null for every target.
 * Throws on a tag it does not know, rather than reading a typo as "nowhere".
 */
function patchTargets(p) {
  if (p.targets) {
    for (const t of p.targets) {
      if (!TARGETS.includes(t)) {
        throw new Error(`stage: patch for ${p.file} names target "${t}"; ` +
          `expected one of ${TARGETS.join(', ')}`);
      }
    }
    return p.targets;
  }
  if (p.platform) {
    const t = PLATFORM_TARGETS[p.platform];
    if (!t) {
      throw new Error(`stage: patch for ${p.file} names platform "${p.platform}"; ` +
        `expected one of ${Object.keys(PLATFORM_TARGETS).join(', ')} - or say targets: [...]`);
    }
    return t;
  }
  return null;
}

/**
 * This target's rung on a release's status ladder.
 *
 * The version scripts keep one ladder per Node platform (`emulator.linux`,
 * `emulator.win32`) and ok-rn's Android one as `status` (okrnStatus here):
 * "builds on Linux" is not "links with lld-link", and neither is "boots on a
 * phone", so each target reads its own.
 */
function targetStatus(release) {
  if (TARGET === 'android') return release.okrnStatus;
  return release.emulator[TARGET === 'node-win32' ? 'win32' : 'linux'];
}

/*
 * Bare-metal files with no host equivalent. Each is either superseded by a
 * file in core-override/ or simply not compiled.
 */
const DROP = [
  'mk20dx128.c',        // reset handler, vector table, clock init
  'pins_teensy.c',      // -> core-override/okemu_pins.cpp (systick, GPIO)
  'analog.c',           // -> core-override/okemu_pins.cpp
  'touch.c',            // -> core-override/okemu_pins.cpp (buttons)
  'eeprom.c',           // -> core-override/okemu_eeprom.cpp (file-backed)
  'usb_dev.c',          // -> core-override/okemu_usb.cpp
  'usb_rawhid.c',       //    "
  'usb_keyboard.c',     //    "
  'usb_seremu.c',       //    "
  'usb_serial.c',       //    "
  'usb_mem.c',          // USB endpoint buffer allocator
  'usb_mouse.c', 'usb_joystick.c', 'usb_midi.c', 'usb_flightsim.c', 'usb_mtp.c',
  'serial1.c', 'serial2.c', 'serial3.c',
  'HardwareSerial1.cpp', 'HardwareSerial2.cpp', 'HardwareSerial3.cpp',
  'IntervalTimer.cpp',  // ARM NVIC periodic interrupt
  'DMAChannel.cpp',
  'AudioStream.cpp',
  'Tone.cpp',
  'avr_emulation.cpp',
  'ser_print.c',
  'math_helper.c',
  'memcpy-armv7m.S',
  'main.cpp',           // Arduino main(); the addon / JNI layer drives setup()/loop()
  'Makefile',
  /*
   * yield.cpp - DEAD IN EVERY TREE, and a latent link failure while it stayed.
   *
   * Its whole body polls Serial/Serial1/Serial2/Serial3 for `serialEvent`
   * hooks, to call ones the firmware never defines. Every one of those UARTs
   * is already dropped above (serial1.c, HardwareSerial1.cpp and siblings), so
   * the file's only remaining effect is to reference symbols that are not
   * here.
   *
   * It links today by luck of linkage, not by design. core-override's
   * okemu_pins.cpp defines yield() too, and while THAT definition was strong
   * the archive member was never extracted, so the undefined
   * Serial1/serialEvent1 references were never resolved. Upstream then made
   * okemu_pins.cpp's yield() WEAK - correctly, matching the Teensy core's own
   * linkage so a sketch's override wins - which leaves weak against weak on
   * any tree whose sketch has no yield() of its own. That is every pinned
   * release at v3.0.4 and older. Which one the linker takes is then decided by
   * archive extraction order rather than by strength, and if the linker ever
   * reached for this one the build fails on undefined `serial_available`.
   *
   * Dropping it removes the coin flip. Nothing wants what it provides.
   */
  'yield.cpp',
];

/* ------------------------------------------------ the build-option gates
 *
 * Every gate below flips one of the firmware's OWN switches in the staged
 * onlykey.h - a define the firmware provides for exactly this choice. None of
 * them is a compiler flag: a header's #define always wins over -D/-U from
 * outside, so the staged copy is the only lever, the same one PATCHES uses.
 */

/**
 * WHICH SIDE OF THE DEBUG GATE this build is on.
 *
 *     (unset)              OFF - every build: the working tree and every
 *                          pinned release, the way the firmware ships
 *     OKEMU_DEBUG=1        force it ON (the DEBUG console: PIN provisioning
 *                          prompts, the "1#128" press parser); the device
 *                          then reports "-test"
 *     OKEMU_PRODUCTION=1   OFF - the older spelling, kept as an alias
 *
 * THE NEW STANDARD IS OFF BY DEFAULT (owner, 2026-10-21, after the firmware
 * 3.1.0 PRs shipped the sources with it off). The working tree used to be
 * forced ON as "the development build", because the kit drove presses and read
 * challenge digits through the DEBUG console. Presses no longer need it - the
 * okcore.cpp hand-over in PATCHES is compiled unconditionally - and a default
 * that differs from what ships is a default every measurement has to correct
 * for. A suite that needs the console asks for it with OKEMU_DEBUG=1, and
 * build.json records which it got.
 *
 * ## It is not a compiler flag
 *
 * `#define DEBUG` is at onlykey.h:81 - in the firmware SOURCE, not a build
 * option we can pass. -UDEBUG cannot undefine what a header defines. So the
 * only lever is the staged copy, the same one every other entry here uses.
 *
 * ## What the gate decides
 *
 * The define gates 259 sites in okcore.cpp alone. Two things follow:
 *
 *   - SEREMU, the debug console, is the device's FOURTH interface and exists
 *     only on a DEBUG build. A production device enumerates three.
 *   - Every Serial.print the library matches on. The PIN provisioning flow
 *     waits for "Enter PIN", "Storing PIN", "Confirm PIN" and "Both PINs
 *     Match", and a production build prints none of them.
 *
 * The version string carries the difference, which is how a host can tell:
 * onlykey.h defines OKversionkeyword as "-test" under DEBUG and "-prod"
 * otherwise, so a production build announces itself as UNLOCKEDv3.1.0-prodc.
 * See node-onlykey-lib/src/device/version.js. That is also why a pinned
 * release must not be staged with its source's DEBUG left live: a v3.0.4
 * "-test" key reads to node-onlykey-lib as the development tree and claims
 * postQuantum and xwingDerive, which the real v3.0.4 does not have.
 *
 * ## Why turning it ON has to exist
 *
 * A production device on a fresh flash can only be given a PIN through the
 * flows that do not need the console (FINDING-provisioning-needs-a-debug-
 * build.md). OKEMU_DEBUG=1 flips the firmware's own switch; it changes no
 * protocol and no behaviour the firmware does not itself define - it is the
 * difference between the two builds upstream ships.
 */
function wantDebug() {
  const debug = process.env.OKEMU_DEBUG === '1';
  const production = process.env.OKEMU_PRODUCTION === '1';
  if (debug && production) {
    /* Contradictory, and either reading would surprise whoever set the other. */
    throw new Error('stage: OKEMU_DEBUG=1 and OKEMU_PRODUCTION=1 are both set - ' +
      'DEBUG is off by default; set OKEMU_DEBUG=1 alone for a debug build');
  }
  return debug;
}
const WANT_DEBUG = wantDebug();

/**
 * WHICH EDITION this build is, and the same lever as the DEBUG gate.
 *
 *     OKEMU_STD=1   force the STANDARD edition on
 *     OKEMU_STD=0   force the TRAVEL edition (STD_VERSION off)
 *     unset         what the release's `gates.std` says, else the sources
 *
 * ## Why this had to exist
 *
 * `#define STD_VERSION` in onlykey.h decides whether this is the standard
 * edition or the IN TRVL one, and the difference is not cosmetic: it gates
 * set_private's body, U2Finit, and the encrypted profile itself - without it
 * `profilemode` is NONENCRYPTEDPROFILE and most of the device's own code
 * returns early.
 *
 * MEASURED across ok-versions.json: every pin is the standard edition EXCEPT
 * v2.1.1 (libraries@0dc7cf0), where both DEBUG and STD_VERSION are commented
 * out. So the pinned commit for that release is a travel build, and staged as
 * it is, almost nothing the suite exercises exists on it - not because the
 * release lacked those features, but because that commit's build flags were
 * left set for a different edition. Its version script declares
 * `gates: { std: true }`.
 *
 * Forcing it on is the same kind of change as OKEMU_DEBUG=1: the firmware
 * provides the switch and this flips it in the throwaway copy. The version
 * script records that the commit itself is travel, so nobody reads a standard
 * result and concludes the commit was standard.
 */
const ENV_STD =
  process.env.OKEMU_STD === '1' ? true
  : process.env.OKEMU_STD === '0' ? false
  : null;

/** Resolved in main(), where the version script is known. */
let WANT_STD = ENV_STD;

/**
 * WHICH MODEL this build is.
 *
 *     OKEMU_MODEL=duo       build as an OnlyKey DUO
 *     OKEMU_MODEL=classic   force the classic detection path
 *     unset                 leave the sources as they are (classic)
 *
 * ## The firmware provides this switch itself
 *
 * On hardware the model is read from the chip: `HW_ID` is `SIM_SDID_PINID`, the
 * package-type field, and okcore.cpp's touch-sense loop uses it plus an analog
 * reading to decide between a DUO and an OK_Color. Reproducing that in the HAL
 * would mean faking a register AND an analog pin, and getting the interplay
 * right.
 *
 * There is no need. onlykey.h already carries
 *
 *     //#define DEFINED_HWID OK_HW_DUO
 *
 * with the comment "override auto hw detection, hardcoded" at its use site
 * (okcore.cpp). Uncommenting it is the firmware's own way of saying which model
 * this build is, so that is the lever - the same kind of change as the DEBUG and
 * STD_VERSION gates, not a new mechanism.
 *
 * ## It is not available on every release
 *
 * MEASURED: the override is present at v3.0.2, v3.0.1, v3.0.0 and the working
 * tree, and ABSENT at v2.1.1 and v2.1.0. The DUO is newer than the 2.1 line, so
 * asking those to be one is asking for a device that never existed - the gate
 * reports that rather than silently producing a classic.
 */
const WANT_DUO =
  process.env.OKEMU_MODEL === 'duo' ? true
  : process.env.OKEMU_MODEL === 'classic' ? false
  : null;

/**
 * ENFORCING ORIGINS: a debug build that still obeys the trusted-origin table.
 *
 *     OKEMU_ENFORCE_ORIGINS=1   cut the debug "trust all origins" return
 *     unset                     leave it, which is what a debug build ships as
 *
 * ## The blind spot this exists to close
 *
 * webcryptcheck() (libraries/fido2/device.cpp) ends its `#ifdef DEBUG` block
 * with `return 2; // Trust all origins for debug firmware`, and that ONE line
 * disables three separate mechanisms at once, before any of them is read:
 *
 *   - the trusted-origin table (apps.crp.to, apps.onlykey.io), so any rpId
 *     derives - including ones a shipped key refuses outright;
 *   - OKWC_ALLOW_STORED_KEY (field 31 bit 0), so the stored-key OKSIGN /
 *     OKDECRYPT tunnel is open whatever the policy byte says;
 *   - OKWC_DISABLE_EXT (field 31 bit 1), so the kill switch does nothing.
 *
 * 2 is also the MOST permissive answer the function has, so all three read as
 * "allowed" on every debug build. None of the policy is observable there, and
 * a suite written against it passes whether the firmware implements any of it
 * or not.
 *
 * ## Why not simply build production
 *
 * A production build - the default now - does enforce, and needs nothing
 * here. This is for the debug build: cutting one return keeps the console
 * while running the production control flow underneath it, the only
 * combination in which the origin table and field 31 can be exercised with
 * the console's PIN provisioning available.
 *
 * The technique is the maintainer's. It is what found libraries@c1a6cf2: a
 * NULL `_appid` that segfaults on the first getAssertion, unnoticed for years
 * because no debug build had ever reached the code below the return.
 *
 * ## Opt-in, and deliberately not the default on a debug build
 *
 * On an enforcing build a derive from an untrusted origin is REFUSED, so
 * suites using a third-party rpId change behaviour rather than merely
 * reporting more. The two builds answer different questions, and an answer is
 * only attributable if which build produced it was recorded. It is - in
 * build.json as `enforce` (firmware.json: `enforcingOrigins`), and in the
 * stage summary.
 */
const WANT_ENFORCE = process.env.OKEMU_ENFORCE_ORIGINS === '1';

/*
 * The version the STAGED SOURCES declare, as "v3.1.0".
 *
 * Read rather than recorded, because the point of it is to track the
 * maintainer. onlykey.h builds the banner the device answers with -
 *
 *     #define OKversion "v" OKversionmaj "." OKversionmin "." OKversionpat
 *                       OKversionkeyword
 *     #define UNLOCKED  "UNLOCKED" OKversion
 *
 * - so these three defines are the same number `UNLOCKEDv3.1.0-prodc` carries
 * on the wire, and reading them here cannot drift from what the firmware says
 * about itself.
 *
 * THIS IS NOT `version`. That one is the RELEASE this build is a copy of, and
 * firmware.json keeps it null for the working tree on purpose: the app must not
 * report an unreleased tree as a release, and `unreleased` gates features on
 * it. This is the version the tree DECLARES, which for a working tree is the
 * one being worked towards. Both are wanted: one says what this is, the other
 * says what it will become.
 *
 * The keyword suffix (-test / -prod) is left off deliberately; `production`
 * already carries that and duplicating it invites the two to disagree.
 */
function readDeclaredVersion() {
  const target = path.join(STAGE_LIB, 'onlykey', 'onlykey.h');
  const text = fs.readFileSync(target, 'utf8');
  /* `//#define` cannot match: the `//` is not whitespace. */
  const part = (name) => {
    const m = new RegExp(
      String.raw`^[ \t]*#define[ \t]+${name}[ \t]+"([^"]*)"`, 'm').exec(text);
    return m ? m[1] : null;
  };
  const maj = part('OKversionmaj');
  const min = part('OKversionmin');
  const pat = part('OKversionpat');
  if (maj === null || min === null || pat === null) {
    /*
     * Not fatal. Every tree back to the 2019 beta has carried these, but a
     * staging that otherwise succeeded should not fail over a label - the
     * build is still correct, the app just shows one less thing.
     */
    console.error(
      'stage: WARNING - OKversionmaj/min/pat not all readable from ' +
      'libraries/onlykey/onlykey.h, so the declared version is unknown');
    return null;
  }
  return `v${maj}.${min}.${pat}`;
}

/**
 * Read - or flip - one of onlykey.h's build-option defines.
 *
 * A TOGGLE rather than a text patch, because the sources arrive on either side
 * of both of them and a patch written for one silently fails to find its
 * pattern in the other. This finds whichever spelling is there and reports the
 * state it leaves.
 *
 * MATCHED ON THE DEFINE, NOT ON THE WHOLE LINE. It used to compare the exact
 * text passed as `on`, trailing comment and all, and that comment is not
 * stable across releases: the 2019 beta line writes
 * `#define STD_VERSION //Define for US Version Firmare` where the 3.0 line
 * writes `//Define for STD edition firmare, undefine for IN TRVL edition
 * firmware`. Same define, same meaning, a different sentence after it - and
 * the old comparison read that as ABSENT, printed a bare `NaN` from a
 * broken error message, and reported the build as TRAVEL. That is a
 * different firmware: no FIDO, no encrypted profile, set_private returns
 * early. A comment is not a build option.
 *
 * @param name the define, for the log
 * @param on the line as it appears when the option is ENABLED
 * @param want true to enable, false to disable, null to leave it alone
 * @returns whether the staged tree ends up with it defined
 */
function gateDefine(name, on, want, { universal = true } = {}) {
  const target = path.join(STAGE_LIB, 'onlykey', 'onlykey.h');

  let text = fs.readFileSync(target, 'utf8');

  /*
   * The line as it stands in THIS tree, found by the DEFINE rather than by
   * the sentence after it. String.raw so the regex keeps its own escapes: in
   * an ordinary template literal `\b` is a backspace, not a word boundary,
   * and the difference is a matcher that silently never matches.
   *
   * Commented-out is tested first, because `//#define X` contains `#define X`.
   */
  const offLine = new RegExp(String.raw`^[ \t]*//[ \t]*#define[ \t]+${name}\b.*$`, 'm');
  const onLine = new RegExp(String.raw`^[ \t]*#define[ \t]+${name}\b.*$`, 'm');

  let enabled;
  let here = null;
  const offMatch = offLine.exec(text);
  const onMatch = offMatch ? null : onLine.exec(text);
  if (offMatch) { enabled = false; here = offMatch[0]; }
  else if (onMatch) { enabled = true; here = onMatch[0]; }
  else {
    /*
     * ABSENT. For a define every release carries that is a real problem - the
     * option has been renamed and we would otherwise read a silent, wrong
     * 'off'. For one that only some releases have, DEFINED_HWID being the
     * case, absence is the ordinary state and saying nothing is correct.
     */
    if (universal) {
      console.error(
        `stage: ${name} is absent from libraries/onlykey/onlykey.h, so the ` +
        'build option could not be read. Either it was renamed at this pin, ' +
        'or this release predates it - if the latter, pass ' +
        '{ universal: false } for it.');
      process.exitCode = 1;
    }
    return null;
  }

  if (want === null || want === enabled) return enabled;

  /*
   * Flipped IN PLACE, keeping whatever comment this tree carries. Rewriting
   * the line to the `on` string passed in would replace one release's
   * comment with another's, which is how a staged tree quietly stops being
   * the release it claims to be.
   */
  text = want
    ? text.replace(here, here.replace(/^([ \t]*)\/\/[ \t]*/, '$1'))
    : text.replace(here, here.replace(/^([ \t]*)/, '$1//'));
  writeFileRetrying(target, text);
  console.log(
    `stage: ${name} turned ${want ? 'ON' : 'OFF'} (was ${enabled ? 'ON' : 'OFF'})`);
  return want;
}

/**
 * Set - or just read - the DEBUG gate in the staged onlykey.h.
 *
 * A TOGGLE rather than a text patch, because the sources arrive on either side
 * of it: 3.1.0 and the signed releases have the define commented out, older
 * working trees had it live, and a patch written for one silently fails to
 * find its pattern in the other. This finds whichever spelling is there and
 * reports the state it leaves.
 *
 * DEBUG_CTAP_VERBOSE is a SEPARATE define that only newer trees carry, and it
 * follows DEBUG down: it gates its own sites in fido2/device.cpp and
 * okcore.cpp, so leaving it defined would keep printing to a console a
 * production build does not have. It is never turned ON - it fires on every
 * presence-test poll and floods the console this build reads.
 *
 * @param want true for DEBUG, false for production, null to leave it be.
 * @returns whether the staged tree ends up with DEBUG defined.
 */
function gateDebug(want) {
  const target = path.join(STAGE_LIB, 'onlykey', 'onlykey.h');
  const ON = '#define DEBUG //Enable Serial Monitor';
  const OFF = '//#define DEBUG //Enable Serial Monitor';

  let text = fs.readFileSync(target, 'utf8');

  /* OFF contains ON as a substring, so it has to be tested first. */
  let on;
  if (text.includes(OFF)) on = false;
  else if (text.includes(ON)) on = true;
  else {
    console.error(
      'stage: WARNING - the DEBUG define is not where it has always been in ' +
      'libraries/onlykey/onlykey.h, so the build gate could not be read.');
    process.exitCode = 1;
    return null;
  }

  if (want === null || want === on) {
    console.log(`stage: DEBUG gate is ${on ? 'ON' : 'OFF'} as the sources have it`);
    return on;
  }

  text = want
    ? text.split(OFF).join(ON + ' - re-enabled by stage.js for OKEMU_DEBUG=1')
    : text.split(ON).join('//#define DEBUG - removed by stage.js: off unless OKEMU_DEBUG=1');

  /* Only ever downwards, and only where the tree has it. */
  if (!want) {
    const verbose = /^#define DEBUG_CTAP_VERBOSE.*$/m;
    if (verbose.test(text)) {
      text = text.replace(verbose,
        '//#define DEBUG_CTAP_VERBOSE - removed with DEBUG; it prints to a ' +
        'console a production build does not have');
    }
  }

  writeFileRetrying(target, text);
  console.log(`stage: DEBUG gate turned ${want ? 'ON' : 'OFF'} (was ${on ? 'ON' : 'OFF'})`);
  return want;
}

/**
 * Keep core/keylayouts.h on the same side of the gate as onlykey.h.
 *
 * The header asks for this itself - "keep it in sync manually" above a define
 * whose comment is "comment this out (to match #undef DEBUG in onlykey.h) for
 * a release build". Two switches for one decision, and the second one is in a
 * file nobody edits.
 *
 * What hangs off it: with KEYLAYOUTS_DEBUG_BUILD defined, all twenty-six
 * SUPPORT_LAYOUT_* lines are commented out and only US English compiles, its
 * block being the one with no guard. Every other layout takes an empty branch
 * and types nothing at all (FINDING-only-us-english-types-on-a-debug-build.md).
 *
 * Reported either way, and never fatal. A release old enough to predate the
 * switch is a fact about that release, not a staging failure.
 *
 * @param {boolean|null} debugOn what the DEBUG gate ended up as
 */
function gateKeylayouts(debugOn) {
  if (debugOn === null) return null;

  const target = path.join(STAGE_CORE, 'keylayouts.h');
  if (!fs.existsSync(target)) return null;

  const ON = '#define KEYLAYOUTS_DEBUG_BUILD';
  const OFF = '//#define KEYLAYOUTS_DEBUG_BUILD';

  let text = fs.readFileSync(target, 'utf8');
  const on = text.includes(OFF) ? false : text.includes(ON) ? true : null;
  if (on === null) {
    console.log('stage: keylayouts.h has no KEYLAYOUTS_DEBUG_BUILD switch at this pin');
    return null;
  }

  if (on === debugOn) {
    console.log(
      `stage: keyboard layouts ${on ? 'US English only' : 'all enabled'} ` +
      '- already matching the DEBUG gate');
    return on;
  }

  text = debugOn
    ? text.split(OFF).join(ON + ' - re-enabled by stage.js to match the DEBUG gate')
    : text.split(ON).join(OFF + ' - removed by stage.js to match the DEBUG gate');

  writeFileRetrying(target, text);
  console.log(
    `stage: keyboard layouts ${debugOn ? 'US English only' : 'ALL ENABLED'} ` +
    `- synced to the DEBUG gate (was ${on ? 'US English only' : 'all enabled'})`);
  return debugOn;
}

/**
 * Cut the debug "trust all origins" return, so the origin table and the
 * webcrypt policy actually decide. WANT_ENFORCE says what that buys.
 *
 * A GATE rather than an entry in PATCHES, and that is the whole reason this is
 * a function: applyPatches() treats a missing anchor as a WARNING and carries
 * on, which here would produce the worst outcome available - a tree labelled
 * enforcing, in build.json and in every result taken from it, that quietly
 * trusts everything. A wrong answer in the direction that looks fine. So this
 * throws instead.
 *
 * The edit COMMENTS THE LINE OUT rather than deleting it, because the staged
 * tree is what someone reads when a result surprises them, and a line that is
 * simply gone explains nothing. The debug prints above it are kept: they are
 * the reason this is still a debug build, and webcryptcheck() is exactly where
 * a refusal needs to be visible.
 *
 * @param want     true to cut it
 * @param debugOn  the gate as gateDebug() left it
 * @returns whether this build enforces the origin table
 */
function gateTrustAllOrigins(want, debugOn) {
  /*
   * A production build has no `#ifdef DEBUG` body to cut, and enforces
   * already. Reporting that beats both alternatives: refusing a request that
   * is already satisfied, and answering `false` for a build that does enforce.
   */
  if (debugOn === false) {
    if (want) {
      console.log(
        'stage: OKEMU_ENFORCE_ORIGINS=1 on a production build - redundant. ' +
        'The trust-all return is inside #ifdef DEBUG and is not compiled; ' +
        'this build enforces either way.');
    }
    return true;
  }
  if (!want) return false;

  const target = path.join(STAGE_LIB, 'fido2', 'device.cpp');
  const TRUST_ALL = '    return 2; // Trust all origins for debug firmware';
  const CUT = [
    '    /* stage.js, OKEMU_ENFORCE_ORIGINS=1: the trust-all return is',
    '     * cut here. Execution falls through to the trusted[] table and the',
    '     * field 31 policy below, exactly as a production build does, while',
    '     * the debug console this suite needs for PIN entry stays. */',
    '    // return 2; // Trust all origins for debug firmware',
  ].join(NL);

  const text = fs.readFileSync(target, 'utf8');
  /*
   * One line, so no CRLF variant to try - the pattern contains no newline.
   */
  if (!text.includes(TRUST_ALL)) {
    throw new Error(
      'stage: OKEMU_ENFORCE_ORIGINS=1, but webcryptcheck() in ' +
      'libraries/fido2/device.cpp does not contain ' + TRUST_ALL.trim() + ' - ' +
      'either this release predates it (the 2019 beta line has an EMPTY ' +
      '#ifdef DEBUG block, so it has no early return and already enforces: ' +
      'drop the flag for that pin) or the line was respelled upstream and this ' +
      'gate has to be taught the new spelling. Refusing to stage: a tree that ' +
      'reports enforcing without enforcing makes every measurement taken from ' +
      'it wrong in the direction that looks correct.');
  }
  writeFileRetrying(target, text.split(TRUST_ALL).join(CUT));
  console.log(
    'stage: ENFORCING build - webcryptcheck() trust-all return cut. The ' +
    'trusted-origin table and webcrypt policy (field 31) decide; the debug ' +
    'console is kept.');
  return true;
}

/*
 * The null `_appid` guard, applied on BOTH sides of the DEBUG gate.
 *
 * It used to live in DEBUG_OFF_PATCHES, on the reasoning that a debug build
 * returns 2 from webcryptcheck() - "trust all origins for debug firmware" -
 * before reaching any comparison, so the nulls could never be dereferenced.
 *
 * THAT IS TRUE OF EVERY RELEASE EXCEPT THE OLDEST. v0.2-beta.8's
 * webcryptcheck takes one argument and its `#ifdef DEBUG` block is EMPTY -
 * there is no early return to reach - so it runs the comparisons on a debug
 * build too, and extend_fido2() passes NULL for _appid on the whole CTAP2
 * route. Measured from the tombstone:
 *
 *   #00 __memcmp_aarch64+16
 *   #01 webcryptcheck+356
 *   #03 ctap_filter_invalid_credentials  #04 ctap_get_assertion
 *   #05 ctap_request  #06 ctaphid_handle_packet
 *
 * Its PRODUCTION build survived, because DEBUG_OFF_PATCHES guarded it, while
 * its DEBUG build died in ctapFlow - exactly backwards from what a debug
 * build is for, since that release is the one still being diagnosed.
 *
 * Applying it always costs nothing where the early return exists, because the
 * guard is then unreachable. The literal was checked to exist verbatim at
 * every pin in ok-versions.json. The working tree and v3.1.0 no longer have
 * the line (upstream fixed it, libraries@c1a6cf2) and their version scripts
 * declare it absent.
 * ok-rn/FINDING-production-firmware-crashes-in-webcryptcheck.md
 */
const APPID_NULL_GUARD = {
  file: 'libraries/fido2/device.cpp',
  edits: [
    ['	appid_match2 = memcmp (stored_appid, _appid, 32);',
     '	appid_match2 = (_appid == NULL) ? 1 : memcmp (stored_appid, _appid, 32);'],
  ],
};

/**
 * Needed whenever the DEBUG gate ends up OFF, whichever way it got there.
 *
 * Keyed on the RESULTING gate rather than on an environment variable, which is
 * the difference between a v3.0.2 that survives a getAssertion and one that
 * takes SIGSEGV on the first one.
 *
 * Edits that only some trees have are NOT here - see the version scripts'
 * `debugOffPatches`. The edit below was checked to exist verbatim at every
 * release in ok-versions.json; the working tree and v3.1.0 declare it absent
 * in `debugOffAbsentPatterns`.
 */
const DEBUG_OFF_PATCHES = [
  {
    /*
     * webcryptcheck() dereferences two pointers its callers hand it as NULL.
     *
     * ctap.cpp:1141 calls `webcryptcheck(NULL, NULL)` from
     * add_existing_user_info(), which is the ordinary allowList walk during a
     * getAssertion. On a DEBUG build the function returns 2 - "trust all
     * origins for debug firmware" - BEFORE reaching any comparison, so the
     * nulls never matter. That return sits inside the #ifdef, so with the gate
     * off execution falls straight into memcmp(stored_appid, NULL, 32) and the
     * firmware thread takes SIGSEGV. The device then stops answering entirely.
     *
     * The production path of this function had evidently never run anywhere:
     * byteprint() already carries a guard for the SAME pointer, with a comment
     * saying callers hand it null freely, so the null was known and guarded in
     * the debug print but not in the code that uses it.
     *
     * DECIDED WITH THE USER, not assumed. Upstream this belongs in
     * libraries/fido2/device.cpp unconditionally (and is there from
     * libraries@c1a6cf2). See FINDING-production-firmware-crashes-in-
     * webcryptcheck.md.
     */
    file: 'libraries/fido2/device.cpp',
    edits: [
      ['    appid_match1 = memcmp (stored_apprpid, rpid, 12);',
       [
         '    /* Injected by scripts/stage.js wherever the DEBUG gate is OFF.',
         '',
         '       Callers pass NULL for both of these. ctap.cpp:1141 passes',
         '       webcryptcheck(NULL, NULL); extensions.cpp:113 and :125 -',
         '       extend_fido2(), the whole CTAP2 path - pass NULL as _appid on',
         '       both branches. The #ifdef DEBUG early return above keeps a debug',
         '       build from dereferencing them on every release that HAS one -',
         '       see APPID_NULL_GUARD for the guard that assumes nothing.',
         '',
         '       Guarded per COMPARISON rather than by returning early, so every',
         '       check whose inputs are actually present still runs. The rpid',
         '       check reads ctap_buffer, not _appid, and is the only one the',
         '       CTAP2 path can satisfy - skipping it would refuse requests the',
         '       firmware is meant to accept. A non-zero memcmp result means "no',
         '       match", which is the honest answer for a pointer that is not',
         '       there. */',
         '    appid_match1 = memcmp (stored_apprpid, rpid, 12);',
       ].join(NL)],
    ],
  },
];

/*
 * Fixes that only SOME releases need live in scripts/versions/<version>.js -
 * one file per release, loaded by OKEMU_VERSION.
 *
 * They were an `optional` array here first, and that shape could not work: an
 * optional patch that silently misses looks exactly like one that was never
 * needed, so a release could build with a fix half-applied and nothing would
 * say so. Per-version files make every patch MANDATORY - the version script
 * lists what that release needs, and a pattern that does not match is an error.
 *
 * Patches shared by several releases live in scripts/versions/_shared.js and
 * are imported by name; nothing there is applied automatically.
 */

/*
 * Literal fixups applied to STAGED copies only.
 *
 * Anything the FIRMWARE needs in order to run hosted belongs in the OnlyKey
 * sources under `#ifdef OK_EMULATOR`, or - where the fix is correct on the
 * MK20DX256 too - as an unconditional correction; libraries@2ec3a12 moved the
 * working tree's host-build fixes there. But every pinned release predates
 * that, the vendored Teensy core is not OnlyKey code and should not carry
 * emulator knowledge, and a header's own #define always wins over anything
 * predefined from outside. So the staged copy is patched, and each entry says
 * what it would have been upstream.
 *
 * An entry may be scoped with `targets: [...]` (or the older
 * `platform: 'win32' | 'linux'`) - see TARGET. A missed pattern sets a non-zero
 * exit, and `npm run stage && node-gyp ...` then stops before the compiler
 * runs - a patch that silently fails to apply is worse than one that errors.
 *
 * If you find yourself adding an entry here for an OnlyKey source file that
 * the working tree also needs, gate it in that file upstream instead.
 */
const PATCHES = [
  {
    file: 'core/kinetis.h',
    edits: [
      // `cpsid i` / `cpsie i` mask interrupts. There are none here - the
      // firmware runs on one thread against memory-backed peripherals - so
      // these reduce to the compiler barrier the surrounding flash and USB
      // buffer code actually depends on. (On x86 and AArch64/ARMv7-A they are
      // not valid instructions either.)
      ['#define __disable_irq() __asm__ volatile("CPSID i":::"memory");',
       '#define __disable_irq() __asm__ volatile("":::"memory");'],
      ['#define __enable_irq()\t__asm__ volatile("CPSIE i":::"memory");',
       '#define __enable_irq()\t__asm__ volatile("":::"memory");'],
    ],
  },
  {
    /*
     * REBASE THE FLASH ARRAY onto OKEMU_FLASH_BASE. This is the patch that
     * makes the soft key a usable device rather than a protocol toy.
     *
     * The firmware addresses its own storage through absolute pointers at the
     * MK20DX256's real addresses, from 0. The bottom of the address space is
     * not available to an ordinary process anywhere:
     *   - Linux maps address 0x1000 and up only with vm.mmap_min_addr lowered
     *     from its default 65536 - a machine-wide sysctl a user's computer
     *     should not need for the soft key, and at the default certified_hw at
     *     0x5BB0 is unmapped and the first AES-GCM operation faults.
     *   - Windows reserves the bottom 64 KB of every process, cannot be
     *     persuaded otherwise, and the next rung up leaves certified_hw at
     *     0x5BB0 unmapped, which faults on the first AES-GCM operation. There
     *     OKEMU_FLASH_BASE is a variable the HAL sets once at init, declared in
     *     shim/okemu_prelude.h and src/ok_hal.h.
     *   - Android's mmap_min_addr is 0x8000 and an unprivileged app cannot
     *     change it, so the mapping fell back to 0x10000 - above certified_hw.
     *     The device then booted, answered HID, and faulted the moment it
     *     encrypted anything, which includes storing a PIN. OKEMU_FLASH_BASE
     *     comes from its CMakeLists.
     *
     * So move the origin instead of fighting the floor. Only four literals
     * exist; everything else in okcore.h derives from them, and every offset
     * and difference between them is unchanged.
     *
     * Upstream this belongs in the OnlyKey sources under #ifdef OK_EMULATOR -
     * unlike the uintptr_t fixes, this one genuinely is emulator-specific and
     * must NOT change the device build.
     */
    targets: ['node-linux', 'node-win32', 'android'],
    file: 'libraries/onlykey/okcore.h',
    edits: [
      /*
       * The trailing `//22528 - 23551` is deliberately NOT part of the pattern.
       *
       * v2.1.0 and v2.1.1 define the same address with no comment after it, so
       * a pattern carrying the comment misses on those releases while the three
       * other edits in this file still apply - the patch half-lands, and what
       * gets built is a tree with one address unrebased. Matching the define
       * alone applies to every release in ok-versions.json; any comment already
       * on the line simply trails the replacement, which is still valid C.
       *
       * Found by ok-rn's scripts/version-probe.js, which is what it is for.
       */
      ['#define factorysectoradr 0x5800',
       '#define factorysectoradr (OKEMU_FLASH_BASE + 0x5800)'],
      ['#define fwstartadr 0x6060',
       '#define fwstartadr (OKEMU_FLASH_BASE + 0x6060)'],
      ['#define flashstorestart 0x3A800',
       '#define flashstorestart (OKEMU_FLASH_BASE + 0x3A800)'],
      ['#define flashend 0x3FFFF',
       '#define flashend (OKEMU_FLASH_BASE + 0x3FFFF)'],
    ],
  },
  {
    /*
     * AIRCR, the one system register okcore.h names ITSELF.
     *
     * rewriteRegisterBlocks() rebases the 0xE0000000 window. Its first version
     * walked only core/kinetis.h, so this bare pointer literal in an OnlyKey
     * header stayed at the raw address - while kinetis.h's own name for the
     * SAME register, SCB_AIRCR, was rebased correctly. Two names, one register,
     * one of them left behind.
     *
     * The consequence was not a silent no-op, it was a CRASH on Android.
     * Nothing maps 0xE000ED0C, so every CPU_RESTART() - the idle lockout, the
     * lock gesture, a failed integrity check, the end of a wipe - wrote to
     * unmapped memory and took the whole app down with SIGSEGV. Measured:
     * fault addr 0xe000ed0c on a write, in okemu_firmware_run, with
     * x8 = 0x05fa0004, which is CPU_RESTART_VAL.
     *
     * The register pass now walks every staged source and would rebase this
     * cast too; the edit stays because it also PARENTHESISES the macro, which
     * the original spelling did not - `CPU_RESTART_ADDR` expands into an
     * expression, and an unparenthesised cast binds to whatever follows it.
     * Every target: on each of them the store must land on the relocated
     * block, which okemu_restart.cpp / the HAL turn into a restart EVENT.
     */
    file: 'libraries/onlykey/okcore.h',
    edits: [
      ['#define CPU_RESTART_ADDR (uint32_t *)0xE000ED0C',
       '#define CPU_RESTART_ADDR ((uint32_t *)OKEMU_SCS(0xE000ED0C))'],
    ],
  },
  {
    /*
     * OnlyKey source, like the okcore.h rebase above.
     *
     * rsa_encrypt() and rsa_decrypt() print the address of a stack local as a
     * stack-depth diagnostic, under #ifdef DEBUG. uint32_t truncates that
     * address on any 64-bit target.
     *
     * Upstream this belongs in the OnlyKey sources as an unconditional
     * correction: uintptr_t is right on the MK20DX256 too, where it is a
     * 32-bit type and nothing changes.
     *
     * Both call sites are the same line, so one edit covers them.
     */
    file: 'libraries/onlykey/okcrypto.cpp',
    edits: [
      [['Serial.println ((uint32_t)&ret);',
        'Serial.println((uint32_t)&ret);'],   // 3.1.0: no space before the paren
       'Serial.println ((uintptr_t)&ret);'],
    ],
  },
  {
    /*
     * Same class as okcrypto.cpp above, and the same note applies: this belongs
     * upstream, unconditionally, because uintptr_t is correct on the MK20DX256
     * too.
     *
     * ctap_parse.cpp measures a CBOR span by casting both ends to uint32_t and
     * subtracting. The subtraction is fine; narrowing the pointers first is
     * not, and on a 64-bit target it can silently produce a bogus length for a
     * buffer that is then bounds-checked against it.
     */
    file: 'libraries/fido2/ctap_parse.cpp',
    edits: [
      ['uint32_t length = (uint32_t)end_byte - (uint32_t)start_byte;',
       'uint32_t length = (uint32_t)((uintptr_t)end_byte - (uintptr_t)start_byte);'],
    ],
  },
  {
    /*
     * Arduino's ADC library, same bit-band macro shape as the Teensy core's
     * GPIO ones - a peripheral address narrowed to uint32_t. Not OnlyKey code.
     * Staged from the Arduino install (main(), step 5a) so it can be patched
     * without editing a tree every other build on the machine shares.
     */
    file: 'libraries/ADC/ADC_Module.h',
    edits: [
      ['#define ADC_BITBAND_ADDR(reg, bit) (((uint32_t)(reg) - 0x40000000) * 32 + (bit) * 4 + 0x42000000)',
       /* No bit-band alias exists any more (see rewriteRegisterBlocks()): any use
        * must fail to LINK, not compute an address nothing backs. */
       '#define ADC_BITBAND_ADDR(reg, bit) (okemu_bitband_unsupported())'],
    ],
  },
  {
    /*
     * The Teensy core assumes a 32-bit pointer in these macros. They are fatal
     * on arm64 and x86_64 under clang, which rejects a narrowing pointer cast
     * outright; GCC demotes it to a warning, and the Linux addon additionally
     * builds with -w, so neither showed up there.
     *
     * These three macros account for 190 of the 194 diagnostics on their own -
     * they expand once per GPIO register. Taking the address of a peripheral
     * register through uintptr_t rather than uint32_t is correct on every
     * architecture.
     */
    file: 'core/avr_emulation.h',
    edits: [
      /*
       * The bit-band macro computes an address in the 32 MB alias region at
       * 0x42000000. There is no alias region any more (see
       * rewriteRegisterBlocks()), and the inline members that expand this are
       * never called - so a call now fails to LINK against the undefined
       * okemu_bitband_unsupported() instead of writing through an address
       * nothing backs.
       */
      ['#define GPIO_BITBAND_ADDR(reg, bit) (((uint32_t)&(reg) - 0x40000000) * 32 + (bit) * 4 + 0x42000000)',
       '#define GPIO_BITBAND_ADDR(reg, bit) (okemu_bitband_unsupported())'],
      ['#define GPIO_SETBIT_ATOMIC(reg, bit) (*(uint32_t *)(((uint32_t)&(reg) - 0xF8000000) | 0x480FF000) = 1 << (bit))',
       '#define GPIO_SETBIT_ATOMIC(reg, bit) (*(uint32_t *)(((uintptr_t)&(reg) - 0xF8000000) | 0x480FF000) = 1 << (bit))'],
      ['#define GPIO_CLRBIT_ATOMIC(reg, bit) (*(uint32_t *)(((uint32_t)&(reg) - 0xF8000000) | 0x440FF000) = ~(1 << (bit)))',
       '#define GPIO_CLRBIT_ATOMIC(reg, bit) (*(uint32_t *)(((uintptr_t)&(reg) - 0xF8000000) | 0x440FF000) = ~(1 << (bit)))'],
    ],
  },
  {
    /*
     * Print::printf() passes `this` to vdprintf() as a file descriptor, and
     * newlib's _write() - a few lines above in this same file - casts that
     * integer back to a Print*. A pointer round-tripped through an int, which
     * is correct on the MK20DX256 where both are 32 bits, and a narrowing cast
     * that clang REJECTS on any 64-bit target.
     *
     * So it has to be addressed to compile. It is addressed as narrowly as
     * possible: an explicit two-step cast, which is what the original already
     * means. Nothing here changes what the function does - and NOTHING in the
     * compiled set calls Print::printf (every call site in libraries/ is
     * commented out, and examples/ is excluded by gen-sources).
     */
    file: 'core/Print.cpp',
    edits: [
      ['	return vdprintf((int)this, format, ap);',
       '	return vdprintf((int)(intptr_t)this, format, ap);'],
      ['	return vdprintf((int)this, (const char *)format, ap);',
       '	return vdprintf((int)(intptr_t)this, (const char *)format, ap);'],
    ],
  },
  {
    /*
     * Print::println(size_t) is ambiguous on LLP64 - i.e. on Windows.
     *
     * Print declares overloads up to `unsigned long` and stops. On the device,
     * on Linux and on Android that is enough, because size_t IS unsigned long
     * there (ILP32 and LP64 both). Windows is LLP64: long stays 32 bits and
     * size_t is unsigned long long, which matches NONE of the overloads exactly
     * and converts equally well to several, so the call is ambiguous:
     *
     *     okcrypto.cpp:1070: Serial.println(rsa.len);   // rsa.len is size_t
     *     error: call to member function 'println' is ambiguous
     *
     * Twelve call sites across okcore.cpp and okcrypto.cpp, all of them debug
     * prints. Adding the missing overloads fixes every one without touching a
     * single call, and where size_t is unsigned long the new overloads are
     * simply never selected - so every target, to keep the core identical.
     *
     * They narrow to unsigned long before printing. These print lengths and
     * addresses from a 32-bit firmware, so nothing being printed can exceed
     * 32 bits - and a println that truncates in some hypothetical future is a
     * far smaller problem than a core that will not compile.
     */
    file: 'core/Print.h',
    edits: [
      ['\tsize_t println(unsigned long n)\t\t\t{ return print(n) + println(); }',
       '\tsize_t println(unsigned long n)\t\t\t{ return print(n) + println(); }\n'
       + '\tsize_t println(unsigned long long n)\t\t{ return print((unsigned long)n) + println(); }\n'
       + '\tsize_t println(long long n)\t\t\t{ return print((long)n) + println(); }'],
      ['\tsize_t println(unsigned long n, int base)\t{ return print(n, base) + println(); }',
       '\tsize_t println(unsigned long n, int base)\t{ return print(n, base) + println(); }\n'
       + '\tsize_t println(unsigned long long n, int base)\t{ return print((unsigned long)n, base) + println(); }\n'
       + '\tsize_t println(long long n, int base)\t\t{ return print((long)n, base) + println(); }'],
    ],
  },
  {
    /*
     * uECC calls uECC_point_mult() before it is declared.
     *
     * uECC.c calls it from inside uECC_shared_secret2(), ~11 lines before the
     * definition, and the only prototype lives in uECC_vli.h behind
     * #if uECC_ENABLE_VLI_API, which this build does not set. In C89 that is
     * legal - the compiler invents `int uECC_point_mult()`. C99 dropped
     * implicit declarations, and clang 16 (and GCC 14) made it an error:
     *
     *     error: call to undeclared function 'uECC_point_mult'
     *     error: conflicting types for 'uECC_point_mult'
     *
     * The second error is the consequence of the first: the invented `int`
     * return type then clashes with the real `void` definition. So warning
     * flags cannot fix this - -Wno-implicit-function-declaration silences the
     * complaint but still invents the wrong declaration, and the conflict
     * stands. A real prototype is the only fix.
     *
     * Anchored on the includes at the top of the file, which every tree back
     * to the 2019 beta carries verbatim.
     */
    file: 'libraries/uECC/uECC.c',
    edits: [
      ['#include "uECC.h"\n#include "uECC_vli.h"',
       '#include "uECC.h"\n#include "uECC_vli.h"\n\n' +
       '/* Injected by scripts/stage.js - defined below at file scope, but\n' +
       ' * called before its definition. */\n' +
       'void uECC_point_mult(uECC_word_t *result,\n' +
       '                     const uECC_word_t *point,\n' +
       '                     const uECC_word_t *scalar,\n' +
       '                     uECC_Curve curve);'],
    ],
  },
  {
    /*
     * The same prototype again, immediately above the function that calls it.
     *
     * Redundant with the entry above wherever both anchors exist - a second
     * identical declaration is a legal redeclaration in C and changes nothing
     * compiled. It is kept because it is the spelling this repo's version
     * scripts were written against: v0.2-beta.8 (which has no
     * uECC_shared_secret2) declares THIS anchor absent, and a release that
     * declares absent a pattern no patch looks for fails the stage as a stale
     * claim. Retire it together with that absentPatterns line.
     */
    file: 'libraries/uECC/uECC.c',
    edits: [
      ['int uECC_shared_secret2(const uint8_t *public_key,',
       'void uECC_point_mult(uECC_word_t *result,\n'
       + '                     const uECC_word_t *point,\n'
       + '                     const uECC_word_t *scalar,\n'
       + '                     uECC_Curve curve);\n\n'
       + 'int uECC_shared_secret2(const uint8_t *public_key,'],
    ],
  },
  {
    /*
     * RNG2 IS DECLARED WITH THE WRONG SECOND PARAMETER.
     *
     * The definition, okcore.cpp:7630, and okcore.h:369:
     *
     *     int RNG2(uint8_t *dest, unsigned size)
     *
     * But tweetnacl.c:88 and justhashtweetnacl.c:86 both declare:
     *
     *     extern int RNG2(u8 *,u8);   //Max size 255
     *
     * C has no overloading, so both resolve to the one symbol: the caller
     * passes an 8-bit value and the callee reads a 32-bit one.
     *
     * The Microsoft x64 ABI leaves the upper bits of a narrow argument
     * explicitly undefined, so on Windows `size` was 32 in its low byte and
     * whatever was already in the register above that. RNG2 then handed that
     * to RNG.rand(dest, size) over crypto_box_keypair's 32-byte buffer - the
     * 12-webauthn-tunnel crash. A smashed stack is also why nothing could
     * report the fault: exception dispatch itself needs a sane stack, so
     * neither the vectored handler nor the SEH frame ever ran. Traced by
     * console bisect: "A set_time returned" and "B memset done" both print,
     * RNG2's own "Generating random number of size" never does.
     *
     * EVERY TARGET, not just Windows. It was first scoped to win32 on the
     * grounds that the other builds were correct "by ABI" - but that was
     * expedient, not right (d288871): the SysV x86-64 ABI and AAPCS64 leave
     * the upper bits of a narrow argument unspecified too. That gcc and clang
     * happen to widen at the call site today is a code-generation habit, not a
     * contract the callee may rely on. Matching the declaration to the
     * definition costs nothing on any target; upstream it is a one-word fix.
     */
    file: 'libraries/tweetnacl/tweetnacl.c',
    edits: [
      ['extern int RNG2(u8 *,u8); //Max size 255',
       'extern int RNG2(u8 *,unsigned); /* must match okcore.cpp:7630 - see stage.js */'],
    ],
  },
  {
    /* The same declaration, the same reason. See the tweetnacl entry above. */
    file: 'libraries/justhashtweetnacl/justhashtweetnacl.c',
    edits: [
      ['extern int RNG2(u8 *,u8); //Max size 255',
       'extern int RNG2(u8 *,unsigned); /* must match okcore.cpp:7630 - see stage.js */'],
    ],
  },
  {
    /*
     * Declarations that disagree with their definitions - the MSVC ABI only.
     *
     * The MSVC ABI mangles a global variable's TYPE and LINKAGE into its
     * symbol; the Itanium ABI used on ARM, Linux and Android mangles neither,
     * so a global's symbol is just its name and a wrong declaration still
     * links. These are the ones lld-link caught, each verified against the
     * built objects with llvm-nm rather than assumed:
     *
     *   KeyboardLayout   defined  B KeyboardLayout        C linkage
     *   keyboard_buffer  defined  B keyboard_buffer       C linkage
     *   setBuffer        defined  B setBuffer             C linkage
     *   Profile_Offset   defined  B ?Profile_Offset@@3HA  C++, and it is INT
     *   outputmode       defined  B ?outputmode@@3HA      C++, and it is INT
     *
     * okpqc.cpp carries a comment about exactly this hazard: a
     * packet_buffer_details declared uint32_t against a uint8_t definition
     * gave the wrong stride and produced two confirmed hardware failures. Same
     * class of defect; this time a linker found it first.
     *
     * node-win32 only: on an Itanium target the linkage spelling changes no
     * symbol, and these all belong upstream, where fixing them costs nothing
     * on any target and removes a real trap.
     */
    targets: ['node-win32'],
    file: 'libraries/onlykey/okcrypto.cpp',
    edits: [
      /*
       * setBuffer is declared inside a function at :855, and a linkage
       * specification may only appear at namespace scope - `extern "C"` there
       * is a syntax error. Declaring it once up here instead is enough: the
       * block-scope `extern` at :855 then redeclares an entity that already
       * has C linkage and inherits it, so that line needs no edit at all.
       * (v0.2-beta.8 declares that block-scope one [8] against a [9]
       * definition; its version script corrects it, node-win32 only.)
       */
      ['extern uint8_t keyboard_buffer[KEYBOARD_BUFFER_SIZE];',
       'extern "C" uint8_t keyboard_buffer[KEYBOARD_BUFFER_SIZE];  /* C linkage: stage.js */\n'
       + 'extern "C" uint8_t setBuffer[9];  /* ditto; declared in-function at :855 */'],
      /*
       * There was an `outputmode` edit here, and it is GONE because upstream
       * carries it: okcrypto.cpp declared it `extern uint8_t` against
       * okcore.cpp's `int`, and libraries HEAD already reads
       * `extern int outputmode;` at :174. A patch upstream has absorbed is
       * one fewer thing that can un-apply.
       */
    ],
  },
  {
    /* Same table as the okcrypto.cpp entry above: keylayouts.c is C. */
    targets: ['node-win32'],
    file: 'libraries/onlykey/okcore.cpp',
    edits: [
      ['extern uint8_t KeyboardLayout[1];',
       'extern "C" uint8_t KeyboardLayout[1];  /* keylayouts.c is C - stage.js */'],
    ],
  },
  /*
   * Profile_Offset and outputmode are NOT retyped. Entries once rewrote their
   * `extern uint8_t` declarations (password.cpp, the sketch) to int, to match
   * the int definition under MSVC mangling. That changed what the firmware
   * reads (a -42 Profile_Offset is 214 through the shipped uint8_t view), and
   * it broke the 2.1 line outright: there the DEFINITION is uint8_t, so the
   * retyped declarations named an int nobody defines. The /alternatename
   * fallbacks in src/ok_hal.cpp now resolve a uint8_t view to an int
   * definition where one exists, and every tree keeps the declarations it
   * shipped with.
   */
  {
    targets: ['node-win32'],
    file: 'sketch/OnlyKey.ino',
    edits: [
      ['extern uint8_t KeyboardLayout[1];',
       'extern "C" uint8_t KeyboardLayout[1];  /* keylayouts.c is C - stage.js */'],
    ],
  },
  {
    /*
     * okpqc.cpp declares firmware globals without extern "C".
     *
     * Lines 49-70 declare rsa_private_key, large_buffer_offset, outputmode and
     * friends as plain C++ externs. Some definitions in okcore.cpp have C
     * linkage, so the names do not match - but only on an ABI that MANGLES
     * VARIABLES. Itanium does not, so ARM, Linux and Android link this
     * happily. MSVC does, and lld-link reports what was always true:
     *
     *     undefined symbol: int large_buffer_offset
     *       referenced by okpqc.obj          (?large_buffer_offset@@3HA)
     *       defined in    okcore.obj          (large_buffer_offset)
     *
     * okpqc.cpp is newer than every release up to v3.0.4; main() declares it
     * absent for pinned trees whose script does not say `hasOkpqc`.
     */
    targets: ['node-win32'],
    file: 'libraries/onlykey/okpqc.cpp',
    edits: [
      /*
       * ONLY these two. The definitions in okcore.cpp are not consistent with
       * one another - llvm-nm on the built objects says so plainly:
       *
       *   large_buffer_offset    B large_buffer_offset         <- C linkage
       *   CRYPTO_AUTH            B CRYPTO_AUTH                 <- C linkage
       *   outputmode             B ?outputmode@@3HA            <- C++
       *   large_buffer           D ?large_buffer@@3PEAEEA      <- C++
       *   ... and six more, all C++
       *
       * so a blanket extern "C" over the whole block only moves the failure
       * to the other eight. Each declaration has to match the linkage of the
       * definition it names, and these are the two that are C.
       */
      [['extern int      large_buffer_offset;',
        'extern int large_buffer_offset;'],    // 3.1.0: single spaces
       'extern "C" int  large_buffer_offset;   /* C linkage: see stage.js */'],
      [['extern uint8_t  CRYPTO_AUTH;',
        'extern uint8_t CRYPTO_AUTH;'],        // 3.1.0: single spaces
       'extern "C" uint8_t CRYPTO_AUTH;        /* C linkage: see stage.js */'],
    ],
  },
  {
    /*
     * OnlyKey.ino provides newlib syscall stubs - _getpid, _kill, _write - so
     * that a bare-metal link resolves them. Nothing in the firmware calls any
     * of them; they exist to satisfy newlib.
     *
     * Against the UCRT _write collides outright:
     *
     *     lld-link: error: duplicate symbol: _write
     *       defined at .stage/sketch/OnlyKey.ino:246
     *       defined at libucrt.lib(write.obj)
     *
     * This is the same shape as the recvmsg collision binding.gyp describes -
     * firmware written for a freestanding target reusing names libc owns. On
     * Linux -Bsymbolic resolves it at link time and bionic has no such
     * symbol; the Windows toolchain has no equivalent, so the fix is to stop
     * defining the symbol there.
     *
     * Renamed rather than deleted, so the stub stays visible next to its two
     * siblings and nothing looks mysteriously absent.
     */
    targets: ['node-win32'],
    file: 'sketch/OnlyKey.ino',
    edits: [
      [['  int _write(){return -1;}',
        'int _write() { return -1; }'],        // 3.1.0: no indent, spaced
       '  int okemu_unused_write(){return -1;}  /* renamed: see stage.js */'],
    ],
  },

  /*
   * THE ONLY PATCH HERE THAT ADDS A CAPABILITY, and it is deliberate.
   *
   * Everything else in this array exists to make the firmware COMPILE hosted.
   * This one gives the host a way to PRESS A BUTTON without emulating a
   * finger, which the hardware has no equivalent of, so it is called out
   * rather than slipped in among the compile fixes.
   *
   * Why it earns the exception: a sensed press costs fourteen scheduler
   * periods, because a sense round only happens when SoftTimer runs
   * checkKey() and `#define TIME_POLL 50`. Measured at 757-855ms for ONE
   * press, which made entering a seven-digit PIN a five-second act and made
   * the pad feel broken. Handing a press over directly costs one round.
   *
   * THIS IS NOT THE FIRMWARE'S DEBUG CONSOLE. The old "1#128\n" parser is
   * behind `#ifdef DEBUG` and reads a Serial channel a production build does
   * not compile, so on a production build every press through it - and every
   * GUI control built on one - did nothing at all. This line is compiled
   * unconditionally and runs on a firmware staged exactly as it ships, which
   * is what lets DEBUG default to OFF. okemu_press_take() is declared in
   * shim/okemu_prelude.h, which is force-included into every firmware
   * translation unit, so okcore.cpp gains no #include either.
   *
   * The anchor is the dispatch itself, kept to ONE line on purpose: it is
   * byte-identical, unique in the file, and at conditional-compilation depth
   * zero in all nine pinned versions and in the working tree. The line AFTER
   * it is none of those - `onlykeyhw==OK_HW_DUO` does not exist on the 2.1
   * line - so a longer anchor would break the older half of the matrix.
   *
   * key_press and key_off are function-local statics inside
   * touch_sense_loop(), which is why the hand-over happens in here and why
   * they are passed by pointer. It also means it happens on the FIRMWARE
   * THREAD, so writing an int that the same thread is about to read is safe.
   */
  {
    file: 'libraries/onlykey/okcore.cpp',
    edits: [
      [['\tif ((key_press > 0) && (key_off > 2)) {',
        '    if ((key_press > 0) && (key_off > 2)) {'],   // 3.1.0: four spaces
       '\t/* Injected by scripts/stage.js - see src/okemu_press.h.\n' +
       '\t   Hands over a queued press when the loop is not already holding\n' +
       '\t   one; does nothing when nothing is queued. */\n' +
       '\tokemu_press_take(&button_selected, &key_press);\n' +
       '\tif ((key_press > 0) && (key_off > 2)) {'],
    ],
  },
];

/* ------------------------------------------------ staging a RELEASED version
 *
 *     OKEMU_VERSION=v3.0.4 npm run stage
 *
 * The commits come from node-onlykey-lib/versions (ok-versions.json), which
 * pins `libraries` and `OnlyKey-Firmware` per release; everything else a
 * release needs comes from its own script in scripts/versions/. This is what
 * makes the version matrix possible: node-onlykey-lib branches on firmware
 * version in a dozen places, and an emulator built only from current firmware
 * can only ever prove the current generation.
 *
 * ## It never touches the source repositories
 *
 * Not `git checkout`, which would move HEAD in a tree this project must not
 * write to. `ls-tree` and `cat-file` read the OBJECT DATABASE and leave the
 * working tree exactly as it was. The sources are unpacked into
 * .stage-src/<version>/, inside our own write scope, and cached so a rebuild
 * does not re-extract.
 */
const VERSION = process.env.OKEMU_VERSION || null;

const versions = require('./versions');
/*
 * SOFT-KEY FIRMWARE PLUGINS (owner, 2026-10-01): experimental firmware
 * features, each in its own folder, staged in only when asked for -
 *   OKEMU_PLUGINS=hello npm run rebuild
 * They come from emulator/plugins/ (the `hello` demo lives there), or from any
 * folder named by OKEMU_PLUGINS_DIR (ok-rn keeps the plugins it ships in
 * ok-rn/android/okemu/plugins/); nothing here depends on ok-rn. Without
 * OKEMU_PLUGINS this is the emulator it always was. The loader is the
 * library's, one copy for every stager (node-onlykey-lib/cli/firmware-plugins).
 */
const firmwarePlugins = require('node-onlykey-lib/cli/firmware-plugins');
const PLUGINS = firmwarePlugins.selected();
const PLUGINS_DIR = process.env.OKEMU_PLUGINS_DIR
  ? path.resolve(process.env.OKEMU_PLUGINS_DIR)
  : path.join(EMU, 'plugins');

/*
 * Where an APP that bundles the firmware wants its build record - ok-rn's
 * src/generated/, read by its login screen and its e2e suite. Unset for the
 * Node addon, which records itself in .stage/build.json alone.
 */
const APP_OUT = process.env.OKEMU_APP_OUT ? path.resolve(process.env.OKEMU_APP_OUT) : null;

/**
 * Copy one file, retrying a Windows lock.
 *
 * EBUSY here is not a broken build, it is another process holding the file for
 * a moment - a watcher, an indexer, an antivirus scan of a tree that was just
 * rewritten. In ok-rn it took down a matrix sweep twice (once staging v2.1.2,
 * once mid-sweep on .stage/core/kinetis.h), reported as a stage failure with
 * no hint that waiting would have fixed it; both times the very next attempt
 * succeeded. So: a few short retries, then the original error. Synchronous on
 * purpose - everything around it is, and a sweep that pauses 300ms is cheaper
 * than one that dies at version four of eleven.
 */
function retryingLock(fn, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      const transient = e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES');
      if (!transient || i >= attempts) throw e;
      const until = Date.now() + 60 * i;
      while (Date.now() < until) { /* hold: no event loop to await on */ }
    }
  }
}

function copyFileRetrying(src, dst) {
  return retryingLock(() => fs.copyFileSync(src, dst));
}

/*
 * WRITES NEED IT TOO. The emulator's matrix hit exactly this on Windows: EBUSY
 * opening .stage/libraries/onlykey/okcore.cpp for the patch write, twice, each
 * time when the working tree was staged straight after a release - the copy
 * had just landed and something (an indexer, a scanner) still held it. Every
 * write in this script goes through here.
 */
function writeFileRetrying(file, data) {
  return retryingLock(() => fs.writeFileSync(file, data));
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

/**
 * Unpack one commit's tree into `dest`.
 *
 * Two git calls total, not one per file. `ls-tree -r` names every blob and
 * `cat-file --batch` streams all their contents through a single process -
 * which matters because `libraries` is several hundred files, and several
 * hundred process spawns on Windows is a minute of nothing happening.
 */
function materialise(repo, sha, dest) {
  const { execFileSync } = require('child_process');
  const git = (args, opts) => execFileSync('git', ['-C', repo, ...args], {
    maxBuffer: 1 << 30, windowsHide: true, ...opts,
  });

  let listing;
  try {
    listing = git(['ls-tree', '-r', '-z', sha], { encoding: 'utf8' });
  } catch (e) {
    throw new Error(
      `cannot read ${sha} from ${repo}. The commit may not be in this checkout ` +
      `- ok-versions.json pins releases that a fork may not carry.`,
    );
  }

  /* -z gives NUL-terminated records of "<mode> <type> <sha>\t<path>". */
  const entries = [];
  for (const record of listing.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [, type, blob] = record.slice(0, tab).split(/\s+/);
    if (type !== 'blob') continue;      // submodules and trees are not files
    entries.push({ blob, file: record.slice(tab + 1) });
  }
  if (!entries.length) throw new Error(`${sha} in ${repo} has no files`);

  const batch = git(['cat-file', '--batch'], {
    input: entries.map((e) => e.blob).join('\n') + '\n',
    // No encoding: execFileSync then returns a Buffer, which is required because
    // the blobs are binary. Setting it to 'buffer' would also be applied to
    // stdin, where it is not a valid string encoding.
  });

  /*
   * The batch stream is "<sha> <type> <size>\n<contents>\n" per object, and the
   * contents are BINARY - parsed as a Buffer with explicit offsets rather than
   * split on newlines, which would corrupt any file containing one.
   */
  let at = 0;
  for (const entry of entries) {
    const nl = batch.indexOf(0x0a, at);
    const header = batch.slice(at, nl).toString('utf8');
    const size = Number(header.split(' ')[2]);
    const start = nl + 1;

    const target = path.join(dest, entry.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileRetrying(target, batch.slice(start, start + size));

    at = start + size + 1;              // trailing newline after each object
  }
  return entries.length;
}

/**
 * Point FW and LIB_SRC at a released version's sources.
 *
 * Cached by commit, so switching back and forth across a matrix run costs one
 * extraction each rather than one per build.
 */
function materialiseVersion(release) {
  const { version, pins } = release;
  const out = {};

  for (const [repo, sha] of [
    ['OnlyKey-Firmware', pins['OnlyKey-Firmware']],
    ['libraries', pins.libraries],
  ]) {
    const dest = path.join(VERSION_CACHE, version, repo);
    const stamp = path.join(dest, '.commit');

    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === sha) {
      out[repo] = dest;
      console.log(`stage: ${repo}@${sha} already unpacked`);
      continue;
    }

    rmrf(dest);
    fs.mkdirSync(dest, { recursive: true });
    const count = materialise(path.join(CHECKOUTS, repo), sha, dest);
    writeFileRetrying(stamp, sha + '\n');
    out[repo] = dest;
    console.log(`stage: ${repo}@${sha} unpacked, ${count} files`);
  }

  FW = out['OnlyKey-Firmware'];
  LIB_SRC = out.libraries;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else copyFileRetrying(s, d);
  }
}

/** The first line of a pattern, so an error about one stays readable. */
const firstLine = (s) => String(s).split(/\r?\n/)[0].trim();

/**
 * Apply PATCHES, then `extra` (the release's own patches and the gate-dependent
 * ones), to the STAGED tree.
 *
 * They are applied on the same terms as the rest: a file that is not there,
 * or a pattern that does not match, is an ERROR. That is the point of one
 * script per release - the script names the release, so its patches are known
 * to belong to it and a miss means the pins moved under it.
 *
 * @param extra   patches applied after the base ones
 * @param absent  `from` patterns (or file paths) this release declares its
 *                tree does not contain
 */
function applyPatches(extra = [], absent = []) {
  let applied = 0, missing = 0, expected = 0, skipped = 0;
  const patches = [...PATCHES, ...extra];
  /*
   * SOME BASE PATCHES DO NOT APPLY TO EVERY RELEASE, and for an old enough
   * tree that is a fact about the release rather than a fault.
   *
   * The 2019 beta line has no `factorysectoradr` in okcore.h and no
   * `end_byte` span in ctap_parse.cpp: the first arrived later, the second
   * belongs to a fido2 library that release predates; okpqc.cpp exists in no
   * release before v3.1.0. A base patch written against the 3.0 line finds
   * none of them, and failing the whole stage for it would mean the matrix can
   * never reach back past the oldest tree that happens to contain every
   * pattern.
   *
   * So a release may DECLARE a file or pattern absent. Declared-absent is
   * counted and reported - it is not silence. And one declared absent that
   * turns out to be PRESENT throws, because the declaration has gone stale and
   * the tree would be built unpatched on the strength of it.
   */
  const declaredAbsent = new Set(absent);
  const seen = new Set();
  for (const p of patches) {
    /*
     * Not for this TARGET. Still counted as LOOKED FOR: a release declares
     * absent what any target's patch wants, and the stale-declaration check
     * below must not fire on one target over another target's patch.
     */
    const targets = patchTargets(p);
    if (targets && !targets.includes(TARGET)) {
      seen.add(p.file);
      for (const [fromSpec] of p.edits) {
        seen.add(Array.isArray(fromSpec) ? fromSpec[0] : fromSpec);
      }
      skipped++;
      continue;
    }
    const target = path.join(STAGE, p.file);
    if (!fs.existsSync(target)) {
      if (declaredAbsent.has(p.file)) {
        console.log(`stage: ${p.file} is absent at this pin, as its release says`);
        seen.add(p.file);
        expected++;
        continue;
      }
      console.error(`stage: WARNING - patch file absent: ${p.file}`);
      missing++;
      continue;
    }
    let text = fs.readFileSync(target, 'utf8');
    for (const [fromSpec, to] of p.edits) {
      /*
       * A checkout cloned on Windows stages with CRLF while the patterns are
       * written with LF. Try the pattern as written, then with CRLF line
       * endings, and keep whichever matches - a patch that silently fails to
       * apply is worse than one that errors.
       *
       * `from` may also be a LIST of spellings of the same line, tried in
       * order. Release 3.1.0 re-indented and re-spaced the sources (a tab
       * became four spaces in touch_sense_loop(), "Serial.println ((" became
       * "Serial.println((") while every older release still spells them the
       * old way. Each spelling stays exact - a loose whitespace match could
       * land a patch where it was never meant to go - and the FIRST names the
       * edit, for absentPatterns and the warnings.
       */
      const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
      const froms = Array.isArray(fromSpec) ? fromSpec : [fromSpec];
      const from = froms[0];
      let from2 = null;
      for (const cand of froms) {
        if (text.includes(cand)) { from2 = cand; break; }
        if (text.includes(crlf(cand))) { from2 = crlf(cand); break; }
      }
      if (from2 === null) {
        if (declaredAbsent.has(from)) {
          seen.add(from);
          expected++;
          continue;
        }
        console.error(
          `stage: WARNING - pattern not found in ${p.file}: ${firstLine(from)}` +
          ' | if this release predates it, list that line in the version ' +
          "script's `absentPatterns`");
        missing++;
        continue;
      }
      if (declaredAbsent.has(from)) {
        throw new Error(
          `stage: ${p.file} DOES contain a pattern its release declares ` +
          `absent: ${firstLine(from)} | remove it from absentPatterns - the ` +
          'tree would be left unpatched on the strength of a stale claim');
      }
      text = text.split(from2).join(from2.includes('\r\n') ? crlf(to) : to);
      applied++;
    }
    writeFileRetrying(target, text);
  }
  for (const declared of declaredAbsent) {
    if (!seen.has(declared)) {
      throw new Error(
        'stage: this release declares a pattern absent that no patch looks ' +
        `for: ${firstLine(declared)} | either a typo, or the patch it ` +
        'belonged to has gone');
    }
  }
  if (expected) {
    console.log(`stage: ${expected} patch edit(s) absent at this pin, as declared`);
  }
  if (skipped) {
    console.log(`stage: ${skipped} patch(es) scoped to other targets, not applied for ${TARGET}`);
  }
  if (missing) {
    console.error('stage: a patch did not apply - upstream may have changed. Review PATCHES.');
    process.exitCode = 1;
  }
  return applied;
}

/*
 * Rewrite the register blocks out of the staged sources - NO FIXED ADDRESSES.
 *
 * Every register in kinetis.h is a literal absolute address:
 *
 *     #define FTFL_FSEC  (*(const uint8_t *)0x40020002)
 *     #define SYST_CVR   (*(volatile uint32_t *)0xE000E018)
 *
 * The emulator used to mmap those windows at their real addresses, which is
 * a bet against whatever the host runtime put there first - and it was lost
 * every way it could be: the bit-band alias collided with V8's heap and
 * crash-looped the Node daemon; 0xE0000000 is kernel-only on 32-bit ARM; and
 * on a moto g 5G (2023, Android 14) ART's large object space covers
 * 0x40000000, so the soft key could not start at all (2026-09-26). So both
 * blocks are ordinary arrays (src/okemu_regs.cpp) and every register is
 * redirected into them: the arithmetic still resolves at compile time against
 * the array, so the generated code is the same shape it always was.
 *
 * ONE PATTERN FOR EVERY SHAPE. Register casts come as `volatile`/`const`,
 * with uneven spacing (`uint8_t  *`), as struct types (KINETIS_MCG_t), as the
 * DMA `volatile const void * volatile *`, and inside the NVIC macros that do
 * pointer arithmetic on a bare cast. So this matches the CAST,
 * `(<type> *)0xAAAAAAAA`, wherever it appears, and wraps only the literal:
 *
 *     (*(const uint8_t *)0x40020002)   ->  (*(const uint8_t *)OKEMU_PBRIDGE(0x40020002))
 *     ((volatile uint32_t *)0xE000E100 + n)  ->  ((volatile uint32_t *)OKEMU_SCS(0xE000E100) + n)
 *
 * Blanket, not targeted: only ~15 registers are really used, but a future
 * firmware revision reaching a new one must not fault on some host.
 *
 * And then CHECKED. Anything that still casts a bridge or system-block
 * literal afterwards - in kinetis.h or in any staged source, the stock Arduino
 * libraries included - fails the stage, so a new raw hardware address breaks
 * the BUILD rather than a host that happens to have something mapped there.
 * okcore.h's CPU_RESTART_ADDR was one such literal outside kinetis.h, and it
 * crashed the Android app until it was found (see PATCHES).
 *
 * A header's own #define always wins over anything predefined from outside, so
 * this cannot be done with -D or a force-included shim. Patching the staged
 * copy is the only lever, exactly as it is for the CPSID asm above.
 */
const REGISTER_BLOCKS = [
  { name: 'peripheral bridge', base: 0x40000000, len: 0x00100000,
    macro: 'OKEMU_PBRIDGE', array: 'okemu_pbridge_base' },
  { name: 'system block', base: 0xE0000000, len: 0x00100000,
    macro: 'OKEMU_SCS', array: 'okemu_scs_base' },
];

/* `(<type> *)0xAAAAAAAA` - a type that starts with a name and ends in `*`,
 * with anything but parentheses between (spaces, const, `* volatile`). */
const CAST_LITERAL = /\(([A-Za-z_][^()]*?\*)\)\s*(0x[0-9A-Fa-f]{8})\b/g;

function registerBlockFor(address) {
  return REGISTER_BLOCKS.find(b => address >= b.base && address < b.base + b.len);
}

/* Casts of a block address still left in `text` (comment lines skipped). */
function rawRegisterCasts(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\/?\*)/.test(line)) return;
    for (const m of line.matchAll(CAST_LITERAL)) {
      if (registerBlockFor(parseInt(m[2], 16))) hits.push({ line: i + 1, text: line.trim() });
    }
  });
  return hits;
}

function rewriteRegisterBlocks() {
  const target = path.join(STAGE_CORE, 'kinetis.h');
  let text = fs.readFileSync(target, 'utf8');

  const counts = Object.fromEntries(REGISTER_BLOCKS.map(b => [b.name, 0]));
  const rebase = (whole, type, addr) => {
    const block = registerBlockFor(parseInt(addr, 16));
    if (!block) return whole;       /* 0xF8.. / 0xF0003.. : Teensy LC only */
    counts[block.name]++;
    return `(${type})${block.macro}(${addr})`;
  };
  text = text.replace(CAST_LITERAL, rebase);

  for (const b of REGISTER_BLOCKS) {
    if (!counts[b.name]) {
      console.error(`stage: WARNING - no ${b.name} registers rewritten`);
      process.exitCode = 1;
      return counts;
    }
  }

  /*
   * The macros have to be visible before the first use. kinetis.h opens with an
   * include guard; put the declarations immediately after it so every consumer
   * of the header gets them, in whatever order they include things.
   *
   * Matched as a regex rather than a literal: checkouts cloned on Windows
   * carry CRLF, and a multi-line literal would silently fail to match.
   *
   * The address arithmetic goes through uintptr_t, not `unsigned long`: on
   * LLP64 (Windows) long is 32 bits, and the integer that becomes a pointer
   * must be pointer-sized on every target. #ifndef-guarded because src/ok_hal.h
   * defines the same two macros for the HAL's own register accesses, and a
   * translation unit may see both.
   */
  const anchor = /#ifndef\s+_kinetis_h_\r?\n#define\s+_kinetis_h_\r?\n/;
  if (!anchor.test(text)) {
    console.error('stage: WARNING - kinetis.h include guard not where expected');
    process.exitCode = 1;
    return counts;
  }
  const decl =
    '\n/* Injected by scripts/stage.js - see rewriteRegisterBlocks(). */\n' +
    '#ifdef __cplusplus\nextern "C" {\n#endif\n' +
    REGISTER_BLOCKS.map(b => `extern unsigned char ${b.array}[0x${b.len.toString(16).toUpperCase()}];\n`).join('') +
    /* Bit-band: nothing compiled uses it, and there is no alias region any
     * more. Declared, never defined - see the avr_emulation.h / ADC patches. */
    'extern unsigned long okemu_bitband_unsupported(void);\n' +
    '#ifdef __cplusplus\n}\n#endif\n' +
    REGISTER_BLOCKS.map(b =>
      `#ifndef ${b.macro}\n` +
      `#define ${b.macro}(a) ((void *)(${b.array} + ((uintptr_t)(a) - 0x${b.base.toString(16).toUpperCase()}UL)))\n` +
      '#endif\n').join('') +
    '\n';
  text = text.replace(anchor, (m) => m + decl);
  writeFileRetrying(target, text);

  /*
   * EVERY STAGED SOURCE, not just kinetis.h. Libraries carry their own copies
   * of register definitions: the first run of the check below found
   * InternalTemperature.h defining SIM_SDID as a raw
   * `*(const uint32_t *)0x40048024`. Nothing includes it today - which is
   * exactly the kind of assumption this removes. They all see the macros
   * through kinetis.h (every Arduino translation unit includes it); a file
   * that did not would fail to COMPILE, which is the safe direction.
   *
   * The stock ADC and EEPROM libraries are staged (main(), step 5a), so they
   * are walked, rewritten and checked here like everything else, rather than
   * only checked in the shared Arduino install.
   */
  const sources = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (/\.(c|cpp|h|hpp|ino)$/i.test(ent.name) && full !== target) sources.push(full);
    }
  };
  walk(STAGE_CORE);
  walk(STAGE_LIB);
  walk(STAGE_SKETCH);
  for (const full of sources) {
    const before = fs.readFileSync(full, 'utf8');
    const after = before.replace(CAST_LITERAL, rebase);
    if (after !== before) writeFileRetrying(full, after);
  }

  /* The check: anything still casting a block address fails the stage. */
  const leftovers = rawRegisterCasts(text).map(h => `core/kinetis.h:${h.line}: ${h.text}`);
  for (const full of sources) {
    for (const h of rawRegisterCasts(fs.readFileSync(full, 'utf8'))) {
      leftovers.push(`${path.relative(STAGE, full)}:${h.line}: ${h.text}`);
    }
  }
  if (leftovers.length) {
    console.error('stage: ERROR - a raw hardware register address survived the rewrite.\n' +
      '  The soft key must not depend on a fixed address (it collides with the\n' +
      '  host runtime). Rebase these onto OKEMU_PBRIDGE / OKEMU_SCS:\n' +
      leftovers.slice(0, 20).map(l => `    ${l}`).join('\n'));
    process.exitCode = 1;
  }
  return counts;
}

/*
 * Remove Arduino's Time.h from the include path.
 *
 * The Time library ships two headers: TimeLib.h, which has the content, and
 * Time.h, which is one line - `#include "TimeLib.h"`. Its directory has to be
 * on the include path because the firmware includes "Time.h" from several
 * places.
 *
 * On a case-insensitive filesystem - Windows and macOS both - that makes
 * `#include <time.h>` resolve to Arduino's Time.h rather than the C library's,
 * because -I directories are searched before the sysroot. struct timespec then
 * never gets declared, <ctime> finds none of the C time functions, and every
 * file in the HAL that sleeps or reads the clock fails to compile. Linux never
 * sees this, which is why this built there for years and not on Windows.
 *
 * Deleting the one-line shim and pointing its consumers straight at TimeLib.h
 * removes the collision for good rather than per-file. Done on every target:
 * the result is identical code, and a per-host spelling would mean the trees
 * drift.
 */
function defuseTimeHeader() {
  const shim = path.join(STAGE_LIB, 'Time', 'Time.h');
  if (fs.existsSync(shim)) fs.rmSync(shim);

  let rewritten = 0;
  const re = /(#\s*include\s*)(["<])Time\.h([">])/g;

  const walkAll = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walkAll(p); continue; }
      if (!/\.(c|cpp|h|hpp|ino)$/.test(ent.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (!re.test(text)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      writeFileRetrying(p, text.replace(re, '$1$2TimeLib.h$3'));
      rewritten++;
    }
  };
  walkAll(STAGE);
  return rewritten;
}

/**
 * Rename Crypto/SHA256.h out of the way, the way upstream later did.
 *
 * THE 2019 TREE HAS TWO HEADERS WHOSE NAMES DIFFER ONLY IN CASE:
 * `Crypto/SHA256.h`, the Arduino Crypto library's C++ class, and
 * `sha256/sha256.h`, Brad Conte's C implementation that defines
 * `SHA256_CTX`. On a case-insensitive filesystem - every Windows checkout -
 * `#include "sha256.h"` from fido2/device.h resolves to whichever directory
 * comes first on the include path, device.h gets the C++ class, and every
 * translation unit that wants SHA256_CTX fails with "unknown type name" (the
 * emulator's Windows matrix, v0.2-beta.8).
 *
 * Upstream hit this too and fixed it the same way: at the current libraries
 * HEAD the file is `Crypto/SHA256_2.h`. This does that rename to the STAGED
 * copy for the releases that predate it, so an old tree builds without
 * anyone editing the checkout.
 *
 * Not a patch entry, because a patch edits text in place and this moves a
 * file and rewrites the includes that name it - the same shape as
 * defuseTimeHeader above, and for the same kind of reason.
 *
 * @returns how many files were repointed, or -1 when there was nothing to do
 */
function renameCryptoSha256() {
  const dir = path.join(STAGE_LIB, 'Crypto');
  if (!fs.existsSync(dir)) return -1;
  /*
   * `existsSync` is case-INSENSITIVE on Windows and answers true for the
   * already-renamed tree too, so the directory listing is the only honest
   * test of which name is really on disk.
   */
  const names = fs.readdirSync(dir);
  if (!names.includes('SHA256.h')) return -1;

  fs.renameSync(path.join(dir, 'SHA256.h'), path.join(dir, 'SHA256_2.h'));
  if (names.includes('SHA256.cpp')) {
    fs.renameSync(path.join(dir, 'SHA256.cpp'), path.join(dir, 'SHA256_2.cpp'));
  }

  let rewritten = 0;
  const re = /(#\s*include\s*)(["<])SHA256\.h([">])/g;
  const walkAll = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, ent.name);
      if (ent.isDirectory()) { walkAll(q); continue; }
      if (!/\.(c|cpp|h|hpp|ino)$/.test(ent.name)) continue;
      const text = fs.readFileSync(q, 'utf8');
      if (!re.test(text)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      writeFileRetrying(q, text.replace(re, '$1$2SHA256_2.h$3'));
      rewritten++;
    }
  };
  walkAll(STAGE);
  return rewritten;
}

/**
 * A digest of everything that actually gets compiled.
 *
 * Taken over the STAGED tree, after the patches, because that is the source
 * the binary is built from - hashing OnlyKey-Firmware instead would describe
 * the inputs and miss every fixup applied on the way in.
 *
 * Path is hashed alongside content so that moving a file changes the digest,
 * and the walk is sorted so the answer does not depend on readdir order.
 * build.json is excluded: it is written after this, and describes the tree
 * rather than being part of it.
 */
function digestStage() {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  const files = [];

  (function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const here = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(full, here);
      else if (here !== 'build.json') files.push([here, full]);
    }
  })(STAGE, '');

  for (const [rel, full] of files) {
    hash.update(rel);
    hash.update(fs.readFileSync(full));
  }
  return { digest: hash.digest('hex').slice(0, 12), files: files.length };
}

/** Short HEAD of a checkout, or null when it is not a repo. */
function gitShort(dir) {
  try {
    return require('child_process')
      .execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      .trim();
  } catch (_) {
    return null;
  }
}

/*
 * SIDE-LOADED PLUGIN TESTS (owner, 2026-10-01): a plugin's on-device tests live
 * in its own folder (plugins/<name>/tests/e2e.js) and leave with it. Metro
 * bundles statically and only inside the app, so each staged plugin's test is
 * COPIED to <OKEMU_APP_OUT>/plugins/ (the folder may be outside the app) and
 * listed beside firmware.json - an empty list for the base build. ok-rn's
 * softKeyPlugins e2e suite runs whatever it names.
 *
 * Only for an app build (OKEMU_APP_OUT set): the Node addon's kit side-loads
 * each plugin's tests itself, from build.json's pluginsDir.
 */
function writePluginTests(names) {
  const out = APP_OUT;
  const copies = path.join(out, 'plugins');
  fs.rmSync(copies, { recursive: true, force: true });
  fs.mkdirSync(copies, { recursive: true });
  const rows = names
    .filter((n) => fs.existsSync(path.join(PLUGINS_DIR, n, 'tests', 'e2e.js')))
    .map((n) => {
      copyFileRetrying(path.join(PLUGINS_DIR, n, 'tests', 'e2e.js'), path.join(copies, `${n}.e2e.js`));
      return `  { name: '${n}', register: require('./plugins/${n}.e2e.js') },\n`;
    });
  writeFileRetrying(path.join(out, 'pluginTests.js'),
    "/* Written by scripts/stage.js - the staged plugins' e2e tests. */\n"
    + 'module.exports = [\n' + rows.join('') + '];\n');
}

/*
 * The app's build record, <OKEMU_APP_OUT>/firmware.json - only for an app build.
 *
 * Written where the app can import it, because ok-rn's login screen leads with
 * "which firmware is this actually running" and a version that is guessed is
 * worse than none. Generated rather than committed: a checkout that has never
 * staged reports 'unknown' instead of somebody else's hash.
 */
function writeBuildInfo(stats, release, debugOn, stdEdition, duoModel, pluginNames,
                        slotPlugins, enforcingOrigins, declaredVersion) {
  const out = APP_OUT;
  fs.mkdirSync(out, { recursive: true });
  const pins = release.pins;
  const info = {
    digest: stats.digest,
    files: stats.files,
    /*
     * For a pinned build the shas come from ok-versions.json, not from
     * gitShort() - the unpacked sources are a plain directory with no .git, so
     * asking it would answer about the wrong repository or not at all.
     */
    firmware: pins ? pins['OnlyKey-Firmware'] : gitShort(FW),
    libraries: pins ? pins.libraries : gitShort(LIB_SRC),
    /*
     * The RELEASE name, or null for the working tree - which is a version
     * script like any other but is not a released version, and the app must
     * not report it as one. ok-rn's src/buildInfo.ts turns this into the
     * storage slot.
     */
    version: release.pins ? release.version : null,
    /*
     * What the SOURCES call themselves, e.g. "v3.1.0" - see
     * readDeclaredVersion(). Present for a pinned build too, where it should
     * agree with `version`; a disagreement there means ok-versions.json pins a
     * commit that is not the release it claims, which is worth seeing.
     */
    declaredVersion,
    /**
     * Whether this build is AHEAD of every release, rather than being one.
     *
     * The same fact as `version: null`, named so a caller does not have to
     * infer provenance from an absence - and, more importantly, so it can be
     * told apart from "no staging metadata at all". buildInfo coalesces a
     * missing file to `{}`, where `version` would also read null; an explicit
     * flag lets that case default to "released" rather than claim to be an
     * unreleased tree and switch on features that may not exist.
     *
     * It exists because the wire cannot answer this. A working tree reports
     * whatever onlykey.h's version macros say, which is the same string the
     * release of that number will report: the macros read 3/0/4 from 2022
     * until 2026-09, so a tree built as production answered v3.0.4-prodc -
     * byte-identical to the release it was ahead of, while carrying
     * post-quantum work no release had. The build keyword used to separate
     * the two lines and no longer can, now that both build production.
     *
     * `declaredVersion` records that string rather than replacing this flag:
     * it says which number the sources claim, and this says whether the claim
     * has been released yet. Neither answers the other.
     */
    unreleased: !release.pins,
    production: !debugOn,
    /**
     * 'standard' or 'travel'. The IN TRVL edition compiles out set_private,
     * U2Finit and the encrypted profile, so a host talking to one sees a device
     * that refuses most of what it knows how to ask for.
     */
    edition: stdEdition === null ? null : stdEdition ? 'standard' : 'travel',
    /**
     * The model this build reports as. A DUO is 24 slots across 4 profiles
     * with 3 buttons and a PIN carried in the message body rather than pressed
     * on the device, so a host that reads this wrong gets all of that wrong.
     */
    model: duoModel ? 'duo' : 'classic',
    /**
     * Soft-key firmware plugins staged into this build. Only present when
     * there are any: ok-rn's compatibility treats each one as a soft-key-only
     * feature (src/buildInfo.ts), never a firmware version's.
     */
    ...(pluginNames.length ? { plugins: pluginNames } : {}),
    /* the fixes carried on top of the pins, as build.json says them - the release manifest checks each app's against the hex's */
    fixes: release.fixes || [],
    /**
     * The plugins the storage slot is named after: those that keep state of
     * their own. A stateless plugin (key_chain) joins or leaves a build without
     * moving the soft key to another, empty slot.
     */
    ...(pluginNames.length ? { slotPlugins } : {}),
    /**
     * Whether webcryptcheck() actually consults the trusted-origin table and
     * the field 31 policy, rather than returning 2 for everything.
     *
     * Recorded because it is invisible from the wire in the permissive
     * direction: an ordinary debug build SERVES every origin and every
     * stored-key request, so a suite that expects a refusal and gets service
     * cannot tell "the firmware does not enforce this" from "this build was
     * not asked to". True on any production build, where the return is not
     * compiled at all.
     */
    enforcingOrigins,
    /**
     * ok-rn's debugging lock (debugGuard.consentRefusal: no approve or press
     * while adb is on). OFF only when the build asks for it -
     * OKRN_DEBUG_LOCK=off - for a TEST build Brad uses with adb left on
     * (2026-10-05: "disable that check, and turn it back before we sign a
     * pre-release"). The app shows a red banner then, and release.js will not
     * package a pre-release from such a build. Anything else: the lock is on.
     */
    debugLock: process.env.OKRN_DEBUG_LOCK !== 'off',
    stagedAt: new Date().toISOString(),
  };
  writeFileRetrying(
    path.join(out, 'firmware.json'),
    JSON.stringify(info, null, 2) + '\n',
  );
  return info;
}

/**
 * Say whether the staged tree came out the way this version's script says it
 * did last time.
 *
 * Reported, never fatal. stage.js and the Arduino toolchain are both inputs to
 * that digest, so a change here moves it for every version at once - which is
 * information, not a failure. What it catches is the other case: a pinned
 * version whose digest moved while nothing in this repository did.
 *
 * COMPARED WHEN THE BUILD IS THE ONE THAT SHIPS, however it got there. A
 * recorded digest describes the release as it ships, and a release ships as a
 * production build - the signed images all declare -prod. So the question is
 * not "was a gate forced" but "did the gate end up OFF". Forcing DEBUG ON
 * skips: that tree is four files different from the one the digest was
 * recorded for, so a mismatch would be information nobody asked for.
 *
 * The digest also covers which TARGET's patches were applied, so a recorded
 * value only matches the target it was recorded on.
 */
function checkExpectation(release, stats, debugOn) {
  /* The working tree is not pinned to anything, so nothing about it is fixed. */
  if (!release.pins) return;

  if (debugOn) {
    console.log(
      `stage: digest not compared - this is a DEBUG build, and ` +
      `${release.version}'s recorded digest is for the build as it ships`);
    return;
  }

  if (!release.expect || !release.expect.digest) {
    console.log(
      `stage: ${release.version} has no recorded digest. If this build is ` +
      `good, add  expect: { digest: '${stats.digest}' }  to its script.`);
    return;
  }
  if (release.expect.digest === stats.digest) {
    console.log(`stage: digest matches ${release.version}'s recorded ${stats.digest}`);
  } else {
    console.log(
      `stage: digest CHANGED for ${release.version}\n` +
      `         recorded: ${release.expect.digest}\n` +
      `         now:      ${stats.digest} (${TARGET})\n` +
      `       Expected if stage.js, the target or the toolchain changed. ` +
      `Otherwise the pins moved.`);
  }
}

/**
 * `node scripts/stage.js --list` - what can be staged, and how far each got.
 *
 * Switching versions is one environment variable, so the thing worth printing
 * is which names that variable accepts and what is already known about each,
 * on this TARGET's ladder.
 */
function listVersions() {
  console.log(`OKEMU_VERSION accepts (status for ${TARGET}):\n`);
  for (const name of versions.list()) {
    let release;
    try {
      release = versions.load(name);
    } catch (e) {
      console.log(`  ${name.padEnd(12)} UNLOADABLE  ${e.message.split('\n')[0]}`);
      continue;
    }
    const pins = release.pins
      ? `${release.pins['OnlyKey-Firmware']}/${release.pins.libraries}`
      : '(not cut: builds the checkouts)';
    console.log(
      `  ${name.padEnd(12)} ${String(targetStatus(release)).padEnd(8)} ` +
      `${pins}  ${release.patches.length} version patch(es)`);
    for (const line of String(release.notes).split('\n')) {
      if (line) console.log(`               ${line}`);
    }
  }
  console.log(
    '\n  (unset)      the working tree - OnlyKey-Firmware and libraries as they are\n' +
    '\nStatus is a ladder: blocked < untried < stages < builds < boots < tested.\n' +
    'Each rung is something somebody watched happen. Patches applying is not\n' +
    'linking, and linking is not booting.');
}

/**
 * Throw away compiled objects when the BUILD IDENTITY changes.
 *
 * ## The failure this exists to stop
 *
 * Each firmware version is a different source tree, and the compiled objects
 * from one do not belong to another. Switching back to the working tree after
 * building v3.0.4 produced:
 *
 *     ld.lld: error: undefined symbol: okeeprom_eeset_webcrypt_policy
 *
 * v3.0.4's eeprom object has no such function; a fresh okcore calls it. The
 * build tool tracks timestamps and still got this wrong, because staging
 * rewrites files whose CONTENT is unchanged without disturbing every
 * dependent object.
 *
 * That one failed LOUDLY, which is the lucky case. The dangerous one is a pair
 * of stale objects that happen to link: a silently mixed-version emulator, two
 * firmwares in one binary, and every measurement taken from it attributed to a
 * version that was never built. Nothing downstream could detect it - the
 * digest covers the staged SOURCES, not the objects compiled from them.
 *
 * ## Why here rather than in a caller
 *
 * A matrix runner removing the objects before every build only protects that
 * one caller. Every other route in (a plain npm run build, an IDE, a person
 * switching versions by hand) has to remember. stage.js is where the swap
 * actually happens, so it is where the clean belongs.
 *
 * ## What counts as a swap
 *
 * Not just the version. A v3.0.4 PRODUCTION build and a v3.0.4 DEBUG build are
 * different objects too, as are the standard and travel editions, the two
 * models, the two origin builds, each plugin set and each target - each flips
 * defines or patches the whole tree compiles against. The identity is all of
 * them together, recorded beside the staged tree and compared next time.
 *
 * ## What is removed
 *
 * The node-gyp OBJECTS - build/Release and build/Debug - and the Android
 * build's .cxx / intermediates/cxx. Not the rest of build/: `npm run build` is
 * `stage && node-gyp build` with no configure, so the project files node-gyp
 * configure wrote (config.gypi, the .vcxproj / Makefile) must survive for the
 * next build to run at all. They describe binding.gyp, not the firmware.
 *
 * Unchanged identity leaves the objects alone, so the ordinary edit-and-build
 * loop stays incremental. This costs a full recompile exactly when the
 * alternative is a build that cannot be trusted.
 */
/*
 * ONE IDENTITY PER KIND OF BUILD. The Node addon (node-linux / node-win32) and the Android library
 * keep their objects in different places, and a tree is staged for one and then the other (ok-edge
 * builds its Android app and runs the addon on the desktop from one checkout). A single identity
 * made each a swap for the other and wiped both - an Android build deleted the desktop's .node. So
 * each kind keeps its own marker and drops only its own objects; the other's stay as they were.
 */
const BUILD_KIND = TARGET === 'android' ? 'android' : 'node';
const OBJECT_DIRS = {
  node: [
    path.join(EMU, 'build', 'Release'),          // node-gyp objects + the .node
    path.join(EMU, 'build', 'Debug'),
  ],
  android: [
    path.join(EMU, '.cxx'),                      // an Android (CMake) build
    path.join(EMU, 'build', 'intermediates', 'cxx'),
    path.join(EMU, 'android', '.cxx'),           // emulator/android, the Gradle module
    path.join(EMU, 'android', 'build', 'intermediates', 'cxx'),
  ],
};

function cleanOnSwap(release) {
  const marker = path.join(EMU, `.stage-identity-${BUILD_KIND}`);
  const identity = [
    release.version,
    TARGET,
    WANT_DEBUG ? 'debug' : 'production',
    ENV_STD === null ? 'std-as-staged' : ENV_STD ? 'standard' : 'travel',
    WANT_DUO === null ? 'model-as-staged' : WANT_DUO ? 'duo' : 'classic',
    WANT_ENFORCE ? 'enforcing' : 'trust-all',
    ...(PLUGINS.length ? [`plugins:${PLUGINS.join('+')}`] : []),
  ].join(' ');

  let previous = null;
  try {
    previous = fs.readFileSync(marker, 'utf8').trim();
  } catch (_) {
    /* No marker: either a first build or a tree cleaned by hand. Treat it as a
     * swap - cleaning when nothing needed it costs a rebuild, and NOT cleaning
     * when something did costs a wrong answer. */
  }

  if (previous === identity) return;

  const targets = OBJECT_DIRS[BUILD_KIND];
  let removed = 0;
  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue;
    retryingLock(() => fs.rmSync(dir, { recursive: true, force: true }));
    removed += 1;
  }

  console.log([
    'stage: build identity changed, so compiled objects were dropped',
    '       was:  ' + (previous || '(nothing recorded)'),
    '       now:  ' + identity,
    '       ' + removed + ' object director' + (removed === 1 ? 'y' : 'ies')
      + ' removed - this build is a full recompile',
  ].join(NL));

  fs.mkdirSync(path.dirname(marker), { recursive: true });
  writeFileRetrying(marker, identity + NL);
}

function main() {
  if (process.argv.includes('--list')) return listVersions();

  if (!TARGETS.includes(TARGET)) {
    console.error(`stage: OKEMU_TARGET=${TARGET} - expected one of ${TARGETS.join(', ')}`);
    process.exit(1);
  }

  /*
   * EVERY build has a version script, the working tree included. It is what
   * says which storage slot to use and which patches this particular source
   * tree needs, and having no special case for the default is the point - the
   * edits the current sources need and no release does used to have nowhere to
   * live but an unexplained branch in here.
   *
   * Repoint FW and LIB_SRC BEFORE anything reads them, including the existence
   * check below - so a missing pinned commit fails naming the commit, not the
   * checkout.
   */
  let release;
  try {
    /*
     * A load failure is a message, not a stack trace. Every one of them is
     * something the person running this has to fix by hand - a version with no
     * script, a script that was copied without being renamed, pins that moved
     * under a script's notes - and the message says which.
     */
    release = versions.load(VERSION || versions.WORKING_TREE);
  } catch (e) {
    console.error(`stage: ${e.message}`);
    process.exit(1);
  }
  const status = targetStatus(release);

  /*
   * A release whose script says it cannot be staged FOR THIS TARGET stops
   * here, quoting its own notes. Letting it proceed would produce a tree built
   * from whatever git happened to resolve, under a version number that would
   * then be attached to every measurement taken against it.
   */
  if (status === 'blocked') {
    console.error(`stage: ${release.version} is marked BLOCKED for ${TARGET} in its version script.`);
    console.error(String(release.notes).replace(/^/gm, '  '));
    process.exit(1);
  }

  /*
   * AND IF THE BUILD IDENTITY CHANGED, THROW THE OBJECTS AWAY FIRST.
   * See cleanOnSwap().
   */
  cleanOnSwap(release);
  /* Loaded before anything is staged, so a bad plugin fails before the work. */
  const pluginSet = firmwarePlugins.load(PLUGINS, { dir: PLUGINS_DIR, release });
  const slotPlugins = firmwarePlugins.slotPlugins(pluginSet);

  /*
   * A release may DECLARE the build options it has to be staged with - see
   * versions/index.js, gates. The environment still wins, so a deliberate
   * travel build is one OKEMU_STD=0 away.
   */
  if (ENV_STD === null && release.gates && release.gates.std !== undefined) {
    WANT_STD = release.gates.std;
  }

  if (release.pins) {
    console.log(
      `stage: OKEMU_VERSION=${release.version} - ` +
      `scripts/versions/${release.version}.js, ` +
      `${release.patches.length} version patch(es)`);
    materialiseVersion(release);
  }
  console.log(`stage: ${release.version} for ${TARGET} (${status})`);

  for (const p of [CORE_SRC, FW, LIB_SRC]) {
    if (!fs.existsSync(p)) {
      console.error(`stage: missing required tree: ${p}`);
      console.error('stage: components are checkouts beside this repo; see setup.sh');
      process.exit(1);
    }
  }

  rmrf(STAGE);

  // 1. stock teensy3 core
  copyDir(CORE_SRC, STAGE_CORE);

  // 2. OnlyKey's composite USB stack + keylayouts shadow the stock core files
  let overlaid = 0;
  for (const f of fs.readdirSync(FW)) {
    if (/\.(c|h)$/.test(f)) {
      copyFileRetrying(path.join(FW, f), path.join(STAGE_CORE, f));
      overlaid++;
    }
  }

  // 3. our host implementations of the peripheral drivers
  let overrides = 0;
  if (fs.existsSync(OVERRIDE)) {
    for (const f of fs.readdirSync(OVERRIDE)) {
      if (/\.(c|cpp|h)$/.test(f)) {
        copyFileRetrying(path.join(OVERRIDE, f), path.join(STAGE_CORE, f));
        overrides++;
      }
    }
  }

  /*
   * 4. drop the bare-metal files.
   *
   * A version script may add to this list - an older release can ship a core
   * file that later ones dropped - but never remove from it. Everything in DROP
   * is bare-metal by nature, not by release.
   */
  let dropped = 0;
  for (const f of [...DROP, ...release.drop]) {
    const p = path.join(STAGE_CORE, f);
    if (fs.existsSync(p)) { fs.rmSync(p); dropped++; }
  }

  // 5. vendored libraries and the sketch
  copyDir(LIB_SRC, STAGE_LIB);
  /*
   * WHERE THE SKETCH LIVES IS PER-RELEASE. Every release from v2.1.0 on
   * keeps it at OnlyKey/OnlyKey.ino, but the 2019 beta line has
   * OnlyKey_Beta/OnlyKey_Beta.ino - a different directory AND a different
   * file name. It is staged AS OnlyKey.ino either way, because
   * okemu_sketch.cpp includes that name and the name is not the part that
   * varies between releases; the contents are.
   */
  const sketch = release.sketch || { dir: 'OnlyKey', file: 'OnlyKey.ino' };
  copyDir(path.join(FW, sketch.dir), STAGE_SKETCH);
  if (sketch.file !== 'OnlyKey.ino') {
    const from = path.join(STAGE_SKETCH, sketch.file);
    if (!fs.existsSync(from)) {
      throw new Error(
        `stage: ${release.version} names its sketch ${sketch.dir}/${sketch.file}, ` +
        'which is not in the checkout at this pin');
    }
    fs.renameSync(from, path.join(STAGE_SKETCH, 'OnlyKey.ino'));
  }

  /*
   * 5a. The stock Arduino libraries the firmware uses, staged rather than
   * referenced in place. Staged, any of them can be patched (ADC needs it,
   * Time loses its Time.h below) and the register pass rewrites and checks
   * them, all without editing the Arduino install every other build on the
   * machine shares. A build whose include path still names the install's
   * EEPROM/ADC compiles against the same headers minus those edits.
   */
  for (const lib of ['Time', 'ADC', 'EEPROM']) {
    copyDir(path.join(TLIB, lib), path.join(STAGE_LIB, lib));
  }
  const timeRepointed = defuseTimeHeader();
  /* Only the old trees have it; -1 means this release was already fixed. */
  const shaRenamed = renameCryptoSha256();

  /*
   * 6. The DEBUG gate FIRST, because what it lands on decides which patches
   * are needed. Read back from the staged sources rather than assumed from
   * the environment, so build.json reports the tree, not the request.
   */
  const debugOn = gateDebug(WANT_DEBUG);
  /*
   * And the KEYBOARD gate with it, because upstream asks for that by hand.
   * A manual sync nobody performs is how the matrix came to measure every
   * release with twenty-six keyboard layouts compiled OUT. It follows the
   * DEBUG gate rather than being a second thing to remember - the same switch
   * upstream flips for a release.
   */
  gateKeylayouts(debugOn);
  /*
   * And the ORIGIN gate, which only a debug build can be asked about: it cuts
   * the one line that makes webcryptcheck() answer 2 before reading anything.
   */
  const enforcingOrigins = gateTrustAllOrigins(WANT_ENFORCE, debugOn);
  /*
   * The EDITION, read the same way. Reported whether or not it was forced,
   * because a travel build looks like a broken standard one from the outside:
   * set_private returns early, there is no FIDO, and the profile is not
   * encrypted.
   */
  const stdEdition = gateDefine(
    'STD_VERSION',
    '#define STD_VERSION //Define for STD edition firmare, undefine for IN TRVL edition firmware',
    WANT_STD);

  /*
   * The MODEL. Asked for only when OKEMU_MODEL says so - left alone, this reads
   * the sources and reports classic, which is what every release ships as.
   *
   * A release that does not carry the override cannot be asked to be a DUO, and
   * saying so beats producing a classic under a DUO's name: every measurement
   * taken against it would be attributed to the wrong device.
   */
  const duoModel = gateDefine(
    'DEFINED_HWID',
    '#define DEFINED_HWID OK_HW_DUO',
    WANT_DUO,
    { universal: false });
  if (WANT_DUO === true && duoModel !== true) {
    console.error(
      `stage: OKEMU_MODEL=duo, but ${release.version} has no DEFINED_HWID ` +
      'override in onlykey.h - the DUO is newer than this release, so there ' +
      'is no such device to emulate.');
    process.exit(1);
  }

  /*
   * 7. documented source-level fixups, plus this release's own.
   *
   * okpqc.cpp (the post-quantum code) is newer than every release up to
   * v3.0.4, so for those pinned trees the node-win32 patch for it is declared
   * absent here rather than in nine version scripts. The trees that DO ship
   * it - v3.1.0, and the working tree - say so with `hasOkpqc`; without that
   * the claim would go stale and applyPatches() throw on it, as it is meant to.
   */
  const pinnedAbsent = release.pins && !release.hasOkpqc ? ['libraries/onlykey/okpqc.cpp'] : [];
  const patched = applyPatches([
    APPID_NULL_GUARD,
    ...release.patches,
    ...(debugOn === false ? [...DEBUG_OFF_PATCHES, ...release.debugOffPatches] : []),
  ], [
    ...release.absentPatterns,
    ...pinnedAbsent,
    ...(debugOn === false ? release.debugOffAbsentPatterns : []),
  ]);

  // 7b. plugins, if any were asked for - each hook must find its anchor exactly once
  const pluginStats = firmwarePlugins.apply(pluginSet, STAGE);
  if (APP_OUT) writePluginTests(PLUGINS);

  // 8. no fixed addresses: registers into the relocated blocks, then checked
  const registerCounts = rewriteRegisterBlocks();

  const stats = digestStage();
  const declaredVersion = readDeclaredVersion();
  const info = APP_OUT
    ? writeBuildInfo(stats, release, debugOn, stdEdition, duoModel, PLUGINS,
                     slotPlugins, enforcingOrigins, declaredVersion)
    : null;

  /*
   * 9. Say what was staged. The addon built from this tree does not know which
   * release it is, and a test that checks a release against its row in
   * ok-versions.json (test/compat.js) has to - reading OKEMU_VERSION from its
   * own environment would trust the caller rather than the build. `debug` is
   * the gate as the staged onlykey.h ends up, not the request.
   */
  writeFileRetrying(path.join(STAGE, 'build.json'), JSON.stringify({
    version: release.version,
    pins: release.pins ? { libraries: release.pins.libraries,
      'OnlyKey-Firmware': release.pins['OnlyKey-Firmware'] } : null,
    debug: debugOn,
    /* fixes carried on top of the pins (v3.1.0: the RC's 0008-0010); [] = the release as published */
    fixes: release.fixes || [],
    /* the machine that staged it; `target` is the build it was staged for */
    platform: versions.EMULATOR_PLATFORM,
    target: TARGET,
    /* the edition / model / origin gates as the staged tree ends up */
    std: stdEdition,
    model: duoModel ? 'duo' : 'classic',
    enforce: enforcingOrigins,
    /* only present in a plugin build: index.js gives it its own storage, and the kit
     * side-loads each plugin's own tests from pluginsDir/<name>/tests/kit.test.js */
    ...(PLUGINS.length ? { plugins: PLUGINS, pluginsDir: PLUGINS_DIR } : {}),
  }, null, 2) + '\n');

  const pins = release.pins || {};
  console.log(
    `stage: ${path.relative(ROOT, STAGE)}\n` +
    `  core files overlaid from OnlyKey-Firmware: ${overlaid}\n` +
    `  emulator overrides applied:                ${overrides}\n` +
    `  bare-metal files dropped:                  ${dropped}\n` +
    `  literal patches applied:                   ${patched}\n` +
    `  registers rebased (no fixed addresses):    ${Object.entries(registerCounts).map(([k, v]) => `${k} ${v}`).join(', ')}\n` +
    `  Time.h consumers repointed at TimeLib.h:   ${timeRepointed}\n` +
    (shaRenamed < 0 ? '' :
      `  Crypto/SHA256.h renamed, consumers repointed: ${shaRenamed}\n`) +
    `  staged sources digested:                   ${stats.files} files, ${stats.digest}\n` +
    `  OnlyKey-Firmware / libraries:              ` +
      `${pins['OnlyKey-Firmware'] || gitShort(FW) || '?'} / ${pins.libraries || gitShort(LIB_SRC) || '?'}\n` +
    `  version:                                   ${release.version} (${status})\n` +
    `  fixes on top of the pins:                  ${(release.fixes || []).join(', ') || 'none'}\n` +
    `  sources declare:                           ${declaredVersion || 'unknown'}\n` +
    `  target:                                    ${TARGET}\n` +
    `  build:                                     ${debugOn ? 'debug' : 'production'}\n` +
    `  origins:                                   ${enforcingOrigins ? 'ENFORCED (table + field 31 decide)' : 'trust-all (debug default)'}\n` +
    `  edition:                                   ${stdEdition ? 'standard' : 'TRAVEL (STD_VERSION off)'}\n` +
    `  model:                                     ${duoModel ? 'DUO' : 'classic'}\n` +
    `  storage slot:                              ${release.slot || '(the default)'}` +
    (info ? `\n  app build record:                          ${path.join(APP_OUT, 'firmware.json')}` : '')
  );

  if (PLUGINS.length) {
    console.log(`  plugins staged:                            ${pluginStats.map((p) => `${p.name} (${p.hooks} hooks, ${p.files} files)`).join(', ')}\n  digest expectation skipped: a plugin build is not the base build`);
  } else {
    checkExpectation(release, stats, debugOn);
  }
}

/*
 * Only stage when RUN, not when required.
 *
 * ok-rn's scripts/version-probe.js imports the patch tables to ask which of
 * their patterns still match an older release, and importing a module should
 * not rewrite .stage as a side effect.
 */
if (require.main === module) main();

module.exports = {
  PATCHES, DEBUG_OFF_PATCHES, APPID_NULL_GUARD, DROP, TARGETS, TARGET,
  patchTargets, main, versions,
};
