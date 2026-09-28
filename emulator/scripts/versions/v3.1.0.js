/*
 * v3.1.0 - the release candidate.
 *
 * trustcrypto/libraries PR #33 and trustcrypto/OnlyKey-Firmware PR #183,
 * branch release-3.1.0, one squashed commit each, pinned in
 * node-onlykey-lib/versions at their heads (2026-09-28). Not tagged yet:
 * re-pin here and in the library when the PRs move or the tag lands - the
 * cross-check in versions/index.js refuses a script whose `pins` disagree.
 *
 * WHAT IT IS, measured against the working tree it replaced:
 *
 *   - Re-indented and re-spaced throughout. Two stage patches stopped matching
 *     on whitespace alone (touch_sense_loop()'s press hand-over, okcrypto.cpp's
 *     stack-address print); both now list the 3.1.0 spelling (stage.js,
 *     d3eb14a). With that the working-tree patch set applies unchanged, which
 *     is why this spreads working-tree - measured: 9 patches, no warnings.
 *   - Ships with the DEBUG gate OFF (the working tree had it on). A pinned
 *     release stages signed by default here anyway; the test kit, which drives
 *     presses through the DEBUG console, builds it with OKEMU_DEBUG=1.
 *   - Does NOT carry the CTAPHID wipe fix (0c-coder/libraries #20): kit
 *     01-protocol/32-ctaphid-wipe-timer fails on it (143/1/6). bm-ok's
 *     libraries master (213e670) is this release plus that fix, and passes
 *     144/0/6 - but THIS row is the release as cut, fix-less, on purpose.
 *
 * Emulator rung 'untried' until the matrix builds the SIGNED release and runs
 * press + compat on it - the 144/0/6 above was a DEBUG build.
 */
'use strict';

const workingTree = require('./working-tree');

module.exports = {
  ...workingTree,
  version: 'v3.1.0',
  pins: { libraries: 'eb25290', 'OnlyKey-Firmware': '9fceea1' },
  status: 'untried',
  emulator: { linux: 'boots', win32: 'boots' },   /* node-onlykey-emulator's own ladder: boots = matrix stage/build/press/compat PASS on the SIGNED build - linux (VM x64) and win32, 2026-09-28 */
  slot: 'v3.1.0',
  notes: [
    'The release candidate: trustcrypto release-3.1.0 (libraries PR #33,',
    'OnlyKey-Firmware PR #183), pinned at the PR heads eb25290 / 9fceea1.',
    'Stages with the working-tree patch set (3.1.0 re-spacing handled by the',
    'alternative spellings in stage.js). Ships DEBUG off. Lacks the CTAPHID',
    'wipe fix (0c-coder/libraries #20) - bm-ok libraries master carries it.',
  ].join('\n'),
};
