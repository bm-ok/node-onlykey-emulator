/*
 * gen-descriptors.js - emit src/descriptors.h from the emulator's own
 * descriptor table.
 *
 *     node windows-driver/gen-descriptors.js
 *
 * The driver must present byte-identical descriptors to the real device, and
 * the only way to guarantee that over time is to not type them twice. This
 * reads ../emulator/lib/hid-descriptors.js - the same table the UHID bridge
 * and both configfs gadget scripts read.
 *
 * There is no fallback copy and no search path. Living in the same repo as the
 * table means there is exactly one place it can be, and a stale duplicate of a
 * report descriptor is worse than a build failure: it produces a device that
 * enumerates and then behaves subtly wrong.
 *
 * descriptors.h is generated at build time and not committed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'src', 'descriptors.h');
const SRC = path.resolve(__dirname, '..', 'emulator', 'lib', 'hid-descriptors.js');

function loadDescriptors() {
  if (!fs.existsSync(SRC)) {
    console.error('Descriptor table not found: ' + SRC);
    process.exit(1);
  }
  const d = require(SRC);
  if (!Array.isArray(d.INTERFACES) || d.INTERFACES.length !== 4) {
    throw new Error(SRC + ': INTERFACES is not the expected four entries');
  }
  return { modulePath: SRC, ...d };
}

/* Hardware-ID suffix per interface. The INF root-enumerates one device per
 * entry, and the driver picks its descriptor by matching this. */
const HWID = {
  keyboard: 'kbd',
  fido: 'fido',
  vendor: 'vendor',
  seremu: 'seremu',
};

function cArray(buf, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (let i = 0; i < buf.length; i += 12) {
    const chunk = Array.from(buf.slice(i, i + 12))
      .map((b) => '0x' + b.toString(16).toUpperCase().padStart(2, '0'))
      .join(', ');
    lines.push(pad + chunk + (i + 12 < buf.length ? ',' : ''));
  }
  return lines.join('\n');
}

function main() {
  const d = loadDescriptors();

  const vid = '0x' + d.VENDOR_ID.toString(16).toUpperCase().padStart(4, '0');
  const pid = '0x' + d.PRODUCT_ID.toString(16).toUpperCase().padStart(4, '0');

  const blocks = d.INTERFACES.map((s, i) => {
    const tag = HWID[s.name];
    return `
/* ---- hid.usb${i} : ${s.name} ------------------------------------------------
 * protocol ${s.protocol}, subclass ${s.subclass}, report length ${s.inSize}
 * ${s.name === 'keyboard'
    ? 'Boot keyboard. The trailing 8-byte Feature report is OnlyKey\'s\n * SET_REPORT side channel (usb_dev.c -> setBuffer[] -> process_setreport).'
    : s.name === 'fido'
      ? 'Usage page 0xF1D0 - CTAP-HID. This is the interface Windows WebAuthn\n * looks for when it enumerates FIDO2 authenticators.'
      : s.name === 'vendor'
        ? 'Usage page 0xFFAB - the OnlyKey vendor protocol (python-onlykey, app).'
        : 'Usage page 0xFFC9 - SEREMU debug console. 64 in, 32 out; the\n * asymmetry is real and getting it wrong overruns the report buffer.'}
 */
static const UCHAR g_OkReportDescriptor_${tag}[] = {
${cArray(s.desc, 4)}
};
`;
  }).join('');

  const table = d.INTERFACES.map((s, i) => {
    const tag = HWID[s.name];
    return `    { L"${tag}", ${s.iface}, ${s.protocol}, ${s.subclass}, ` +
           `${s.inSize}, ${s.outSize},\n` +
           `      g_OkReportDescriptor_${tag}, ` +
           `sizeof(g_OkReportDescriptor_${tag}), L"OnlyKey ${s.name}" },`;
  }).join('\n');

  const header = `/*
 * descriptors.h - the authentic OnlyKey HID report descriptors.
 *
 * GENERATED FILE - do not edit. Regenerate with:
 *
 *     node windows-driver/gen-descriptors.js
 *
 * Source of truth:
 *   emulator/lib/hid-descriptors.js
 *
 * These bytes are the ones a physical OnlyKey presents. They were captured
 * from hardware (\`usbhid-dump -m 16c0\`) and are shared verbatim by the
 * emulator's UHID bridge and both of its configfs gadget scripts. Do not
 * "clean them up": the exact byte sequence is what host-side FIDO2 and
 * OnlyKey clients validate against.
 */

#pragma once

#define OKVHID_VENDOR_ID    ${vid}
#define OKVHID_PRODUCT_ID   ${pid}
#define OKVHID_VERSION      0x0100

#define OKVHID_MANUFACTURER L"${d.MANUFACTURER}"
#define OKVHID_PRODUCT      L"${d.PRODUCT_NAME}"
#define OKVHID_SERIAL       L"${d.SERIAL_NUMBER}"
${blocks}
/*
 * One entry per USB interface, in interface order. The INF root-enumerates
 * root\\okvhid_<Tag> for each, and the driver selects its row by matching the
 * suffix of its hardware ID - so the four devices Windows creates line up
 * one-to-one with the four interfaces of the real composite device.
 */
typedef struct _OKVHID_INTERFACE {
    PCWSTR       Tag;              /* hardware-ID suffix, e.g. L"fido"      */
    UCHAR        InterfaceNumber;  /* bInterfaceNumber on real hardware     */
    UCHAR        Protocol;         /* 1 = boot keyboard, 0 = raw HID        */
    UCHAR        Subclass;
    USHORT       InputReportSize;  /* device -> host, bytes                 */
    USHORT       OutputReportSize; /* host -> device, bytes                 */
    const UCHAR *ReportDescriptor;
    USHORT       ReportDescriptorSize;
    PCWSTR       FriendlyName;
} OKVHID_INTERFACE, *POKVHID_INTERFACE;

static const OKVHID_INTERFACE g_OkInterfaces[] = {
${table}
};

#define OKVHID_INTERFACE_COUNT \\
    (sizeof(g_OkInterfaces) / sizeof(g_OkInterfaces[0]))
`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, header, 'utf8');

  console.log('wrote ' + OUT);
  console.log('  from ' + d.modulePath);
  console.log('  ' + vid + ':' + pid + ' ' + d.MANUFACTURER + '/' + d.PRODUCT_NAME);
  for (const s of d.INTERFACES) {
    console.log(`  hid.usb${s.iface} ${s.name.padEnd(9)} ` +
      `${s.desc.length} bytes  proto=${s.protocol}/${s.subclass} ` +
      `in=${s.inSize} out=${s.outSize}`);
  }
}

main();
