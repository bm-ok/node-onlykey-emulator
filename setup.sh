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
usage: ./setup.sh [--clone]

  --clone   clone any missing component repos into $CHECKOUTS,
            beside this one. Without it, missing components are named
            and setup stops. Components already present are never
            re-fetched either way.
EOF
}

CLONE_MISSING=0
for arg in "$@"; do
  case "$arg" in
    --clone)   CLONE_MISSING=1 ;;
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

cd "$ROOT"
npm install

# ------------------------------------------- runtime deps of the NW.js GUIs
#
# Two OS-level things the GUIs need that nothing above installs, both invisible
# until you launch something. npm install fetches the NW.js binary happily
# without either, so a setup that "succeeded" still hands you an app that will
# not start and, if it does, has no icons. Neither is needed to BUILD anything,
# which is exactly why they are checked here rather than in the preflight up
# top: there is nothing to fail fast about, only something to be told.
#
# Printed at the END for the same reason. The preflight's rule - "failing on
# the first missing tool beats discovering it after a venv build" - is about
# saving time, and does not apply to a warning. What applies is being SEEN, and
# several minutes of npm output scroll between the top of this script and the
# prompt.
#
# NOT installed automatically: --clone is the only thing this script will
# mutate outside the workspace, and it is opt-in. So these name the package the
# way the preflight names a missing tool, and leave the decision where it
# belongs. Both are tested by CAPABILITY rather than by package name, because
# the package names differ per distro and, on Debian/Ubuntu, per release.

runtime_notes=()

# libasound2 - NW.js links libasound.so.2 and will not start without it. A
# fresh minimal VM image routinely lacks it.
#
# The library is what is tested, not a package, and the recommendation is
# `libasound2-dev` rather than the runtime package on purpose. Ubuntu's 64-bit
# time_t transition renamed the runtime package `libasound2` -> `libasound2t64`
# (24.04+), so `apt install libasound2` now fails outright with no candidate on
# current releases while still being the name in every older set of
# instructions. `libasound2-dev` did NOT change, and depends on whichever
# runtime package this release ships - so it is the one incantation that works
# across the rename. The headers it drags in are unused here; nothing in this
# workspace compiles against ALSA.
if ! ldconfig -p 2>/dev/null | grep -q 'libasound\.so\.2'; then
  runtime_notes+=(
    "libasound.so.2 is missing - NW.js will not start without it (the emulator GUI and the OnlyKey App)."
    "     Debian/Ubuntu:  sudo apt install libasound2-dev   # survives the libasound2 -> libasound2t64 rename"
    "     Fedora:         sudo dnf install alsa-lib"
    "     Arch:           sudo pacman -S alsa-lib"
  )
fi

# An emoji font - the OnlyKey App draws its whole left-hand nav with LITERAL
# EMOJI. No icon font is bundled and no icon library is a dependency; the
# glyphs are written straight into the JSX (src/App.tsx), so the app borrows
# whatever emoji font the OS provides and ships no fallback for having none.
#
# Without one, every icon above U+FFFF is tofu: Setup, Keys, Backup, Firmware,
# Preferences, Advanced and Tools all become squares. What makes that confusing
# rather than merely ugly is that it is PARTIAL - the two low-codepoint symbols
# the DejaVu fallback happens to carry, the Slots gear U+2699 and the theme sun
# U+2600, keep rendering. Some icons work and some do not, which reads as a
# broken build or a missing asset in one of these repos, and it is neither.
#
# Asked of fontconfig as "does anything cover U+1F511", a codepoint the app
# actually uses, so no particular font or package is required.
if command -v fc-list >/dev/null 2>&1 && ! fc-list ':charset=1F511' 2>/dev/null | grep -q .; then
  runtime_notes+=(
    "No emoji font found - the OnlyKey App's nav icons will render as squares."
    "     Debian/Ubuntu:  sudo apt install fonts-noto-color-emoji"
    "     Fedora:         sudo dnf install google-noto-emoji-color-fonts"
    "     Arch:           sudo pacman -S noto-fonts-emoji"
  )
fi

if [ ${#runtime_notes[@]} -gt 0 ]; then
  echo >&2
  echo "!! The workspace is built, but the GUIs need these from the OS:" >&2
  for note in "${runtime_notes[@]}"; do
    echo "   $note" >&2
  done
fi

echo
echo "Setup complete. Start the emulator with pm2 - see README's Running section."
