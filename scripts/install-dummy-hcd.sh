#!/usr/bin/env bash
#
# install-dummy-hcd.sh - install and load the dummy_hcd module, and load it at
# every boot. Root. The one place that does this: gadget-setup.sh calls it.
#
#     ./scripts/build-dummy-hcd.sh          # no root; any distro, incl. the Pi
#     sudo ./scripts/install-dummy-hcd.sh   # this
#
# dummy_hcd is a virtual USB host controller plus a virtual UDC in one module:
# a gadget bound to its UDC (dummy_udc.0) enumerates on THIS machine, so
# /dev/hidraw* appears locally with real USB descriptors. That is what lets
# onlykey-testing's CLI section run python-onlykey against the emulator with
# nothing plugged in - on a Raspberry Pi too, where the real controller (dwc2)
# stays free for a phone. Which controller the gadget uses is chosen when it
# is bound; see scripts/raspberry_pi/use-udc.sh.
#
# A module loads only into the exact kernel it was built for. After a kernel
# upgrade: build-dummy-hcd.sh again (its cache and kernel.org fallback make it
# one command), then this again.
#
set -euo pipefail

KREL="$(uname -r)"
KO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/build/dummy_hcd/dummy_hcd.ko}"

if [[ $(id -u) -ne 0 ]]; then
  echo "ERROR: needs root:  sudo $0" >&2
  exit 1
fi

if [[ ! -f $KO ]]; then
  echo "ERROR: $KO not found. Build it first (no root needed):" >&2
  echo "       ./scripts/build-dummy-hcd.sh" >&2
  exit 1
fi

# Built for this kernel? modinfo reads the vermagic the build stamped in; a
# mismatch would only surface as a cryptic "Invalid module format" from insmod.
BUILT_FOR="$(/sbin/modinfo -F vermagic "$KO" 2>/dev/null | awk '{print $1}')"
if [[ -n $BUILT_FOR && $BUILT_FOR != "$KREL" ]]; then
  echo "ERROR: $KO was built for $BUILT_FOR, but this kernel is $KREL." >&2
  echo "       Rebuild it:  ./scripts/build-dummy-hcd.sh" >&2
  exit 1
fi

echo "==> Installing dummy_hcd into /lib/modules/$KREL/updates"
install -D -m 0644 "$KO" "/lib/modules/$KREL/updates/dummy_hcd.ko"
depmod -a

echo "==> Loading dummy_hcd"
modprobe dummy_hcd 2>/dev/null || insmod "/lib/modules/$KREL/updates/dummy_hcd.ko"

echo "==> Loading it at boot (/etc/modules-load.d/dummy_hcd.conf)"
printf 'dummy_hcd\n' > /etc/modules-load.d/dummy_hcd.conf

echo "    controllers now: $(ls /sys/class/udc 2>/dev/null | tr '\n' ' ')"
