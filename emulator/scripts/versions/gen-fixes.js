#!/usr/bin/env node
'use strict';
/**
 * THE PATCH FILE IS THE FIX (Brad, 2026-10-26: "we can make a generator script ... to make things easy for sending
 * upstream patches or testing fixes"). A fix found testing a release lives once, as the `git am` patch in
 * patches-<version>/<nnnn-...>/ - what the maintainer gets, with its README. The soft key stages it from
 * fixes-<version>.js (find/replace edits, stage.js); the developer hard key `git am`s the same file
 * (plugins/edge/tools/build-hardkey.sh). This writes the first from the second, so the two cannot drift:
 *
 *   node scripts/versions/gen-fixes.js 3.1.0                 rewrite fixes-3.1.0.js's module.exports from the patches
 *   node scripts/versions/gen-fixes.js 3.1.0 --check         exit 1 when fixes-3.1.0.js is not what the patches give
 *   node scripts/versions/gen-fixes.js 3.1.0 --verify DIR    apply the edits to the pinned files read from the git
 *                                                            checkout DIR (`git show <pin>:<path>`): every find string
 *                                                            occurs exactly once, in order
 *
 * Each hunk becomes one edit: find = its context and removed lines, replace = its context and added lines. The
 * patches name files inside their own repository; the folder name says which (0012-libraries-... -> libraries/).
 * The comment above `module.exports` in fixes-<version>.js is hand-written and kept as it is.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [version, ...rest] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('usage: gen-fixes.js <version, e.g. 3.1.0> [--check | --verify <git checkout of the patched repo>]');
  process.exit(2);
}
const here = __dirname;
const dir = path.join(here, `patches-${version}`);
const out = path.join(here, `fixes-${version}.js`);
const REPOS = { libraries: 'libraries', firmware: 'OnlyKey-Firmware' };

/* one patch file -> [{file, edits}] */
function parsePatch(text, repoDir) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const files = [];
  let cur = null;
  let hunk = null;
  const endHunk = () => {
    if (hunk) cur.edits.push([hunk.find.join('\n') + '\n', hunk.replace.join('\n') + '\n']);
    hunk = null;
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      endHunk();
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      cur = { file: `${repoDir}/${m[2]}`, edits: [] };
      files.push(cur);
    } else if (line.startsWith('@@')) {
      endHunk();
      hunk = { find: [], replace: [] };
    } else if (hunk) {
      if (line === '-- ' || line.startsWith('diff --git')) { endHunk(); continue; }
      const c = line[0];
      const body = line.slice(1);
      if (c === ' ') { hunk.find.push(body); hunk.replace.push(body); }
      else if (c === '-') hunk.find.push(body);
      else if (c === '+') hunk.replace.push(body);
      else if (c === '\\') continue; /* "\ No newline at end of file" */
      else endHunk();
    }
  }
  endHunk();
  return files;
}

/*
 * HELD: a folder holding a HOLD file (its reason inside) is a patch we keep but do not stage - one that changes
 * existing users' keys or data waits for a decision and a measurement. build-hardkey.sh skips it the same way.
 */
const all = fs.readdirSync(dir).filter((d) => /^\d{4}-/.test(d)).sort();
const held = all.filter((d) => fs.existsSync(path.join(dir, d, 'HOLD')));
/*
 * EXPERIMENTAL: a folder holding an EXPERIMENTAL file (its reason inside) - not sent upstream (Brad, 2026-10-28: 0016
 * "as an experimental speed improvement"). Like every patch here, a build carries it only when its version_control
 * version.json lists it; it is named apart so a person sees which of a release's patches are ours alone.
 */
const experimentalDirs = all.filter((d) => !held.includes(d) && fs.existsSync(path.join(dir, d, 'EXPERIMENTAL')));
/*
 * HARDKEY: a folder holding a HARDKEY file (its reason inside) fixes code only a hard key compiles - the Teensy USB stack
 * (OnlyKey-Firmware usb_dev.c), whose place the emulator's own USB takes (core/okemu_usb.cpp). Its edits say
 * `targets: []` (stage.js patchTargets: no emulator target), so the soft key stages without it; build-hardkey.sh applies
 * it as every listed patch.
 */
const hardKeyOnly = (d) => fs.existsSync(path.join(dir, d, 'HARDKEY'));
const fixOf = (d) => {
  const repo = REPOS[d.split('-')[1]];
  if (!repo) throw new Error(`${d}: the folder name says which repository (${Object.keys(REPOS).join(' | ')}) after the number`);
  const patches = fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('.patch')).sort();
  if (!patches.length) throw new Error(`${d}: no .patch file`);
  return { name: d.slice(0, 4), hardKey: hardKeyOnly(d), patches: patches.map((p) => ({ patch: p, files: parsePatch(fs.readFileSync(path.join(dir, d, p), 'utf8'), repo) })) };
};
const fixes = all.filter((d) => !held.includes(d) && !experimentalDirs.includes(d)).map(fixOf);
const experimental = experimentalDirs.map(fixOf);

const q = (s) => JSON.stringify(s);
const patchLines = (list, indent) => {
  const out = [];
  for (const f of list) {
    for (const p of f.patches) {
      for (const file of p.files) {
        out.push(`${indent}/* ${p.patch} */`, `${indent}{`, `${indent}  file: ${q(file.file)},`);
        if (f.hardKey) out.push(`${indent}  targets: [], /* a hard key's code only (HARDKEY): no emulator target stages it */`);
        out.push(`${indent}  edits: [`);
        for (const [find, replace] of file.edits) out.push(`${indent}    [${q(find)},`, `${indent}     ${q(replace)}],`);
        out.push(`${indent}  ],`, `${indent}},`);
      }
    }
  }
  return out;
};
/*
 * BY NUMBER (Brad, 2026-10-28: "enable patches based off that version set in the version_control"): a build applies
 * exactly the patches its version_control plugin's version.json lists, picked from here by number - a fix or an
 * experimental one alike; a held one is not here, so no version can carry it by mistake. names / experimental / held
 * say which is which, for a person reading this file.
 */
const body = ['module.exports = {', `  names: [${fixes.map((f) => q(f.name)).join(', ')}],`];
body.push(`  experimental: [${experimental.map((f) => q(f.name)).join(', ')}],`);
body.push(`  held: [${held.map((d) => q(d.slice(0, 4))).join(', ')}],`);
body.push('  byName: {');
for (const f of [...fixes, ...experimental].sort((a, b) => a.name.localeCompare(b.name))) {
  body.push(`    ${q(f.name)}: [`, ...patchLines([f], '      '), '    ],');
}
body.push('  },', '};', '');

const old = fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n');
const at = old.indexOf('module.exports = {');
if (at < 0) throw new Error(`${out}: no module.exports to replace`);
const next = old.slice(0, at) + body.join('\n');

const mode = rest[0];
if (mode === '--check') {
  if (next !== old) { console.error(`fixes-${version}.js is not what patches-${version}/ gives - run gen-fixes.js ${version}`); process.exit(1); }
  console.log(`fixes-${version}.js matches patches-${version}/ (${fixes.map((f) => f.name).join(', ') || 'none'})`);
} else if (mode === '--verify') {
  const checkout = path.resolve(rest[1] || '');
  const pins = require(path.join(here, `v${version}.js`)).pins;
  const files = new Map();
  /* every patch a version may list, the experimental ones included */
  for (const f of [...fixes, ...experimental]) for (const p of f.patches) for (const file of p.files) {
    const [repoDir, ...inRepo] = file.file.split('/');
    const pin = pins[repoDir];
    if (!files.has(file.file)) files.set(file.file, execFileSync('git', ['-C', checkout, 'show', `${pin}:${inRepo.join('/')}`], { encoding: 'utf8', maxBuffer: 64 << 20 }).replace(/\r\n/g, '\n'));
    let text = files.get(file.file);
    for (const [find] of file.edits) {
      const n = text.split(find).length - 1;
      if (n !== 1) { console.error(`${f.name} ${p.patch}: a find string occurs ${n} times in ${file.file} at ${pin}`); process.exit(1); }
    }
    for (const [find, replace] of file.edits) text = text.replace(find, replace);
    files.set(file.file, text);
  }
  console.log(`every edit of ${[...fixes, ...experimental].map((f) => f.name).join(', ') || 'no fix'} finds its text exactly once at the v${version} pins`);
} else {
  fs.writeFileSync(out, next);
  console.log(`fixes-${version}.js written from patches-${version}/ (${fixes.map((f) => f.name).join(', ') || 'none'})`);
}
if (held.length) console.log(`held, not staged: ${held.join(', ')}`);
if (experimental.length) console.log(`experimental (ours, not sent), staged when a version_control version lists them: ${experimental.map((f) => f.name).join(', ')}`);
