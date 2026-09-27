#!/usr/bin/env bash
#
# build-dummy-hcd.sh - build the dummy_hcd kernel module out of tree.
#
# dummy_hcd is a virtual USB Device Controller: it provides both a virtual host
# controller and a UDC, so a gadget bound to it enumerates as a real USB device
# on this machine. That is what lets the emulator present genuine USB string
# and interface descriptors - `manufacturer: CRYPTOTRUST`, `interface: 0..3` -
# instead of the empty manufacturer and interface -1 that UHID is forced to
# report, having no USB parent for hidapi to read.
#
# It matters because the OnlyKey test kit and python-onlykey both identify the
# device the way real software does:
#
#     d.manufacturer === 'CRYPTOTRUST' && d.product === 'ONLYKEY' && d.interface === 3
#
# Under UHID that can never match, and none of the component checkouts beside
# this repo may be modified to make it match - so the emulator has to supply the
# fields for real.
#
# Ubuntu ships `# CONFIG_USB_DUMMY_HCD is not set`, so no package provides it and
# it has to be compiled. Everything else the gadget needs (libcomposite,
# usb_f_hid, CONFIG_USB_CONFIGFS_F_HID) is already in the stock kernel.
#
# This script needs no root. Installing the result does - see
# setup-permissions.sh, which is where the one-time privileged setup lives.
#
set -euo pipefail

KREL="$(uname -r)"
UPSTREAM="${KREL%%-*}"          # 7.0.0-28-generic -> 7.0.0
BUILD_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/build/dummy_hcd}"

KBUILD=/lib/modules/$KREL/build
if [[ ! -d $KBUILD ]]; then
  echo "ERROR: no kernel build tree for $KREL." >&2
  echo "       sudo apt install linux-headers-$KREL" >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"
DEST="$BUILD_DIR/dummy_hcd.c"
SRC_PATH=drivers/usb/gadget/udc/dummy_hcd.c

# ---------------------------------------------------------------- the source
#
# Exactly one file out of the kernel tree is needed, and where it lives depends
# on how this machine got its kernel. Rather than assume one layout, try them in
# order of cost and directness and stop at the first that yields the file.
# OKEMU_DUMMY_HCD_SRC=/path/to/dummy_hcd.c skips the search entirely.
#
# The ladder deliberately does not hard-code a kernel version anywhere: each
# rung derives what it needs from `uname -r` and from what dpkg reports about
# the headers that are already installed, so it holds for the kernel this host
# runs today and for whatever it is upgraded to.

# GNU tar detects compression on extraction, so one call reads .bz2, .gz and .xz
# alike - which matters because Ubuntu ships linux-source as .tar.bz2, Debian as
# .tar.xz, and the archive's orig tarballs as .tar.gz. --occurrence=1 stops tar
# at the first match instead of reading the remaining ~1.5 GB of the tree.
extract_from_tar() {
  tar -xO --wildcards --occurrence=1 -f "$1" "*/$SRC_PATH" 2>/dev/null > "$DEST" || true
  [[ -s $DEST ]]
}

try_explicit() {
  [[ -n ${OKEMU_DUMMY_HCD_SRC:-} && -s ${OKEMU_DUMMY_HCD_SRC:-} ]] || return 1
  echo "==> Using OKEMU_DUMMY_HCD_SRC=$OKEMU_DUMMY_HCD_SRC"
  cp "$OKEMU_DUMMY_HCD_SRC" "$DEST"
}

# A self-built or mainline kernel points /lib/modules/$KREL/build at the tree it
# was compiled from, sources and all. Distro -headers packages ship only the
# build scaffolding, so this misses there and the next rung picks it up - but
# when it does hit, it is the one copy guaranteed to match the running kernel.
try_build_tree() {
  local f="$KBUILD/$SRC_PATH"
  [[ -f $f ]] || return 1
  echo "==> Using the kernel build tree: $f"
  cp "$f" "$DEST"
}

# An already-unpacked tree under /usr/src, from linux-source having been
# extracted or a hand-placed checkout.
try_unpacked() {
  local d f
  for d in /usr/src/linux-source-"$UPSTREAM"* /usr/src/linux-"$UPSTREAM"*; do
    f="$d/$SRC_PATH"
    if [[ -f $f ]]; then
      echo "==> Using unpacked source: $f"
      cp "$f" "$DEST"
      return 0
    fi
  done
  return 1
}

# The linux-source package, where the distro publishes one. Ubuntu names it
# linux-source-7.0.0.tar.bz2 and Debian linux-source-6.1.tar.xz, so match on a
# glob rather than on either convention. Both forms are derived from `uname -r`
# and no looser pattern is tried: a tarball of some *other* kernel version would
# match a bare linux-source-*.tar.* and compile into a module that does not
# belong to the running kernel.
try_source_package() {
  local t
  for t in /usr/src/linux-source-"$UPSTREAM".tar.* \
           /usr/src/linux-source-"${UPSTREAM%.*}".tar.*; do
    if [[ -f $t ]] && extract_from_tar "$t"; then
      echo "==> Extracted dummy_hcd.c from $t"
      return 0
    fi
  done
  return 1
}

# Last resort on a Debian/Ubuntu host: read it out of the source tarball in the
# archive pool.
#
# Ubuntu publishes linux-source-<ver> only for a release's own kernel. An HWE
# kernel is built from a differently-named source package - linux-hwe-7.0 for
# 7.0.0-28-generic on noble - that ships no linux-source binary at all, so
# `apt install linux-source-7.0.0` cannot work and never will. `apt-get source`
# cannot reach it either, deb-src being off by default. The tarball itself is
# right there in the pool, though, so ask dpkg which source package built the
# headers that are installed and fetch that. tar stops at the first match, so
# this pulls only as much of the tarball as it takes to reach drivers/.
try_archive() {
  command -v dpkg-query >/dev/null 2>&1 || return 1

  local src_pkg
  src_pkg="$(dpkg-query -W -f='${source:Package}' "linux-headers-$KREL" 2>/dev/null || true)"
  [[ -n $src_pkg ]] || return 1

  local fetch_cmd
  if command -v curl >/dev/null 2>&1; then
    fetch_cmd=curl
  elif command -v wget >/dev/null 2>&1; then
    fetch_cmd=wget
  else
    return 1
  fi

  # Pool sharding: lib* packages sit under pool/<component>/libx/, everything
  # else under its first letter.
  local shard
  case $src_pkg in
    lib?*) shard="${src_pkg:0:4}" ;;
    *)     shard="${src_pkg:0:1}" ;;
  esac

  # Every mirror and component apt is actually configured for, rather than a
  # guess at archive.ubuntu.com/main: a kernel can be published outside main
  # (linux-oem, vendor kernels), the host may be on a regional or local mirror,
  # and a security update may reach security.ubuntu.com's pool first.
  # archive.ubuntu.com/main is appended as a floor, deduped.
  local -a bases=()
  local uri comp
  while read -r uri comp; do
    [[ -n ${uri:-} && -n ${comp:-} ]] || continue
    bases+=("${uri%/}/pool/$comp")
  done < <(apt-get indextargets --format '$(REPO_URI) $(COMPONENT)' 2>/dev/null | sort -u)
  bases+=("http://archive.ubuntu.com/ubuntu/pool/main")

  # The orig tarball carries the upstream version only: 7.0.0-28.28~24.04.1 is
  # packaged as <src>_7.0.0.orig.tar.*. The extension has been .gz for years but
  # is not promised, so try the three Debian permits.
  local base ext url seen=""
  for base in "${bases[@]}"; do
    case " $seen " in *" $base "*) continue ;; esac
    seen="$seen $base"
    for ext in gz xz bz2; do
      url="$base/$shard/$src_pkg/${src_pkg}_${UPSTREAM}.orig.tar.$ext"

      # HEAD first: a 404 body piped into tar would look like an empty match,
      # and there are a dozen candidates to get through.
      if [[ $fetch_cmd == curl ]]; then
        curl -fsI --max-time 20 "$url" >/dev/null 2>&1 || continue
      else
        wget -q --spider --timeout=20 "$url" 2>/dev/null || continue
      fi

      echo "==> Fetching dummy_hcd.c from the archive"
      echo "    $url"

      # tar auto-detects compression only when it can seek, i.e. only with -f.
      # Reading a pipe it gives up with "Archive is compressed. Use -z option",
      # so the decompressor has to be named explicitly here - unlike
      # extract_from_tar(), which works on a real file.
      local zflag
      case $ext in
        gz)  zflag=-z ;;
        xz)  zflag=-J ;;
        bz2) zflag=-j ;;
      esac

      # tar exits as soon as it has the file, which SIGPIPEs the downloader.
      # That is the point of doing it this way, but it means neither exit
      # status says anything; the file is the test.
      set +o pipefail
      if [[ $fetch_cmd == curl ]]; then
        curl -fsSL "$url" | tar -xO "$zflag" --wildcards --occurrence=1 "*/$SRC_PATH" > "$DEST" || true
      else
        wget -qO- "$url" | tar -xO "$zflag" --wildcards --occurrence=1 "*/$SRC_PATH" > "$DEST" || true
      fi
      set -o pipefail

      [[ -s $DEST ]] && return 0
    done
  done
  return 1
}

# The kernel version as kernel.org names it. `uname -r` carries a distro
# suffix after the upstream version - 7.0.0-28-generic on Ubuntu, and
# 6.18.39+rpt-rpi-v8 on Raspberry Pi OS, where UPSTREAM above keeps the "+rpt"
# (it only cuts at the first "-"). Neither suffix exists upstream.
KORG_VER="${UPSTREAM%%+*}"

# Every source that worked is kept here, one file per kernel version, so a
# rebuild - after `make clean`, or on the next boot of a reinstalled checkout -
# never has to find or download it again. A kernel upgrade changes the version
# and so misses the cache, which is right: the file must match the kernel.
CACHE="$BUILD_DIR/src/dummy_hcd-$KORG_VER.c"

try_cache() {
  [[ -s $CACHE ]] || return 1
  echo "==> Using the cached source for $KORG_VER: $CACHE"
  cp "$CACHE" "$DEST"
}

# Last resort that works on ANY distro: the file straight from the upstream
# stable tree, at exactly this kernel's version. This is what built the module
# on a Raspberry Pi (6.18.39+rpt-rpi-v8), whose headers package ships no .c
# files and whose archive publishes no kernel source tarball. Distro rungs go
# first because a distro may patch the driver; dummy_hcd is rarely touched, and
# the module still has to load, which is the real check.
try_kernel_org() {
  local url="https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/plain/$SRC_PATH?h=v$KORG_VER"
  echo "==> Fetching dummy_hcd.c from kernel.org (stable, v$KORG_VER)"
  echo "    $url"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 60 "$url" -o "$DEST" || { rm -f "$DEST"; return 1; }
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=60 -O "$DEST" "$url" || { rm -f "$DEST"; return 1; }
  else
    return 1
  fi
  # A missing tag answers with an HTML error page, not a 404 curl can see.
  grep -q 'dummy_hcd' "$DEST" 2>/dev/null || { rm -f "$DEST"; return 1; }
}

try_explicit || try_cache || try_build_tree || try_unpacked || try_source_package || try_archive || try_kernel_org || true

if [[ ! -s $DEST ]]; then
  rm -f "$DEST"
  echo "ERROR: could not obtain $SRC_PATH for $KREL." >&2
  echo "       Tried: OKEMU_DUMMY_HCD_SRC, the cache, $KBUILD, /usr/src, the archive" >&2
  echo "       pool, and kernel.org (v$KORG_VER)." >&2
  echo "       Fetch that file from your kernel's source and point at it with:" >&2
  echo "         OKEMU_DUMMY_HCD_SRC=/path/to/dummy_hcd.c $0" >&2
  exit 1
fi

mkdir -p "$(dirname "$CACHE")"
[[ -s $CACHE ]] || cp "$DEST" "$CACHE"

printf 'obj-m += dummy_hcd.o\n' > "$BUILD_DIR/Makefile"

echo "==> Building against /lib/modules/$KREL/build"
make -C "/lib/modules/$KREL/build" M="$BUILD_DIR" modules

echo
echo "Built: $BUILD_DIR/dummy_hcd.ko"
echo "Install and load it with:  sudo ./scripts/install-dummy-hcd.sh"
