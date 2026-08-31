#!/usr/bin/env bash
#
# Materialises the workspace: the Python venv generated from the component
# checkouts beside this repo, and the built emulator addon.
#
# This repo does not contain the components - it sits beside them. The layout is
# nine repos side by side in one folder:
#
#     <workspace>/
#       node-onlykey-emulator/   <- this repo, where setup.sh lives
#       arduino-1.6.5-r5-teensy_127/
#       libraries/
#       OnlyKey-Firmware/
#       onlykey.github.io/
#       lib-agent/
#       python-onlykey/
#       onlykey-testing/
#       OnlyKey-App/
#       okpqc-venv/              <- generated here, beside the repos
#
# Each component is a separate checkout you work on directly, and any of them can
# be swapped wholesale - a different fork, an upstream revision, a branch under
# test - without this repo changing. So a component that is already there is used
# exactly as it is: nothing here fetches, pulls or re-clones into a checkout you
# already have. Nothing pins a revision either.
#
# If components are missing, this script names them and stops. Pass --clone to
# have it clone the missing ones (tracking their default branch) into that same
# folder, beside this repo - which is how somebody who has cloned only the
# emulator gets from there to a full workspace:
#
#     ./setup.sh --clone
#
# The venv lands beside the repos rather than inside one, so it is not sitting in
# a git repo anybody commits from. onlykey-testing resolves it at exactly that
# spot - its CHECKOUTS_ROOT is the parent of its own checkout.
#
# Safe to re-run: existing checkouts and an existing venv are left alone.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The folder this repo is IN, holding the other eight checkouts beside it.
CHECKOUTS="$(cd "$ROOT/.." && pwd)"
VENV="$CHECKOUTS/okpqc-venv"

AGE_VERSION="v1.2.1"

usage() {
  cat <<EOF
usage: ./setup.sh [--clone] [--no-privileged]

  --clone   clone any missing component repos into $CHECKOUTS,
            beside this one. Without it, missing components are named
            and setup stops. Components already present are never
            re-fetched either way.

  --no-privileged
            skip the device-access step (scripts/setup-permissions.sh),
            which is the only part that needs sudo. Everything else
            still runs; the emulator will build but will have no device
            node, so onlykey-testing's device sections all skip.
EOF
}

CLONE_MISSING=0
DO_PRIVILEGED=1
for arg in "$@"; do
  case "$arg" in
    --clone)          CLONE_MISSING=1 ;;
    --no-privileged)  DO_PRIVILEGED=0 ;;
    -h|--help) usage; exit 0 ;;
    *)         echo "!! unknown argument: $arg" >&2; echo >&2; usage >&2; exit 1 ;;
  esac
done

# Downloads $1 to stdout with whichever fetcher this machine has. Neither is
# guaranteed - a stock Ubuntu server has wget and no curl, and a minimal
# container often has curl and no wget.
FETCHER=""
if command -v curl >/dev/null 2>&1; then
  FETCHER="curl"
elif command -v wget >/dev/null 2>&1; then
  FETCHER="wget"
fi

fetch() {
  case "$FETCHER" in
    curl) curl -fsSL "$1" ;;
    wget) wget -qO- "$1" ;;
    *)    echo "!! no downloader available" >&2; return 1 ;;
  esac
}

# Check everything up front. Failing on the first missing tool beats discovering
# it after a venv build.
missing=()
for tool in git python3 make tar install npm node; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
[ -n "$FETCHER" ] || missing+=("curl or wget")

if [ ${#missing[@]} -gt 0 ]; then
  echo "!! missing required tools: ${missing[*]}" >&2
  echo "   Docker is optional and only gates the device .hex build." >&2
  exit 1
fi

# Soft checks: these do not stop setup, but each one silently costs you a whole
# tier of the project later, so they are named here rather than discovered as a
# confusing skip or a "command not found" at the end.
#
# pm2 supervises the emulator (README's Running section, and every npm script in
# this repo). It was a documented requirement that nothing installed: setup
# finished, printed "start it with pm2", and pm2 was not there.
if ! command -v pm2 >/dev/null 2>&1; then
  echo "== pm2 not found - installing it, since nothing else here supplies it"
  if npm install -g pm2 >/dev/null 2>&1; then
    echo "   installed pm2 $(pm2 --version 2>/dev/null || echo '?')"
  else
    echo "!! could not install pm2 globally (npm prefix is probably not writable)." >&2
    echo "   Install it yourself before starting the emulator:" >&2
    echo "     sudo npm install -g pm2      # or: npm config set prefix ~/.npm-global" >&2
  fi
fi

# The gadget transport compiles dummy_hcd against the running kernel. Without
# headers, setup-permissions.sh falls back to UHID - which works, but hidapi
# then reports no manufacturer and interface -1, so anything identifying an
# OnlyKey by those fields does not see one.
if [ ! -d "/lib/modules/$(uname -r)/build" ]; then
  echo "!! no kernel headers for $(uname -r) - the USB gadget cannot be built." >&2
  echo "   The UHID fallback still works, but real clients will not recognise" >&2
  echo "   the device. To get the gadget:" >&2
  echo "     sudo apt install linux-headers-$(uname -r)" >&2
fi

echo "== using $FETCHER for downloads"
echo "== components live in $CHECKOUTS"

# --- component checkouts ----------------------------------------------------
#
# Directory name, then the repo it would be cloned from if it is not there. The
# directory name is what everything downstream resolves, so a checkout under one
# of these names is used whatever its origin - that is the swap.
COMPONENTS=(
  "arduino-1.6.5-r5-teensy_127 https://github.com/bm-ok/arduino-1.6.5-r5-teensy_127"
  "libraries                   https://github.com/bm-ok/0c-coder-libraries"
  "OnlyKey-Firmware            https://github.com/bm-ok/OnlyKey-Firmware"
  "onlykey.github.io           https://github.com/bm-ok/0c-coder-onlykey.github.io"
  "lib-agent                   https://github.com/bm-ok/0c-coder-lib-agent"
  "python-onlykey              https://github.com/bm-ok/0c-coder-python-onlykey"
  "onlykey-testing             https://github.com/bm-ok/onlykey-testing"
  "OnlyKey-App                 https://github.com/bm-ok/OnlyKey-App"
)

absent=()
occupied=()
for entry in "${COMPONENTS[@]}"; do
  read -r dir url <<<"$entry"
  if [ -e "$CHECKOUTS/$dir/.git" ]; then
    echo "== $dir present, using it as-is"
  elif [ -e "$CHECKOUTS/$dir" ]; then
    # Something is in the way that is not a checkout. Cloning would fail with
    # git's "destination path already exists"; say what is actually wrong.
    occupied+=("$dir")
  else
    absent+=("$entry")
  fi
done

if [ ${#occupied[@]} -gt 0 ]; then
  echo "!! these exist beside this repo but are not git checkouts:" >&2
  for dir in "${occupied[@]}"; do echo "     $CHECKOUTS/$dir" >&2; done
  echo "   Move or remove them, then re-run." >&2
  exit 1
fi

if [ ${#absent[@]} -gt 0 ] && [ "$CLONE_MISSING" -eq 0 ]; then
  echo "!! missing component checkouts, expected beside this repo in $CHECKOUTS:" >&2
  for entry in "${absent[@]}"; do
    read -r dir url <<<"$entry"
    echo "     $dir  ($url)" >&2
  done
  echo >&2
  echo "   Put your own checkouts there under those names, or run:" >&2
  echo "     ./setup.sh --clone" >&2
  echo "   to clone the missing ones. Either way the ones already there are" >&2
  echo "   left untouched." >&2
  exit 1
fi

for entry in "${absent[@]}"; do
  read -r dir url <<<"$entry"
  echo "== cloning $dir"
  git clone "$url" "$CHECKOUTS/$dir"

  # Only for what we just cloned. A checkout that was already there is used as
  # it is, and `submodule update` in it would be a fetch into somebody's working
  # repo. (The onlykey-solo-python dependency itself comes from PyPI; this is
  # the source tree, and a fresh clone leaves it empty.)
  if [ "$dir" = "python-onlykey" ]; then
    git -C "$CHECKOUTS/$dir" submodule update --init onlykey-solo-python
  fi
done

# --- Python venv ------------------------------------------------------------
#
# Generated from the checkouts above, which is why it is not committed - and why
# it belongs beside them rather than inside any one of them. onlykey-testing's
# lib/cli.js resolves its tools through <checkouts>/okpqc-venv/bin (VENV_BIN), so
# all of these have to land here or tests fail in ways that look like device
# faults rather than a missing tool.
echo "== provisioning okpqc-venv"
[ -d "$VENV" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip

#   onlykey        -> onlykey-cli, age-plugin-onlykey
#   lib-agent      -> the agent framework
#   onlykey-agent  -> onlykey-agent, onlykey-gpg
"$VENV/bin/pip" install -e "$CHECKOUTS/python-onlykey[age]"
"$VENV/bin/pip" install -e "$CHECKOUTS/lib-agent" -e "$CHECKOUTS/lib-agent/agents/onlykey"

# age and age-keygen are upstream Go binaries. pip cannot supply them -
# python-onlykey's [age] extra is only cryptography + kyber-py - but test/05 and
# test/11 shell out to `age`, so fetch them into the same bin/ the tests search.
if [ ! -x "$VENV/bin/age" ]; then
  case "$(uname -m)" in
    x86_64|amd64)  AGE_ARCH=amd64 ;;
    aarch64|arm64) AGE_ARCH=arm64 ;;
    *)             AGE_ARCH="" ;;
  esac
  if [ -n "$AGE_ARCH" ]; then
    echo "== fetching age $AGE_VERSION ($AGE_ARCH)"
    AGE_URL="https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-${AGE_ARCH}.tar.gz"
    tmp="$(mktemp -d)"
    fetch "$AGE_URL" | tar -xz -C "$tmp"
    install -m 0755 "$tmp/age/age" "$tmp/age/age-keygen" "$VENV/bin/"
    rm -rf "$tmp"
  else
    echo "!! unknown arch $(uname -m) - install age/age-keygen into" >&2
    echo "   $VENV/bin by hand, or test/05 and test/11 will fail." >&2
  fi
fi

# --- device toolchain -------------------------------------------------------
#
# Only needed to build a .hex for real hardware, or to check that a firmware
# change still compiles for the device. The emulator itself does not use it.
#
# The image must be amd64 whatever the host is: the legacy Arduino/Teensyduino
# bundle ships pre-compiled x86_64 binaries, so a native arm64 build succeeds and
# then produces an image that cannot execute them. DOCKER_DEFAULT_PLATFORM is a
# no-op on x86_64 and routes through qemu-user-static's binfmt handler elsewhere
# - correct but slow. `make docker-build` needs the same variable set.
if ! command -v docker >/dev/null 2>&1; then
  echo "!! docker not found - skipping the firmware toolchain image."
  echo "   The emulator still builds; you just cannot produce a device .hex."
elif [ "$(uname -m)" != "x86_64" ] && [ ! -e /proc/sys/fs/binfmt_misc/qemu-x86_64 ]; then
  echo "!! no qemu-x86_64 binfmt handler - skipping the firmware toolchain image."
  echo "   Install qemu-user-static and binfmt-support, then re-run to build it."
  echo "   The emulator still builds; you just cannot produce a device .hex."
else
  echo "== building the firmware toolchain image (linux/amd64)"
  DOCKER_DEFAULT_PLATFORM=linux/amd64 \
    make -C "$CHECKOUTS/arduino-1.6.5-r5-teensy_127" docker-build-toolchain
fi

# --- node -------------------------------------------------------------------
#
# The emulator has its own dependencies and a native addon. The root package has
# neither dependencies nor workspaces, so installing there does not reach it.
echo "== building the emulator addon"
cd "$ROOT/emulator"
# gypfile:true makes npm run `node-gyp rebuild` as an implicit install script.
# binding.gyp includes sources.gypi, which only `npm run stage` generates - and
# that runs later - so the implicit build always fails on a fresh checkout.
# Skip it, then drive the real build through rebuild (stage -> configure ->
# build); plain `build` would skip configure and find no Makefile.
npm install --ignore-scripts
npm run rebuild

echo "== installing the GUI"
cd "$ROOT/ui"
npm install

# The checkouts that are Node projects in their own right. None of them is a
# workspace of this repo - they are swappable components beside it - so each
# needs its own install: the test kit for node-hid and the @noble crypto it
# verifies against, the OnlyKey App for NW.js, and the web apps for their
# webpack build.
for pkg in onlykey-testing OnlyKey-App onlykey.github.io; do
  if [ -f "$CHECKOUTS/$pkg/package.json" ]; then
    echo "== installing $pkg"
    (cd "$CHECKOUTS/$pkg" && npm install)
  fi
done

# nw.js for onlykey-testing's sections 3 and 4 (the web app and the App).
#
# The kit looks for exactly nwjs-sdk-v0.114.0-linux-x64 in its OWN node_modules
# and does not declare it - it is a ~150MB download that the kit deliberately
# does not carry. OnlyKey-App's `nw` dependency does not satisfy it: that is
# ^0.71.1 and the plain build, not the 0.114.0 SDK, and only the SDK has the
# devtools protocol the kit drives the window with.
#
# --no-save because onlykey-testing is a component checkout, not ours to edit -
# this populates node_modules and leaves its package.json alone. It runs AFTER
# the loop above for the same reason: a later `npm install` there would prune an
# unsaved package straight back out.
NW_PKG="nw@0.114.0-sdk"
NW_DIR="$CHECKOUTS/onlykey-testing/node_modules/nw/nwjs-sdk-v0.114.0-linux-x64/nw"
if [ -f "$CHECKOUTS/onlykey-testing/package.json" ] && [ ! -x "$NW_DIR" ]; then
  echo "== installing $NW_PKG for onlykey-testing (~150MB, sections 3 and 4)"
  if ! (cd "$CHECKOUTS/onlykey-testing" && npm install --no-save "$NW_PKG"); then
    echo "!! nw.js install failed - sections 3 and 4 will skip themselves." >&2
    echo "   Retry in $CHECKOUTS/onlykey-testing:  npm install --no-save $NW_PKG" >&2
    echo "   or point the kit at an existing SDK build with OKT_NW_BINARY." >&2
  fi
fi

cd "$ROOT"
npm install

# --- device access (the one privileged step) --------------------------------
#
# README documents three steps; this script used to do 1 and 3 and never mention
# 2, then print "Setup complete". It was not complete: without this, there is no
# uhid module, no udev rule, no gadget and no lowered mmap_min_addr, so the
# emulator builds and then has nothing to present a device on. onlykey-testing
# degrades by SKIPPING rather than failing, so the result was a green run that
# had quietly not exercised the device at all.
#
# It is a separate script because it is the only thing here that needs root, and
# it stays separately runnable for rebuilding the gadget. Setup calls it so that
# one command leaves a workspace that can actually run the project.
privileged_needed() {
  [ ! -e /sys/kernel/config/usb_gadget/onlykey ] && return 0
  [ "$(cat /proc/sys/vm/mmap_min_addr 2>/dev/null || echo 65536)" -gt 4096 ] && return 0
  return 1
}

if [ "$DO_PRIVILEGED" -eq 0 ]; then
  echo "== skipping device access (--no-privileged)"
elif ! privileged_needed; then
  echo "== device access already set up"
elif [ "$(id -u)" -eq 0 ]; then
  "$ROOT/scripts/setup-permissions.sh"
elif command -v sudo >/dev/null 2>&1; then
  echo "== device access needs root once - running scripts/setup-permissions.sh"
  sudo "$ROOT/scripts/setup-permissions.sh" \
    || echo "!! setup-permissions.sh failed - re-run it yourself, or pass --no-privileged" >&2
else
  echo "!! no sudo, and device access is not set up. Run as root:" >&2
  echo "     $ROOT/scripts/setup-permissions.sh" >&2
fi

# --- what actually happened -------------------------------------------------
#
# Report state rather than assert success: every line below is read back from
# the system, so a partial setup says so instead of printing "complete".
echo
echo "-- setup summary"
[ -x "$ROOT/emulator/build/Release/onlykey_emulator.node" ] \
  && echo "   [x] emulator addon built" \
  || echo "   [ ] emulator addon MISSING - the device sections cannot run"
[ -x "$CHECKOUTS/okpqc-venv/bin/onlykey-cli" ] \
  && echo "   [x] okpqc-venv (onlykey-cli, agents, age)" \
  || echo "   [ ] okpqc-venv incomplete - onlykey-testing section 2 will skip"
command -v pm2 >/dev/null 2>&1 \
  && echo "   [x] pm2" \
  || echo "   [ ] pm2 MISSING - you cannot start the emulator until it is installed"
[ -x "$NW_DIR" ] \
  && echo "   [x] nw.js SDK" \
  || echo "   [ ] nw.js MISSING - onlykey-testing sections 3 and 4 will skip"
privileged_needed \
  && echo "   [ ] device access NOT set up - run: sudo ./scripts/setup-permissions.sh" \
  || echo "   [x] device access (gadget up, mmap_min_addr ok)"

echo
if privileged_needed; then
  echo "Setup finished with the device step outstanding - see above."
else
  echo "Setup complete. Start the emulator with pm2 - see README's Running section."
  echo "Then check the kit agrees:  cd $CHECKOUTS/onlykey-testing && node bin/okt.js caps"
fi
