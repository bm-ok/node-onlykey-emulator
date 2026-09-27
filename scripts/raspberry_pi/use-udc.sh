#!/usr/bin/env bash
#
# use-udc.sh - choose which USB controller the Pi's OnlyKey gadget is bound to.
#
#     ./scripts/raspberry_pi/use-udc.sh real     # the USB-C port (dwc2): a phone or PC
#     ./scripts/raspberry_pi/use-udc.sh dummy    # dummy_hcd: the Pi itself is the host
#     ./scripts/raspberry_pi/use-udc.sh status
#
# A Pi can offer the gadget to two hosts, one at a time:
#
#   real    fe980000.usb (dwc2) - what gadget-setup.sh binds by default, for the
#           phone on the OTG cable.
#   dummy   dummy_udc.0 (dummy_hcd) - the Pi hosts its own gadget, so
#           /dev/hidraw* appears ON the Pi and onlykey-testing's CLI section can
#           run python-onlykey against the emulator with nothing plugged in.
#           Needs the module: build-dummy-hcd.sh, then install-dummy-hcd.sh.
#
# No root: gadget-setup.sh hands the UDC file to the user. The emulator does not
# have to be stopped either - the gadget bridge rides out an unbind/rebind like
# an unplug and replug. (The test kit, though, will not drive a gadget the
# daemon owns: stop the daemon before `okt run 02-cli`, or set
# OKT_USE_RUNNING_GADGET=yes to share it deliberately.)
#
set -euo pipefail

GADGET=/sys/kernel/config/usb_gadget/onlykey
UDC_FILE="$GADGET/UDC"

status() {
  echo "bound to:    $(cat "$UDC_FILE" 2>/dev/null || echo '(no gadget)')"
  echo "controllers: $(ls /sys/class/udc 2>/dev/null | tr '\n' ' ')"
}

[[ -e $UDC_FILE ]] || { echo "ERROR: no gadget at $GADGET - run scripts/raspberry_pi/gadget-setup.sh" >&2; exit 1; }

case "${1:-status}" in
  status) status; exit 0 ;;
  dummy)  WANT="$(ls /sys/class/udc 2>/dev/null | grep '^dummy_udc' | head -1 || true)"
          [[ -n $WANT ]] || { echo "ERROR: no dummy_udc - build-dummy-hcd.sh, then sudo install-dummy-hcd.sh" >&2; exit 1; } ;;
  real)   WANT="$(ls /sys/class/udc 2>/dev/null | grep -v '^dummy_udc' | head -1 || true)"
          [[ -n $WANT ]] || { echo "ERROR: no real controller - see gadget-setup.sh (dtoverlay=dwc2)" >&2; exit 1; } ;;
  *)      echo "usage: $0 real|dummy|status" >&2; exit 2 ;;
esac

if [[ "$(cat "$UDC_FILE")" == "$WANT" ]]; then
  echo "already bound to $WANT"; exit 0
fi

# Unbind first: a gadget bound to one controller cannot be written to another.
# The kernel answers "No such device" if it was already idle - not an error.
echo "" > "$UDC_FILE" 2>/dev/null || true
sleep 1
echo "$WANT" > "$UDC_FILE"
sleep 1
status
