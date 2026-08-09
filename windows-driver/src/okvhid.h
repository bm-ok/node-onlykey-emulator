/*
 * okvhid.h - internal types shared by the driver's three source files.
 *
 * okvhid is a UMDF 2 HID minidriver with no hardware behind it. The INF
 * root-enumerates four devices - one per OnlyKey USB interface - and each
 * instance picks its row out of g_OkInterfaces[] (descriptors.h) by matching
 * the suffix of its hardware ID.
 *
 *   root\okvhid_kbd     -> hid.usb0, boot keyboard, 8-byte reports
 *   root\okvhid_fido    -> hid.usb1, usage page 0xF1D0, CTAP-HID
 *   root\okvhid_vendor  -> hid.usb2, usage page 0xFFAB
 *   root\okvhid_seremu  -> hid.usb3, usage page 0xFFC9
 *
 * The stack the INF builds, top to bottom:
 *
 *   HIDCLASS.SYS   mshidumdf.sys   WUDFRd.sys   okvhid.dll   root\okvhid_*
 *
 * Report flow
 * -----------
 *   device -> host   a frame arrives on the pipe -> completes a pending
 *                    IOCTL_HID_READ_REPORT, or is ringed until one arrives.
 *   host -> device   HIDCLASS issues WriteReport or SetFeature -> written
 *                    straight out of the pipe.
 *
 * Only the inbound direction rings. Outbound is a synchronous write to a pipe
 * that is either connected or not: if the emulator is absent the token is
 * unplugged as far as Windows is concerned, and the report has nowhere to go.
 */

#pragma once

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <strsafe.h>
#include <wdf.h>
#include <hidport.h>

#include "public.h"
#include "descriptors.h"

/*
 * How many inbound reports to hold when Windows is not reading. Small on
 * purpose: a token that has fallen this far behind is broken rather than
 * busy, and silently absorbing megabytes of stale reports would hide it.
 * Overflow drops the OLDEST, because a stale FIDO frame is worthless while
 * the newest is the live transaction.
 */
#define OKVHID_RING_DEPTH 32

typedef struct _OKVHID_ENTRY {
    ULONG Length;
    UCHAR Data[OKVHID_MAX_REPORT];
} OKVHID_ENTRY;

typedef struct _OKVHID_RING {
    OKVHID_ENTRY Items[OKVHID_RING_DEPTH];
    ULONG        Head;                 /* next slot to write                */
    ULONG        Count;
    ULONGLONG    Dropped;              /* cumulative, so it stays visible   */
} OKVHID_RING;

typedef struct _DEVICE_CONTEXT {
    /* Our row in g_OkInterfaces[]. Never NULL after EvtDeviceAdd. */
    const OKVHID_INTERFACE *Iface;

    /* Guards InputRing and ReadReportQueue. */
    WDFSPINLOCK Lock;

    /* device -> host */
    WDFQUEUE    ReadReportQueue;       /* parked IOCTL_HID_READ_REPORT      */
    OKVHID_RING InputRing;

    /*
     * The keyboard's 8-byte Feature report is readable as well as writable:
     * OnlyKey's usb_dev.c fills setBuffer[] from SET_REPORT and a host may
     * read it back. Last value written wins.
     */
    UCHAR  FeatureCache[OKVHID_MAX_REPORT];
    USHORT FeatureCacheLength;

    /*
     * The pipe to the emulator.
     *
     * PipeLock is a wait lock rather than a spin lock because a write can wait
     * on I/O, which a spin lock forbids. It guards Pipe and PipeConnected, and
     * it serialises writers so a frame cannot be torn - the length field is
     * how the reader finds the next header, so one interleaved write would
     * desynchronise the stream permanently.
     *
     * StopEvent ends whatever the pipe thread is blocked in; PipeStopping is
     * what it tests between operations. Both are needed - either alone leaves
     * a window where the thread checks the flag just before blocking on
     * something only the event would end. WriteEvent belongs to whoever holds
     * PipeLock; only one write is ever in flight.
     *
     * ListenPipe is the server handle the thread is waiting on, published so
     * that the stop path can close it. It is owned by interlocked exchange
     * rather than by PipeLock: whoever swaps out a non-NULL value closes it,
     * so the stop path can reclaim it without taking a lock the thread it is
     * trying to stop might be holding.
     *
     * The handle is what keeps the pipe NAME registered, so releasing it is
     * the difference between a stranded thread and a stranded name. A name
     * outlives the device it belonged to and blocks the next device from
     * taking it, because the pipe allows one instance.
     */
    WDFWAITLOCK PipeLock;
    HANDLE      Pipe;
    HANDLE      PipeThread;
    HANDLE      StopEvent;
    HANDLE      WriteEvent;
    HANDLE volatile ListenPipe;
    volatile BOOLEAN PipeConnected;
    volatile BOOLEAN PipeStopping;
} DEVICE_CONTEXT, *PDEVICE_CONTEXT;

WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(DEVICE_CONTEXT, DeviceGetContext)

/* driver.c */
DRIVER_INITIALIZE                DriverEntry;
EVT_WDF_DRIVER_DEVICE_ADD        OkvhidEvtDeviceAdd;
EVT_WDF_OBJECT_CONTEXT_CLEANUP   OkvhidEvtDriverContextCleanup;
EVT_WDF_DEVICE_FILE_CREATE       OkvhidEvtDeviceFileCreate;
EVT_WDF_DEVICE_CONTEXT_CLEANUP   OkvhidEvtDeviceCleanup;

/* hid.c */
EVT_WDF_IO_QUEUE_IO_DEVICE_CONTROL OkvhidEvtIoDeviceControl;

/* bridge.c */
BOOLEAN  OkvhidTryPopInput(_In_ PDEVICE_CONTEXT Ctx, _Out_ OKVHID_ENTRY *Out);

/*
 * Call after parking a request on the manual queue. A report can land in the
 * ring between the pop that found it empty and the forward that parked the
 * request; without this it would sit there until the next delivery, which on
 * an idle FIDO interface is a long time.
 */
VOID     OkvhidDrainInput(_In_ PDEVICE_CONTEXT Ctx);

/* Called from the pipe thread when the emulator sends a report. */
NTSTATUS OkvhidDeliverInput(_In_ PDEVICE_CONTEXT Ctx,
                            _In_reads_bytes_(Length) const VOID *Data,
                            _In_ ULONG Length);

/* Called from hid.c when Windows sends the device a report. Kind is
 * OKVHID_FRAME_OUTPUT or OKVHID_FRAME_FEATURE. */
NTSTATUS OkvhidDeliverOutput(_In_ PDEVICE_CONTEXT Ctx, _In_ ULONG Kind,
                             _In_reads_bytes_(Length) const VOID *Data,
                             _In_ ULONG Length);

NTSTATUS OkvhidPipeStart(_In_ PDEVICE_CONTEXT Ctx);
VOID     OkvhidPipeStop(_In_ PDEVICE_CONTEXT Ctx);

/* trace.c - off unless HKLM\SOFTWARE\okvhid!Trace is 1. See trace.c. */
VOID OkvhidTrace(_In_opt_ PDEVICE_CONTEXT Ctx, _In_ PCSTR Format, ...);
