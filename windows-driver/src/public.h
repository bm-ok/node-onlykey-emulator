/*
 * public.h - the contract between okvhid.dll and the emulator.
 *
 * Included by the driver, and transcribed by whatever speaks to it from the
 * Node side. If a frame layout changes here it must change there too;
 * PROTOCOL_VERSION is the only thing that will catch a mismatch.
 *
 * A named pipe, not an ioctl
 * --------------------------
 * The driver registered a private device interface and the emulator opened it
 * with DeviceIoControl. That worked, and then stopped working the moment
 * HIDCLASS was correctly layered on top - a device interface resolves to the
 * device object that registered it, and the create goes to the TOP of that
 * object's stack, which is now HIDCLASS. It fails the create because it is
 * not an open of a HID collection. There is no way to have both.
 *
 * A UMDF driver is an ordinary user-mode process (WUDFHost), so it can host a
 * named pipe instead, and Windows PnP leaves the data path alone entirely.
 *
 * The driver is the SERVER. Two reasons:
 *
 *   Security. WUDFHost runs under a service account, not the logged-in user.
 *   If the emulator created the pipe its default ACL would exclude the driver,
 *   and Node cannot set one. As server, the driver writes its own descriptor.
 *
 *   Hot-plug. A pipe exists exactly as long as its device does. Remove the
 *   device to simulate unplugging the token and the driver instance goes away,
 *   the pipe closes, and the emulator sees a clean disconnect. Plug it back in
 *   and the pipe reappears. That is the whole of the unplug story - it is what
 *   power.js gets on Linux by unbinding the UDC.
 *
 * One pipe per interface, named for it, so a partially-plugged device is a
 * coherent state rather than a protocol error.
 */

#pragma once

#define OKVHID_PROTOCOL_VERSION 2

/* Largest report on any OnlyKey interface: the raw-HID ones are 64 bytes,
 * the keyboard is 8. One size so both ends can use one buffer. */
#define OKVHID_MAX_REPORT 64

/*
 * \\.\pipe\okvhid-0 .. okvhid-3, numbered by USB interface:
 *   0 keyboard   1 fido   2 vendor   3 seremu
 */
#define OKVHID_PIPE_PREFIX L"\\\\.\\pipe\\okvhid-"
#define OKVHID_PIPE_PREFIX_A "\\\\.\\pipe\\okvhid-"

/*
 * Frame kinds. Direction naming follows USB rather than either process:
 * "input" is device -> host, what the token sends Windows.
 */
#define OKVHID_FRAME_HELLO   0   /* driver -> emulator, once on connect     */
#define OKVHID_FRAME_INPUT   1   /* emulator -> driver, an input report     */
#define OKVHID_FRAME_OUTPUT  2   /* driver -> emulator, an output report    */
#define OKVHID_FRAME_FEATURE 3   /* driver -> emulator, a feature report    */
/*
 * emulator -> driver: the cable was pulled - remove this device. No payload.
 *
 * An orderly removal (pnputil, devgen) can be VETOED by any application
 * holding the collection open, and the OnlyKey App does: the device then
 * never goes, and when "plugged back in" no new device arrives, so the App
 * never sees the key again. A real cable pull cannot be vetoed. On this frame
 * the driver fails its own device (WdfDeviceSetFailed, no restart), which is
 * a surprise removal - the same thing a pulled cable causes.
 */
#define OKVHID_FRAME_UNPLUG  4

#include <pshpack1.h>

/*
 * Every frame starts with this. Fixed layout, little-endian, no padding - the
 * JS side reads it with readUInt32LE at these offsets.
 */
typedef struct _OKVHID_FRAME_HEADER {
    unsigned int Magic;     /* OKVHID_FRAME_MAGIC                          */
    unsigned int Kind;      /* OKVHID_FRAME_*                              */
    unsigned int Length;    /* payload bytes following this header         */
} OKVHID_FRAME_HEADER;

/*
 * Payload of OKVHID_FRAME_HELLO. The driver sends this immediately on accept
 * so the emulator learns which interface it reached and how the descriptors
 * describe it, without having to hard-code any of it.
 */
typedef struct _OKVHID_HELLO {
    unsigned int Version;           /* OKVHID_PROTOCOL_VERSION             */
    unsigned int InterfaceNumber;   /* 0 kbd, 1 fido, 2 vendor, 3 seremu   */
    unsigned int InputReportSize;   /* device -> host, bytes               */
    unsigned int OutputReportSize;  /* host -> device, bytes               */
    unsigned int Protocol;          /* 1 = boot keyboard, 0 = raw HID      */
    unsigned int Subclass;
    unsigned short VendorId;        /* 0x1D50                              */
    unsigned short ProductId;       /* 0x60FC                              */
} OKVHID_HELLO;

#include <poppack.h>

#define OKVHID_FRAME_MAGIC 0x48564B4FU   /* 'OKVH' little-endian */

/*
 * Who may connect.
 *
 * D:(A;;GA;;;AU) - generic all, authenticated users. The driver runs as a
 * service account and the emulator as the logged-in user, so the descriptor
 * has to name someone they have in common; AU is the narrowest that does.
 *
 * This is the security boundary of the whole design, and it is a wide one:
 * anything running as an authenticated user can feed reports to a device
 * Windows treats as a security key. That is the intended behaviour for an
 * emulator whose entire purpose is to be driven by a test harness, and it is
 * a concrete reason this driver should not be production-signed as it stands.
 */
#define OKVHID_PIPE_SDDL L"D:(A;;GA;;;AU)"
