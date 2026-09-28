'use strict';

/**
 * v3.0.5 - NAMED BUT NOT CUT.
 *
 * `libraries/onlykey/onlykey.h` declares OKversionmaj/min/pat as 3/0/5, so
 * every build of the current checkouts answers `UNLOCKEDv3.0.5-testc` on the
 * wire. Upstream has a `release/v3.0.5` branch in 0c-coder/libraries; there is
 * no `v3.0.5-prod` tag in either repo, and OnlyKey-Firmware's newest tag is
 * still v3.0.4-prod.
 *
 * So this version exists as a name before it exists as a commit. Its row in
 * ok-versions.json is deliberately BLANK, which pinsFor() reads as "the
 * working tree" - see the note there. That makes `OKEMU_VERSION=v3.0.5` build
 * what the checkouts hold, which is what v3.0.5 currently is, and it means the
 * row is already in place to fill in on release day rather than being
 * remembered then.
 *
 * ## While it is blank, this IS the working tree
 *
 * Everything here is working-tree.js's, spread rather than copied, because two
 * lists that must agree and are maintained separately eventually do not. In
 * particular it inherits:
 *
 *   - the sketch yield() patch, which no pinned release needs
 *   - the four guards upstream fixed, declared absent rather than deleted
 *   - `slot: ''`, the unnamed storage slot, so a device provisioned under the
 *     working tree is the same device here. That is the point: selecting
 *     v3.0.5 today must not look like a different key.
 *
 * `unreleased` stays true throughout, because `unreleased: !release.pins` and
 * the pins are null. That is correct and not a gap - this is ahead of every
 * release until the day it is one.
 *
 * ## On release day
 *
 * Fill both hashes into ok-versions.json. pinsFor() then returns them, the
 * sources are materialised from git instead of the checkouts, `unreleased`
 * becomes false, and THIS FILE STOPS INHERITING: replace the spread with a
 * measured patch list of its own, the way v3.0.4.js has one. A release whose
 * patches are "whatever the tree happens to need" has not been measured.
 */
const workingTree = require('./working-tree');

module.exports = {
  ...workingTree,
  version: 'v3.0.5',
  /*
   * PINNED 2026-09-28 (node-onlykey-lib/versions): never released, it is the
   * "3.0.5 compatibility tree" the kit, ok-rn and this emulator were built
   * against - 0c-coder's masters. A blank row built whatever was checked out,
   * which stopped being 3.0.5 the day the working tree moved to 3.1.0.
   */
  pins: { libraries: '57340df', 'OnlyKey-Firmware': '1f7e726' },

  /*
   * Its own storage slot now: it no longer IS the working tree, so sharing the
   * working tree's emulated flash would carry 3.1.0 state into a 3.0.5 run.
   */
  slot: 'v3.0.5',

  status: 'boots',
  /* 'untried' again, deliberately: the 2026-09-27 'boots' was the working tree
   * as it then was (libraries b412e78, DEBUG on). Pinned, this builds a SIGNED
   * release from 57340df / 1f7e726 - not yet measured. The matrix sets it. */
  emulator: { linux: 'boots', win32: 'untried' },   /* node-onlykey-emulator's own ladder: linux boots = matrix stage/build/press/compat PASS on the SIGNED build, VM x64, 2026-09-28 */

  notes: [
    'NEVER RELEASED - the 3.0.5 compatibility tree, pinned 2026-09-28 to',
    '0c-coder\'s masters (libraries 57340df, OnlyKey-Firmware 1f7e726). It',
    'reports v3.0.5 and carries the CTAPHID wipe fix; the 3.1.0 candidate',
    'that followed it (v3.1.0.js) does not.',
    '',
    'Same patch set as working-tree (spread), its own storage slot.',
    '',
    'On release day: fill in both hashes, then give this file its own',
    'measured patch list instead of the spread.',
    '',
    'THE UPGRADE PATH FROM v3.0.4, read at the pins (libraries c8804e3 against',
    'b412e78). v3.0.4 derives web keys with the origin in the HKDF (v1); this',
    'tree derives them without it (libraries 40464ca, "onlykey/derive/ecc/v2").',
    'So a WEB-DERIVED key is a different key after the upgrade. ok-rn keeps',
    'that from stranding anything it made: the vault, which derives over that',
    'route, is only offered from 3.0.5 (capability deviceVault), and the',
    'password generator is a testing-mode feature (as in the maintainer\'s web',
    'app, where it is a devel-only plugin). Keys derived by OTHER clients on',
    'v3.0.4 still move. SSH/GPG AGENT-derived keys do NOT: the agent route',
    'keeps v1 as its default, and v2 (80cacfe) is opt-in. The maintainer\'s',
    'note on 40464ca: "none shipped".',
    '',
    '2026-09-24, both keys on libraries b412e78 + OnlyKey-Firmware 1f7e726:',
    'working-tree 103p/0f/34s (run 3 - run 2 bailed once on fidoPin,',
    'CTAP1_ERR_INVALID_COMMAND, then passed), working-tree-duo 102p/0f/35s,',
    'this entry 93p/0f/44s. Same build as working-tree, yet ten more tests',
    'skip under this name - not yet explained.',
  ].join('\n'),
};
