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
# Under UHID that can never match, and nothing under onlykey/ may be modified to
# make it match - so the emulator has to supply the fields for real.
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
SRC_TAR=/usr/src/linux-source-${KREL%%-*}.tar.bz2
BUILD_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/build/dummy_hcd}"

if [[ ! -d /lib/modules/$KREL/build ]]; then
  echo "ERROR: no kernel build tree for $KREL." >&2
  echo "       sudo apt install linux-headers-$KREL" >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"

#
# Second source of the same file, for HWE kernels.
#
# `linux-source-<version>` exists in the archive for the GA kernel ONLY. On
# 24.04 running linux-generic-hwe-24.04 - which is the default on a desktop
# install, not an exotic choice - `uname -r` reports 7.0.0-28-generic while the
# newest linux-source the archive offers is 6.8.0. The apt line printed by the
# old error message therefore could not be satisfied on the machine that saw it,
# which made the script look broken rather than under-supplied.
#
# The same file lives in the kernel's own source package, which `apt-get source`
# fetches WITHOUT root. Only one file out of it is wanted, so this downloads
# rather than unpacks the tree.
#
extract_from_apt_source() {
  local workdir="$BUILD_DIR/kernel-source" img src tarball found
  rm -rf "$workdir"; mkdir -p "$workdir"

  img="$(dpkg -S "/boot/vmlinuz-$KREL" 2>/dev/null | cut -d: -f1 | head -1)"
  [[ -n $img ]] || return 1

  # The binary package names its source; for a signed kernel that source is
  # itself a wrapper (linux-signed-hwe-7.0) and the tree is in the unsigned one.
  src="$(apt-cache show "$img" 2>/dev/null | awk -F': ' '/^Source:/{print $2; exit}')"
  [[ -n $src ]] || src="$img"
  src="${src/linux-signed-/linux-}"

  echo "==> Fetching kernel source package '$src' (no root needed)"
  ( cd "$workdir" && apt-get source --download-only "$src" ) || return 1

  tarball="$(find "$workdir" -maxdepth 1 -name '*.orig.tar.*' | head -1)"
  [[ -n $tarball ]] || return 1

  tar -xf "$tarball" -C "$workdir" --wildcards '*/drivers/usb/gadget/udc/dummy_hcd.c' || return 1
  found="$(find "$workdir" -path '*/drivers/usb/gadget/udc/dummy_hcd.c' | head -1)"
  [[ -n $found ]] || return 1

  cp "$found" "$BUILD_DIR/dummy_hcd.c"
  rm -rf "$workdir"
}

if [[ -f $SRC_TAR ]]; then
  echo "==> Extracting dummy_hcd.c from $SRC_TAR"
  # The tarball's single top-level directory is named after the package, e.g.
  # linux-source-7.0.0/. Derived rather than read from `tar -tf | head -1`,
  # which makes tar die of SIGPIPE and, under `set -o pipefail`, aborts here.
  TOP="linux-source-${KREL%%-*}"
  tar -xjf "$SRC_TAR" -O "$TOP/drivers/usb/gadget/udc/dummy_hcd.c" > "$BUILD_DIR/dummy_hcd.c"
elif extract_from_apt_source; then
  :
else
  echo "ERROR: no kernel source for $KREL." >&2
  echo >&2
  echo "  Tried $SRC_TAR (the GA-kernel package) and the kernel's own source" >&2
  echo "  package via apt-get source. On an HWE kernel only the second exists," >&2
  echo "  and it needs deb-src enabled:" >&2
  echo >&2
  echo "      sudo sed -i 's/^Types: deb\$/Types: deb deb-src/' \\" >&2
  echo "          /etc/apt/sources.list.d/ubuntu.sources" >&2
  echo "      sudo apt update" >&2
  echo >&2
  echo "  Then run this again. On a GA kernel this also works:" >&2
  echo "      sudo apt install linux-source-${KREL%%-*}" >&2
  exit 1
fi

if [[ ! -s $BUILD_DIR/dummy_hcd.c ]]; then
  echo "ERROR: extracted dummy_hcd.c is empty" >&2
  exit 1
fi
echo "    dummy_hcd.c: $(wc -l < "$BUILD_DIR/dummy_hcd.c") lines"

printf 'obj-m += dummy_hcd.o\n' > "$BUILD_DIR/Makefile"

echo "==> Building against /lib/modules/$KREL/build"
make -C "/lib/modules/$KREL/build" M="$BUILD_DIR" modules

echo
echo "Built: $BUILD_DIR/dummy_hcd.ko"
echo "Install it with:  sudo ./scripts/setup-permissions.sh"
