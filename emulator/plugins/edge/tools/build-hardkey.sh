#!/usr/bin/env bash
# OnlyKey 3.1.0 + firmware plugins for a DEVELOPER hard key (Teensy 3.2, loaded through HalfKay),
# DEBUG on, from one command. Run it on the machine that builds firmware (Docker + the toolchain image
# onlykey/onlykey-firmware-toolchain + an Arduino 1.6.5-r5/Teensyduino 1.27 tree):
#
#   bash tools/build-hardkey.sh            # -> $OUT/images/v3.1.0-test-<plugins>-fw<FW_PIN>-lib<LIB_PIN>[-fix<nnnn>...][-b<BUILD_STAMP>].hex
#
# The base is 3.1.0 at the maintainer's pins (OnlyKey-Firmware 80e3ba0, libraries fe9e293) WITH the fixes
# upstream does not carry yet: the patch files in scripts/versions/patches-3.1.0/, `git am`ed in order -
# the same files the soft key stages (fixes-3.1.0.js) - so the hard key runs the same firmware as the
# soft key's plugin build.
#
# Why each step is the way it is:
# - Plain clones of the source checkouts, not worktrees: the toolchain image copies the firmware tree
#   and runs `git rev-parse` inside the container, where a worktree's .git file points nowhere.
# - The plugins are applied by node-onlykey-lib's own firmware-plugins.js, the one the emulator's
#   stage.js uses, so every hook must find its anchor exactly once, as on the soft key. It expects a
#   staged tree with libraries/onlykey and sketch/; a temp dir of two symlinks gives it that.
# - Arduino 1.6.5 compiles only a legacy library's root and utility/ folder, never plugins/, so each
#   plugin .cpp gets a one-line unit file in libraries/onlykey that #includes it.
# - The size guard reads the hex, not the toolchain's total: the Edge state lives at 0x39800/0x3A000
#   (okplugin_edge.cpp, EDGE_REGION), and the code must end below it. The toolchain checks only
#   against the whole 256 KB.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"            # plugins/edge
PLUGINS_DIR="$(cd "$here/.." && pwd)"
EMU="$(cd "$here/../.." && pwd)"                      # emulator/, where node-onlykey-lib resolves
ROOT="${OK_ROOT:-$HOME/project/onlykey}"
SRC="${FW_SRC:-$ROOT/fw-3.1.0-pr}"                    # source checkouts + the Arduino tree
OUT="${FW_OUT:-$ROOT/fw-edge}"
KIT="${KIT:-$ROOT/onlykey-testing}"                   # its lib/flash.js reads Intel HEX
FW_PIN="${FW_PIN:-80e3ba0}"
LIB_PIN="${LIB_PIN:-fe9e293}"
PATCHES="$EMU/scripts/versions/patches-3.1.0"           # the RC fixes upstream does not carry yet
PLUGINS="${PLUGINS:-edge}"
LIMIT="${LIMIT:-0x39800}"                              # the first byte the code must not reach
IMAGE=onlykey/onlykey-firmware-toolchain
ARDUINO="$SRC/arduino-1.6.5-r5-teensy_127"

say() { echo "== $(date +%T) $*"; }
command -v node >/dev/null || { [ -s ~/.nvm/nvm.sh ] && source ~/.nvm/nvm.sh >/dev/null; }

say "1. clean trees: OnlyKey-Firmware @ $FW_PIN, libraries @ $LIB_PIN (branch edge/3.1.0)"
mkdir -p "$OUT/images" "$OUT/builds" "$OUT/arduino-1.6.5-r5-teensy_127"
for r in OnlyKey-Firmware libraries; do
  [ -d "$OUT/$r/.git" ] || git clone -q "$SRC/$r" "$OUT/$r"
  git -C "$OUT/$r" fetch -q origin
  # the previous run's plugins and DEBUG edit, gone before the checkout can trip on them
  git -C "$OUT/$r" reset -q --hard; git -C "$OUT/$r" clean -fdq
done
git -C "$OUT/OnlyKey-Firmware" checkout -q --detach "$FW_PIN"
git -C "$OUT/libraries" checkout -q -B edge/3.1.0 "$LIB_PIN"
# THE PATCHES ARE THE RELEASE'S (as the soft key's stager, scripts/versions/v3.1.0.js): with the version_control plugin,
# exactly the ones its version.json lists, in number order; without it, none - the maintainer's 3.1.0 as published.
# A listed patch that is held or missing stops the build: the list is the release's whole definition.
LISTED=""
case ",$PLUGINS," in
  *,version_control,*) LISTED=$(node -p "require('$PLUGINS_DIR/version_control/plugin.js').patches.join(' ')") || exit 1 ;;
esac
for n in $LISTED; do
  d=$(ls -d "$PATCHES/$n-"* 2>/dev/null | head -1)
  [ -n "$d" ] || { echo "   version_control lists $n - no such patch folder in $PATCHES - not building"; exit 1; }
  [ -f "$d/HOLD" ] && { echo "   version_control lists $n, which is held ($d/HOLD) - not building"; exit 1; }
done
fixes=""
for p in "$PATCHES"/*/*.patch; do
  [ -f "$p" ] || continue
  n=$(basename "$(dirname "$p")" | cut -c1-4)
  case " $LISTED " in *" $n "*) ;; *) continue ;; esac
  # the folder names its repository after the number (gen-fixes.js REPOS): nnnn-libraries-... or nnnn-firmware-...
  case "$(basename "$(dirname "$p")" | cut -d- -f2)" in
    firmware) repo=OnlyKey-Firmware; pin=$FW_PIN ;;
    *) repo=libraries; pin=$LIB_PIN ;;
  esac
  git -C "$OUT/$repo" -c user.name=build-hardkey -c user.email=build@localhost am -q "$p" \
    || { git -C "$OUT/$repo" am --abort; echo "   $(basename "$p") does not apply to $repo $pin - not building"; exit 1; }
  fixes="$fixes $n"
done
say "   patches applied (version_control):${fixes:- none, the release as published}"
# the hex names the public pin and the fixes on it (a `git am` commit's own hash is nobody else's, and moves with the clock)
FIXTAG="$(echo $fixes | sed 's/ /-/g')"; FIXTAG="${FIXTAG:+-fix$FIXTAG}"

# PLUGINS=none: 3.1.0 at the pins with the fixes and nothing else - to tell the plugins' effect from the firmware's
if [ "$PLUGINS" = none ]; then
say "2. plugins: none (3.1.0 at the pins, with the fixes)"
else
say "2. plugins: $PLUGINS (node-onlykey-lib firmware-plugins.js)"
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
ln -s "$OUT/libraries" "$stage/libraries"
ln -s "$OUT/OnlyKey-Firmware/OnlyKey" "$stage/sketch"
node -e '
  const [emu, dir, stage, names, fw, lib] = process.argv.slice(1);
  /* a soft-key-only plugin (plugin.js softKeyOnly: config, key_chain) is never built into a hard key */
  const soft = names.split(",").filter((n) => require(require("path").join(dir, n, "plugin.js")).softKeyOnly);
  if (soft.length) { console.error(`   soft-key-only, not for a hard key: ${soft.join(", ")} - not building`); process.exit(1); }
  const fp = require(require.resolve("node-onlykey-lib/cli/firmware-plugins", { paths: [emu] }));
  const plugins = fp.load(names.split(","), { dir, release: { version: "v3.1.0", pins: { "OnlyKey-Firmware": fw, libraries: lib } } });
  for (const p of fp.apply(plugins, stage)) console.log(`   ${p.name}: ${p.hooks} hooks, ${p.files} files${p.backup ? ", backup section" : ""}`);
' "$EMU" "$PLUGINS_DIR" "$stage" "$PLUGINS" "$FW_PIN" "$LIB_PIN"
( cd "$OUT/libraries/onlykey" && find plugins -name '*.cpp' | sort ) | while read -r f; do
  unit="$OUT/libraries/onlykey/okplugin_unit_$(basename "$f" .cpp).cpp"
  printf '/* GENERATED by build-hardkey.sh: Arduino 1.6.5 does not compile a library'"'"'s plugins/ folder. */\n#include "%s"\n' "$f" > "$unit"
  echo "   unit: $(basename "$unit") -> $f"
done
fi

# DEBUG=0 builds without the debug console, as a release key runs - for telling a DEBUG-only effect from the
# firmware's own (the kit needs DEBUG, so such a build is for trying on a key by hand)
DEBUGTAG=""
if [ "${DEBUG:-1}" = 0 ]; then
  say "3. DEBUG off (no debug console - the kit cannot drive this build)"
  grep -q '^//#define DEBUG //Enable Serial Monitor' "$OUT/libraries/onlykey/onlykey.h" || { echo "DEBUG is not off in onlykey.h - not building"; exit 1; }
  DEBUGTAG="-nodebug"
else
say "3. DEBUG on (the kit drives a developer key through its debug console)"
sed -i 's|^//#define DEBUG //Enable Serial Monitor|#define DEBUG //Enable Serial Monitor|' "$OUT/libraries/onlykey/onlykey.h"
grep -q '^#define DEBUG ' "$OUT/libraries/onlykey/onlykey.h" || { echo "DEBUG line not found in onlykey.h - not building"; exit 1; }
fi

say "4. build (Docker, $IMAGE; log $OUT/build.log)"
rm -f "$OUT/builds/"*.hex
# BUILD_STAMP (8 hex digits, the caller's hash of everything the build is made from - ok-edge tools/firmware.js) takes
# the place of the build time: the Teensy core links the clock's time as __rtc_localtime (boards.txt
# {extra.time.local}), the one value that made two builds of the same sources differ. It only seeds the RTC when no time
# is set, and the OnlyKey firmware never reads the RTC (its time comes from the app). With the stamp the same sources
# build the same hex byte for byte, and the hex carries the stamp (4 bytes, little-endian). Without it: the clock, as
# the official build. The toolchain tree is read-only, so a stamped copy of boards.txt is mounted over its own.
BOARDS=/onlykey/arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/hardware/teensy/avr/boards.txt
stamp_mount=()
STAMPTAG=""
if [ -n "${BUILD_STAMP:-}" ]; then
  [[ "$BUILD_STAMP" =~ ^[0-9a-f]{8}$ ]] || { echo "BUILD_STAMP must be 8 lowercase hex digits - not building"; exit 1; }
  sed "s/{extra.time.local}/0x$BUILD_STAMP/g" "$ARDUINO/arduino-1.6.5-r5/hardware/teensy/avr/boards.txt" > "$OUT/boards.stamped.txt"
  grep -q "__rtc_localtime=0x$BUILD_STAMP" "$OUT/boards.stamped.txt" || { echo "no {extra.time.local} in boards.txt - not building"; exit 1; }
  stamp_mount=(-v "$OUT/boards.stamped.txt:$BOARDS:ro")
  STAMPTAG="-b$BUILD_STAMP"
  say "   build stamp $BUILD_STAMP in place of the build time"
fi
# THE ELF IS KEPT beside the hex (OnlyKey.cpp.elf): the official script copies the hex out and deletes its build folder,
# and with it the only file that says what each function and variable costs in flash and RAM (arm-none-eabi-nm/size -
# the firmware size audit reads it). A copy of the script that also copies the ELF is mounted over its own; the build
# itself is unchanged.
# CPU_MHZ (optional; 72 as the official build): the Teensy's clock, for comparing builds - its size and how long
# the key takes to sign. A copy of the toolchain's preferences with custom_speed changed is mounted over its own.
cpu_mount=()
CPUTAG=""
if [ -n "${CPU_MHZ:-}" ] && [ "$CPU_MHZ" != 72 ]; then
  [[ "$CPU_MHZ" =~ ^(96|72|48|24)$ ]] || { echo "CPU_MHZ must be 96, 72, 48 or 24 - not building"; exit 1; }
  sed "s/^custom_speed=teensy31_72$/custom_speed=teensy31_$CPU_MHZ/" "$ARDUINO/arduino-1.6.5-r5/preferences.txt" > "$OUT/preferences.cpu.txt"
  grep -q "^custom_speed=teensy31_$CPU_MHZ$" "$OUT/preferences.cpu.txt" || { echo "no custom_speed=teensy31_72 in preferences.txt - not building"; exit 1; }
  cpu_mount=(-v "$OUT/preferences.cpu.txt:/onlykey/arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/preferences.txt:ro")
  CPUTAG="-cpu$CPU_MHZ"
  say "   CPU ${CPU_MHZ} MHz (the official build is 72)"
fi
INDOCKER=/onlykey/arduino-1.6.5-r5-teensy_127/in-docker-build.sh
sed 's|^cp /builds/build/\*.hex /builds/.$|cp /builds/build/*.hex /builds/. \&\& cp /builds/build/*.elf /builds/.|' \
  "$ARDUINO/in-docker-build.sh" > "$OUT/in-docker-build.keep-elf.sh"
grep -q 'cp /builds/build/\*.elf' "$OUT/in-docker-build.keep-elf.sh" || { echo "the toolchain's hex copy line changed - not building"; exit 1; }
chmod +x "$OUT/in-docker-build.keep-elf.sh"
rm -f "$OUT/builds/"*.elf
docker run --rm -v "$OUT/builds:/builds" -v "$OUT:/onlykey" -v "$ARDUINO:/onlykey/arduino-1.6.5-r5-teensy_127:ro" "${stamp_mount[@]}" \
  -v "$OUT/in-docker-build.keep-elf.sh:$INDOCKER:ro" "${cpu_mount[@]}" \
  -u "$(id -u):$(id -g)" "$IMAGE" "onlykey/arduino-1.6.5-r5-teensy_127/in-docker-build.sh" > "$OUT/build.log" 2>&1 \
  || { tail -30 "$OUT/build.log"; echo "BUILD FAILED"; exit 1; }
grep -E "Sketch uses|Global variables" "$OUT/build.log" | sed 's/^/   /'
hex="$OUT/builds/OnlyKey.cpp.hex"
[ -s "$hex" ] || { echo "no hex in $OUT/builds"; exit 1; }
[ -s "$OUT/builds/OnlyKey.cpp.elf" ] && echo "   elf: $OUT/builds/OnlyKey.cpp.elf (symbol sizes for the size audit)"

say "5. size guard: the code must end below $LIMIT"
last=$(node -e '
  const { readIntelHex } = require(process.argv[1] + "/lib/flash");
  const { used } = readIntelHex(process.argv[2]); let last = -1, n = 0;
  for (let i = 0; i < used.length; i++) if (used[i]) { last = i; n++; }
  console.log(n, "0x" + last.toString(16));
' "$KIT" "$hex")
echo "   image: ${last% *} bytes, last byte ${last#* }"
if [ $(( ${last#* } )) -ge $(( LIMIT )) ]; then echo "   REFUSED: the code reaches the plugin's flash at $LIMIT"; exit 1; fi

name="v3.1.0-test-${PLUGINS//,/-}-fw${FW_PIN}-lib${LIB_PIN}${FIXTAG}${STAMPTAG}${CPUTAG}${DEBUGTAG}.hex"
cp "$hex" "$OUT/images/$name"
sha=$(sha256sum "$OUT/images/$name" | cut -c1-64)
say "6. $OUT/images/$name"
echo "   sha256 $sha"
echo "HARDKEY-BUILD-DONE"
