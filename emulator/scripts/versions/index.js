'use strict';
/*
 * One stage script per firmware release.
 *
 *     OKEMU_VERSION=v3.0.2 node scripts/stage.js
 *
 * stage.js is the ENGINE - the patches every version needs, the flash rebase,
 * the system-block rewrite. What differs release to release lives in
 * `scripts/versions/<version>.js`, one file per release in node-onlykey-lib/versions, and
 * this module loads it.
 *
 * ## Why per-version files rather than one table
 *
 * A single VERSION_PATCHES array cannot say WHICH release each entry is for
 * without a comment nobody can check, and an `optional` patch that silently
 * misses looks identical to one that was never needed. Splitting them means a
 * version script lists exactly what that release needs, so applying it is
 * mandatory - a miss is an error, not a shrug - and the file is also the place
 * to write down how far that version has actually been taken.
 *
 * ## What a version script exports
 *
 *   version   must equal the filename, so a copied file cannot lie about itself
 *   pins      optional; cross-checked against the library's pins and NOT trusted
 *             over it. Present so that editing the pin list fails loudly here
 *             instead of quietly invalidating everything measured below.
 *   status    how far this release has been taken - see STATUS
 *   notes     what is known, and what the evidence was
 *   patches   staged edits this release needs. Applied like any other patch:
 *             a pattern that does not match is an ERROR.
 *   drop      extra core files to delete, if a release ships one that later
 *             ones do not. Usually absent.
 *   expect    optional { digest } from the last successful stage of this
 *             version. A mismatch is reported, not fatal - the toolchain and
 *             stage.js are both inputs and both move.
 *
 * Adding a release is copying the nearest neighbour, changing `version`,
 * setting `status: 'untried'`, and emptying `notes`.
 *
 * ## Where the pins come from: UPSTREAM RELEASE TAGS
 *
 * Both repositories tag their releases, and the tags name commits. The local
 * checkouts are forks with no tags of their own, which is why this was not
 * obvious - but the GitHub API has them, and every pin here has been checked
 * against one:
 *
 *     api.github.com/repos/trustcrypto/libraries/git/refs/tags
 *     api.github.com/repos/trustcrypto/OnlyKey-Firmware/git/refs/tags
 *
 * All nine OnlyKey-Firmware pins match their `vX.Y.Z-prod` tag exactly. On the
 * libraries side, v3.0.2, v3.0.1, v3.0.0, v2.1.2, v2.1.1, v2.1.0 and
 * v0.2-beta.8 match theirs (v2.1.1's is an annotated tag and dereferences to
 * the same commit). So these are not a convention and not an inference - they
 * are what upstream shipped.
 *
 * ## The two that have no tag, and how they were derived
 *
 * The libraries repository stops tagging at v3.0.2-prod. OnlyKey-Firmware has
 * v3.0.3-prod and v3.0.4-prod, both pointing at the SAME commit - the sketch
 * did not change between those releases - so only the libraries side needs
 * working out.
 *
 * `libraries/onlykey/onlykey.h` carries OKversionmaj/min/pat, so reading the
 * header at every commit gives which commits called themselves v3.0.3 and
 * which v3.0.4. That still leaves a range, and the RELEASE DATE closes it: the
 * pin is the last commit declaring that version at or before the day the
 * release was published.
 *
 * That rule is not invented for the occasion - it reproduces all seven tagged
 * libraries pins. It also corrects an earlier guess here. "The last commit of
 * the version's range" looked like the pattern and is wrong: commits keep the
 * old version number until the next bump, so a release is often followed by
 * more commits declaring it. v3.0.2 shipped on 2022-10-05 and two further
 * 3.0.2 commits landed on 2022-10-25, which is exactly why its tag is at
 * 5d7ce7a and not at the end of its range.
 *
 * Applied:
 *
 *   v3.0.3  published 2022-11-08  ->  a133bea (2022-11-04)
 *                                     9c99922 is 2022-11-26, after the release
 *   v3.0.4  published 2022-12-14  ->  c8804e3 (2022-11-30)
 *
 * ## What was tried before the tags were found, and why it failed
 *
 * Worth keeping so nobody repeats it. Rebuilding each candidate and comparing
 * bytes needs the pinned Arduino 1.6.5 + Teensyduino 1.27, whose compiler is a
 * Linux ELF, and the development machine has no Docker and no working WSL.
 * Comparing string tables out of the signed release images works - they are
 * readable once the block data is word-swapped - but no candidate inside a
 * range changes a literal that a production build keeps. Both dead ends; the
 * tags answered it in two requests.
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
/*
 * versions -> scripts -> emulator -> node-onlykey-emulator -> the checkouts
 * root. One level shallower than ok-rn's android/okemu/scripts/versions, which
 * this directory was ported from.
 */
const APP = path.resolve(HERE, '..', '..', '..');
const ROOT = path.resolve(APP, '..');

/*
 * THE PINS ARE node-onlykey-lib's: `node-onlykey-lib/versions` owns the
 * release table (ok-versions.json - the pinned commits, the signed image, a
 * compatibility row per release), and this emulator, ok-rn and the test kit
 * all read that one copy.
 *
 * It used to live here, a copy of ok-rn's plus the compatibility rows, and
 * copies drift: this matrix already caught one host (the Pi) reading a
 * release differently because ITS copy of the library was older. A table in
 * the library moves with the library's pin, so the pins, the capabilities()
 * they are checked against and the rows recording them always come from the
 * same commit.
 *
 * What stays here is this build system's own: the per-release stage scripts
 * (patches for node-gyp and clang-cl) and the emulator's status ladder.
 */
const libVersions = require('node-onlykey-lib/versions');

/**
 * How far a release has been taken, weakest first.
 *
 * Each rung is a thing somebody watched happen, not a thing that ought to
 * follow from the rung below. "Patches apply" is not "it links", and "it links"
 * is not "it boots" - both of those have already been the difference between a
 * version that works and one that does not.
 */
const STATUS = [
  'blocked',   // cannot be staged at all - a pinned commit is not in the checkout
  'untried',   // nobody has run stage.js for it
  'stages',    // stage.js completes, every patch applies
  'builds',    // :okemu:externalNativeBuild links a libokemu.so
  'boots',     // the firmware starts on a phone and completes OKCONNECT
  'tested',    // the e2e suite has been run against it and the result recorded
];

/** What OKEMU_VERSION is unset. Every build has a script; this is its name. */
const WORKING_TREE = 'working-tree';

/* The emulator's two build platforms, and the one this process is on. Linux
 * covers the Pi (arm64, gcc) as well as x64; Windows is clang-cl + lld-link. */
const EMULATOR_PLATFORMS = ['linux', 'win32'];
const EMULATOR_PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';

/** Every RELEASE that has a script here, newest name first. */
function list() {
  return fs
    .readdirSync(HERE)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'index.js')
    .map((f) => f.slice(0, -3))
    .filter((name) => name !== WORKING_TREE)
    .sort()
    .reverse();
}

/**
 * The pinned commits for one release, from node-onlykey-lib/versions.
 *
 * Null for the working tree, which is pinned to nothing - it is whatever the
 * checkouts are at - and null for a release that is NAMED but not CUT (a row
 * with both commits blank; v3.0.5 today), so it builds what the checkouts
 * hold, which is what that version currently IS. The library throws on an
 * unknown release and on a half-pinned row: one repo pinned and the other
 * floating would be neither the release nor the tree.
 */
function pinsFor(version) {
  if (version === WORKING_TREE) return null;
  return libVersions.pinsFor(version);
}

/**
 * Load one release's stage script.
 *
 * Throws rather than falling back to a default. A typo'd version silently
 * building the working tree under another name is the one outcome a version
 * matrix must never produce - every measurement after it would be attributed to
 * the wrong firmware.
 */
function load(version) {
  const file = path.join(HERE, `${version}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `no stage script for ${version}.\n` +
      `  expected: ${path.relative(ROOT, file)}\n` +
      `  have:     ${list().join(', ') || '(none)'}\n` +
      `  Copy the nearest neighbour and set status: 'untried'.`,
    );
  }

  const mod = require(file);

  if (mod.version !== version) {
    throw new Error(
      `${version}.js declares version "${mod.version}" - a copied file that was ` +
      `not renamed inside. Fix the export, not the filename.`,
    );
  }
  if (!STATUS.includes(mod.status)) {
    throw new Error(
      `${version}.js has status "${mod.status}"; expected one of ${STATUS.join(', ')}`,
    );
  }
  /*
   * THE EMULATOR'S OWN LADDER, per platform. `status` above is ok-rn's - how
   * far the release was taken on the Android soft key, which is evidence the
   * patches work but says nothing about this build: a different core, a
   * different linker, and on Windows a different ABI (MSVC mangles a global's
   * type into its name). "Builds on Linux" is not "links with lld-link", so
   * each platform climbs its own ladder.
   */
  const emu = mod.emulator || {};
  for (const plat of EMULATOR_PLATFORMS) {
    if (!STATUS.includes(emu[plat])) {
      throw new Error(
        `${version}.js has emulator.${plat} "${emu[plat]}"; expected one of ` +
        `${STATUS.join(', ')}. A release new to the emulator starts at 'untried'.`,
      );
    }
  }

  const pins = pinsFor(version);

  /*
   * The script may restate the pins it was written against. The library's
   * table stays the source of truth; this only catches the two drifting apart, which
   * would otherwise invalidate every note in the file without changing a line
   * of it.
   */
  if (mod.pins && pins) {
    for (const repo of Object.keys(mod.pins)) {
      if (mod.pins[repo] !== pins[repo]) {
        throw new Error(
          `${version}.js was written against ${repo}@${mod.pins[repo]}, but ` +
          `node-onlykey-lib/versions now pins ${repo}@${pins[repo]}. Re-measure this ` +
          `release, then update the script - its notes describe the old commit.`,
        );
      }
    }
  }

  return {
    version,
    pins,
    /* This platform's rung - what stage.js acts on (e.g. refusing 'blocked'). */
    status: emu[EMULATOR_PLATFORM],
    emulator: { ...emu },
    /* ok-rn's Android rung, kept as evidence; never acted on here. */
    okrnStatus: mod.status,
    notes: mod.notes || '',
    patches: mod.patches || [],
    /**
     * Applied only when the DEBUG gate ends up OFF, whichever way it got
     * there - OKEMU_PRODUCTION=1, or a release that simply ships that way.
     * Per-version because the lines they patch do not all exist at every
     * release.
     */
    debugOffPatches: mod.debugOffPatches || [],
    drop: mod.drop || [],
    /**
     * Where this release keeps its sketch, when it is not OnlyKey/OnlyKey.ino.
     *
     * The 2019 beta line has OnlyKey_Beta/OnlyKey_Beta.ino - a different
     * directory and a different file name. stage.js stages it AS
     * OnlyKey.ino whatever it was called, because okemu_sketch.cpp includes
     * that name and the name is not the part that varies.
     */
    sketch: mod.sketch || null,
    /**
     * Base-patch patterns this release's tree does not contain.
     *
     * Old trees predate some of the patterns the base patches look for, and
     * a stage that fails for that reason puts a floor under how far back the
     * matrix can reach. Declaring one is a claim stage.js CHECKS: a pattern
     * declared absent that turns out to be present is an error, because the
     * tree would otherwise be built unpatched on a stale note.
     */
    absentPatterns: mod.absentPatterns || [],
    /**
     * The same claim, for patterns only the DEBUG-OFF list looks for.
     *
     * It cannot go in `absentPatterns`, because that list is validated against
     * the patches actually in play: a debug build never passes DEBUG_OFF_PATCHES
     * to applyPatches(), so a debug-only pattern declared there would throw on
     * every debug stage as "no patch looks for it". Merged in only when the
     * gate ends up off, which is exactly when its patches are.
     */
    debugOffAbsentPatterns: mod.debugOffAbsentPatterns || [],
    /* Whether the tree ships onlykey/okpqc.cpp - v3.0.5 and later do; stage.js
     * declares it absent for pinned trees that do not. */
    hasOkpqc: mod.hasOkpqc === true,
    /**
     * Build options this release must be staged with to be comparable, when
     * its pinned commit does not have them set.
     *
     * `std: true` is v2.1.1's case: that commit has STD_VERSION commented out,
     * so it builds as the IN TRVL edition and almost nothing the suite
     * exercises exists. Declaring it here means the release is staged the same
     * way whoever runs it, rather than depending on somebody remembering an
     * environment variable - and the notes say the commit itself is travel, so
     * nobody reads a standard result and concludes the commit was standard.
     *
     * An environment variable still wins, so a deliberate travel build is one
     * OKEMU_STD=0 away.
     */
    gates: mod.gates || {},
    expect: mod.expect || null,
    /**
     * Where this version's flash.bin and eeprom.bin live, under the app's
     * files/okemu directory. A v2.1 firmware reading a v3.0.4 flash is not a
     * measurement of v2.1, so each release gets its own state and switching
     * back finds what it left.
     *
     * The working tree - no OKEMU_VERSION - keeps the bare `okemu` directory it
     * has always used, so nothing already on a phone moves.
     */
    slot: mod.slot !== undefined ? mod.slot : version,
  };
}

module.exports = {
  list, load, pinsFor, STATUS, WORKING_TREE, EMULATOR_PLATFORMS, EMULATOR_PLATFORM,
};
