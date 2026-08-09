/*
 * bridge.c - the named pipe to the emulator, and the report plumbing.
 *
 * The driver has no hardware. The device it represents is the OnlyKey
 * emulator running as an ordinary Node process on the same machine, and this
 * is how the two halves reach each other.
 *
 *   emulator -> driver   a frame arrives on the pipe -> OkvhidDeliverInput
 *                        completes a pending IOCTL_HID_READ_REPORT, or rings
 *                        the report until one arrives.
 *
 *   driver -> emulator   hid.c gets WriteReport or SetFeature from HIDCLASS
 *                        -> OkvhidDeliverOutput writes a frame.
 *
 * Only the inbound direction needs a ring. Outbound is a synchronous write to
 * a pipe that is either connected or not, so there is nothing to queue: if
 * the emulator is not there, the token is unplugged as far as Windows is
 * concerned and the report has nowhere to go.
 *
 * See public.h for why this is a pipe and why the driver is the server.
 */

#include "okvhid.h"

#include <sddl.h>

static VOID OkvhidRingPushLocked(_Inout_ OKVHID_RING *Ring,
                                 _In_reads_bytes_(Length) const VOID *Data,
                                 _In_ ULONG Length);
static BOOLEAN OkvhidRingPopLocked(_Inout_ OKVHID_RING *Ring,
                                   _Out_ OKVHID_ENTRY *Out);
static DWORD WINAPI OkvhidPipeThread(LPVOID Param);
static BOOL OkvhidPipeWriteLocked(_In_ PDEVICE_CONTEXT Ctx,
                                  _In_reads_bytes_(Length) const VOID *Buf,
                                  _In_ DWORD Length);

/* ------------------------------------------------------------------ rings */

/*
 * Overflow drops the OLDEST entry. A stale FIDO frame is worthless while the
 * newest one is the live transaction, so keeping the head is the only useful
 * policy. Dropped is counted rather than silently absorbed - a backlog means
 * something is wrong and it should be visible.
 *
 * Caller holds the lock.
 */
static VOID
OkvhidRingPushLocked(_Inout_ OKVHID_RING *Ring,
                     _In_reads_bytes_(Length) const VOID *Data,
                     _In_ ULONG Length)
{
    OKVHID_ENTRY *slot;

    if (Length > OKVHID_MAX_REPORT) Length = OKVHID_MAX_REPORT;

    if (Ring->Count == OKVHID_RING_DEPTH) {
        Ring->Dropped++;
        Ring->Count--;                  /* about to overwrite the oldest */
    }

    slot = &Ring->Items[Ring->Head];
    slot->Length = Length;
    RtlCopyMemory(slot->Data, Data, Length);

    Ring->Head = (Ring->Head + 1) % OKVHID_RING_DEPTH;
    Ring->Count++;
}

/* Pop the oldest. Head is one past the newest, so the oldest sits Count
 * slots behind it. */
static BOOLEAN
OkvhidRingPopLocked(_Inout_ OKVHID_RING *Ring, _Out_ OKVHID_ENTRY *Out)
{
    ULONG index;

    if (Ring->Count == 0) {
        RtlZeroMemory(Out, sizeof(*Out));
        return FALSE;
    }

    index = (Ring->Head + OKVHID_RING_DEPTH - Ring->Count) % OKVHID_RING_DEPTH;
    *Out = Ring->Items[index];
    Ring->Count--;
    return TRUE;
}

BOOLEAN
OkvhidTryPopInput(_In_ PDEVICE_CONTEXT Ctx, _Out_ OKVHID_ENTRY *Out)
{
    BOOLEAN got;

    WdfSpinLockAcquire(Ctx->Lock);
    got = OkvhidRingPopLocked(&Ctx->InputRing, Out);
    WdfSpinLockRelease(Ctx->Lock);
    return got;
}

/* ------------------------------------------------------------- delivery */

/*
 * device -> host. Ring the report, then hand as much of the ring as possible
 * to whoever is parked on a read.
 *
 * Ring-first is not a detail. The obvious shape - look for a parked request
 * and only ring the report if there is none - races the parking side:
 * OkvhidReadReport finds the ring empty, and before it can park, a delivery
 * finds the queue empty and rings the report. It then sits unclaimed until
 * the NEXT delivery, which on an idle FIDO interface can be a very long time.
 * Going through the ring unconditionally and draining afterwards means
 * whichever order those two interleave in, the last one to run does the
 * match-up.
 *
 * Requests are always completed with the lock dropped: hidclass completes
 * straight back into a fresh IOCTL_HID_READ_REPORT on a busy interface, which
 * re-enters this file.
 */
static VOID
OkvhidDrain(_In_ PDEVICE_CONTEXT Ctx)
{
    for (;;) {
        WDFREQUEST   request = NULL;
        OKVHID_ENTRY entry;
        NTSTATUS     status;
        PVOID        buffer = NULL;
        size_t       available = 0;

        WdfSpinLockAcquire(Ctx->Lock);

        if (Ctx->InputRing.Count == 0) {
            WdfSpinLockRelease(Ctx->Lock);
            return;
        }

        status = WdfIoQueueRetrieveNextRequest(Ctx->ReadReportQueue, &request);
        if (!NT_SUCCESS(status)) {
            /* Nobody reading. The ring keeps it. */
            ULONG held = Ctx->InputRing.Count;
            WdfSpinLockRelease(Ctx->Lock);
            OkvhidTrace(Ctx, "drain: no reader (0x%08X), %u held", status, held);
            return;
        }

        /* Only consume the entry once a request is definitely in hand. */
        (VOID)OkvhidRingPopLocked(&Ctx->InputRing, &entry);

        WdfSpinLockRelease(Ctx->Lock);

        status = WdfRequestRetrieveOutputBuffer(request, entry.Length,
                                                &buffer, &available);
        if (NT_SUCCESS(status) && available >= entry.Length) {
            RtlCopyMemory(buffer, entry.Data, entry.Length);
            WdfRequestSetInformation(request, entry.Length);
            WdfRequestComplete(request, STATUS_SUCCESS);
            OkvhidTrace(Ctx, "drain: delivered %u", entry.Length);
        } else {
            OkvhidTrace(Ctx, "drain: buffer %Iu for %u (0x%08X)",
                        available, entry.Length, status);
            /*
             * That reader cannot hold this report. Fail the one request and
             * put the report back - it is still valid and the next reader may
             * have a big enough buffer.
             */
            WdfRequestComplete(request, NT_SUCCESS(status)
                                   ? STATUS_BUFFER_TOO_SMALL : status);
            WdfSpinLockAcquire(Ctx->Lock);
            OkvhidRingPushLocked(&Ctx->InputRing, entry.Data, entry.Length);
            WdfSpinLockRelease(Ctx->Lock);
            return;
        }
    }
}

NTSTATUS
OkvhidDeliverInput(_In_ PDEVICE_CONTEXT Ctx,
                   _In_reads_bytes_(Length) const VOID *Data,
                   _In_ ULONG Length)
{
    WdfSpinLockAcquire(Ctx->Lock);
    OkvhidRingPushLocked(&Ctx->InputRing, Data, Length);
    WdfSpinLockRelease(Ctx->Lock);

    OkvhidDrain(Ctx);
    return STATUS_SUCCESS;
}

VOID
OkvhidDrainInput(_In_ PDEVICE_CONTEXT Ctx)
{
    OkvhidDrain(Ctx);
}

/*
 * host -> device. Straight out of the pipe.
 *
 * Serialised on PipeLock because HIDCLASS can issue writes from more than one
 * thread and a torn frame would desynchronise the reader for good - the
 * length field is how it finds the next header.
 *
 * A disconnected pipe is not an error worth propagating. Windows writing to a
 * token that is not plugged in is an ordinary state, and failing the HID
 * request would surface it as a device fault rather than as silence. The same
 * goes for a write that times out: see OkvhidPipeWriteLocked, which is where
 * "the emulator stopped reading" becomes "the token is unplugged".
 */
NTSTATUS
OkvhidDeliverOutput(_In_ PDEVICE_CONTEXT Ctx, _In_ ULONG Kind,
                    _In_reads_bytes_(Length) const VOID *Data,
                    _In_ ULONG Length)
{
    OKVHID_FRAME_HEADER header;
    BYTE frame[sizeof(OKVHID_FRAME_HEADER) + OKVHID_MAX_REPORT];

    if (Length > OKVHID_MAX_REPORT) Length = OKVHID_MAX_REPORT;

    header.Magic  = OKVHID_FRAME_MAGIC;
    header.Kind   = Kind;
    header.Length = Length;

    RtlCopyMemory(frame, &header, sizeof(header));
    RtlCopyMemory(frame + sizeof(header), Data, Length);

    WdfWaitLockAcquire(Ctx->PipeLock, NULL);
    if (Ctx->PipeConnected) {
        if (!OkvhidPipeWriteLocked(Ctx, frame, sizeof(header) + Length)) {
            /* Gone, or too far behind to tell apart from gone. The reader
             * thread hits the same failure and cycles the connection. */
            Ctx->PipeConnected = FALSE;
        }
    }
    WdfWaitLockRelease(Ctx->PipeLock);

    return STATUS_SUCCESS;
}

/* ------------------------------------------------------------------ pipe */

/*
 * All pipe I/O is overlapped, for correctness rather than throughput.
 *
 * Two properties depend on it. A write must be able to give up: Windows keeps
 * handing the FIDO interface output reports whether or not anyone is reading,
 * so the pipe buffer fills whenever the emulator is stopped or paused, and a
 * write that waits indefinitely does so holding PipeLock - which the pipe
 * thread needs to recycle the connection. Overlapped writes take a deadline
 * instead and release the lock.
 *
 * And a wait must be cancellable from another thread, which neither
 * ConnectNamedPipe nor ReadFile is when blocking. Every wait here is on an
 * event pair including StopEvent, so shutdown ends it immediately and the
 * thread closes its own handle - owned from creation to close, touched by
 * nobody else.
 */

/*
 * How long a write waits before giving up on the emulator.
 *
 * This is the unplug threshold in disguise. A client this far behind is not
 * slow, it is gone, and continuing to wait for it means holding up HID
 * requests from Windows. Dropping the report is what a real token does when
 * it is not plugged in.
 */
#define OKVHID_WRITE_TIMEOUT_MS 250

/*
 * Write a whole buffer, or fail. Caller holds PipeLock.
 *
 * The lock is held across the wait, so it is bounded by the timeout above
 * rather than by the peer's behaviour - which is the entire point.
 */
static BOOL
OkvhidPipeWriteLocked(_In_ PDEVICE_CONTEXT Ctx, _In_reads_bytes_(Length) const VOID *Buf,
                      _In_ DWORD Length)
{
    OVERLAPPED ov;
    DWORD      written = 0;

    if (Ctx->Pipe == NULL || Ctx->Pipe == INVALID_HANDLE_VALUE) return FALSE;

    RtlZeroMemory(&ov, sizeof(ov));
    ov.hEvent = Ctx->WriteEvent;
    ResetEvent(Ctx->WriteEvent);

    if (!WriteFile(Ctx->Pipe, Buf, Length, &written, &ov)) {
        if (GetLastError() != ERROR_IO_PENDING) return FALSE;

        if (WaitForSingleObject(Ctx->WriteEvent, OKVHID_WRITE_TIMEOUT_MS)
                != WAIT_OBJECT_0) {
            /*
             * Cancel, then wait for the cancellation to land. The OVERLAPPED
             * is on this stack frame and the kernel writes to it when the I/O
             * completes - returning before then corrupts whatever the stack
             * becomes next.
             */
            CancelIoEx(Ctx->Pipe, &ov);
            (void)GetOverlappedResult(Ctx->Pipe, &ov, &written, TRUE);
            return FALSE;
        }

        if (!GetOverlappedResult(Ctx->Pipe, &ov, &written, FALSE)) return FALSE;
    }

    return (written == Length);
}

/*
 * Read exactly `want` bytes, or fail.
 *
 * The pipe is byte mode, so this really does loop. Message mode looks like the
 * better fit - one frame, one message - but it puts the framing in the hands
 * of however the client happens to issue its writes: two frames in one
 * WriteFile become one message, a header-sized read returns ERROR_MORE_DATA,
 * and the connection dies over something the protocol already handles. The
 * magic and length fields are the frame boundary; nothing else needs to be.
 *
 * No deadline here, unlike writes. An idle OnlyKey says nothing for minutes at
 * a time and that is not a fault; StopEvent is what ends the wait.
 */
static BOOL
OkvhidReadExact(_In_ HANDLE Pipe, _In_ HANDLE Event, _In_ HANDLE StopEvent,
                _Out_writes_bytes_(Want) VOID *Buf, _In_ DWORD Want)
{
    BYTE *p = (BYTE *)Buf;
    DWORD got = 0;

    while (got < Want) {
        OVERLAPPED ov;
        HANDLE     waits[2];
        DWORD      n = 0;

        RtlZeroMemory(&ov, sizeof(ov));
        ov.hEvent = Event;
        ResetEvent(Event);

        if (!ReadFile(Pipe, p + got, Want - got, &n, &ov)) {
            if (GetLastError() != ERROR_IO_PENDING) return FALSE;

            waits[0] = Event;
            waits[1] = StopEvent;
            if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0) {
                CancelIoEx(Pipe, &ov);
                (void)GetOverlappedResult(Pipe, &ov, &n, TRUE);
                return FALSE;
            }

            if (!GetOverlappedResult(Pipe, &ov, &n, FALSE)) return FALSE;
        }

        if (n == 0) return FALSE;       /* peer closed */
        got += n;
    }

    return TRUE;
}

/*
 * Wait for a client, or for the stop signal. Returns TRUE if connected.
 */
static BOOL
OkvhidPipeAccept(_In_ HANDLE Pipe, _In_ HANDLE Event, _In_ HANDLE StopEvent)
{
    OVERLAPPED ov;
    HANDLE     waits[2];
    DWORD      n = 0;

    RtlZeroMemory(&ov, sizeof(ov));
    ov.hEvent = Event;
    ResetEvent(Event);

    if (ConnectNamedPipe(Pipe, &ov)) return TRUE;

    switch (GetLastError()) {
    case ERROR_PIPE_CONNECTED:
        /* The client beat us to it. Success, oddly spelled. */
        return TRUE;

    case ERROR_IO_PENDING:
        waits[0] = Event;
        waits[1] = StopEvent;
        if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0) {
            CancelIoEx(Pipe, &ov);
            (void)GetOverlappedResult(Pipe, &ov, &n, TRUE);
            return FALSE;
        }
        return GetOverlappedResult(Pipe, &ov, &n, FALSE) ? TRUE : FALSE;

    default:
        return FALSE;
    }
}

/*
 * One thread per device. Creates the pipe, waits for the emulator, reads
 * frames until it goes away, then does it again.
 *
 * The thread owns the pipe handle for its whole life - creates it, closes it,
 * and nothing else ever touches it. Stopping is a signal on StopEvent, not a
 * handle closed from underneath, so there is no window in which two threads
 * hold the same handle value and one of them is wrong about it still existing.
 */
static DWORD WINAPI
OkvhidPipeThread(LPVOID Param)
{
    PDEVICE_CONTEXT ctx = (PDEVICE_CONTEXT)Param;
    WCHAR name[64];
    SECURITY_ATTRIBUTES sa;
    PSECURITY_DESCRIPTOR sd = NULL;
    HANDLE ioEvent;

    (void)StringCchPrintfW(name, ARRAYSIZE(name), L"%s%u",
                           OKVHID_PIPE_PREFIX, ctx->Iface->InterfaceNumber);

    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            OKVHID_PIPE_SDDL, SDDL_REVISION_1, &sd, NULL)) {
        /* Without a descriptor the pipe would inherit the service account's
         * default, which the emulator cannot open. Better to run with no pipe
         * than one nobody can reach - the HID side still works, silently. */
        return 1;
    }

    /* Manual reset, so a completion that lands before the wait is not lost. */
    ioEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (ioEvent == NULL) {
        LocalFree(sd);
        return 1;
    }

    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = sd;
    sa.bInheritHandle = FALSE;

    while (!ctx->PipeStopping) {
        HANDLE pipe = CreateNamedPipeW(
            name,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
                PIPE_REJECT_REMOTE_CLIENTS,
            1,                              /* one emulator per interface */
            /* Room for several frames, so a burst of CTAP continuation
             * packets does not stall the writer on a slow reader. */
            16 * (sizeof(OKVHID_FRAME_HEADER) + OKVHID_MAX_REPORT),
            16 * (sizeof(OKVHID_FRAME_HEADER) + OKVHID_MAX_REPORT),
            0,
            &sa);

        if (pipe == INVALID_HANDLE_VALUE) {
            /* Almost always the previous instance not yet torn down. Wait,
             * but stay interruptible. */
            if (WaitForSingleObject(ctx->StopEvent, 500) == WAIT_OBJECT_0) break;
            continue;
        }

        if (!OkvhidPipeAccept(pipe, ioEvent, ctx->StopEvent)) {
            CloseHandle(pipe);
            if (ctx->PipeStopping) break;
            continue;
        }

        /*
         * Publish the handle and say hello. Both under the lock, so a write
         * from the HID side cannot slip in ahead of the greeting and leave
         * the client parsing a report as its first frame.
         */
        {
            struct { OKVHID_FRAME_HEADER h; OKVHID_HELLO b; } hello;

            hello.h.Magic  = OKVHID_FRAME_MAGIC;
            hello.h.Kind   = OKVHID_FRAME_HELLO;
            hello.h.Length = sizeof(OKVHID_HELLO);

            hello.b.Version          = OKVHID_PROTOCOL_VERSION;
            hello.b.InterfaceNumber  = ctx->Iface->InterfaceNumber;
            hello.b.InputReportSize  = ctx->Iface->InputReportSize;
            hello.b.OutputReportSize = ctx->Iface->OutputReportSize;
            hello.b.Protocol         = ctx->Iface->Protocol;
            hello.b.Subclass         = ctx->Iface->Subclass;
            hello.b.VendorId         = OKVHID_VENDOR_ID;
            hello.b.ProductId        = OKVHID_PRODUCT_ID;

            WdfWaitLockAcquire(ctx->PipeLock, NULL);
            ctx->Pipe = pipe;
            ctx->PipeConnected = TRUE;
            (void)OkvhidPipeWriteLocked(ctx, &hello, sizeof(hello));
            WdfWaitLockRelease(ctx->PipeLock);

            OkvhidTrace(ctx, "accepted; hello sent (in=%u out=%u)",
                        ctx->Iface->InputReportSize,
                        ctx->Iface->OutputReportSize);
        }

        /* Inbound frames until the emulator disconnects. */
        for (;;) {
            OKVHID_FRAME_HEADER h;
            BYTE payload[OKVHID_MAX_REPORT];

            if (ctx->PipeStopping) break;
            if (!OkvhidReadExact(pipe, ioEvent, ctx->StopEvent, &h, sizeof(h))) break;
            if (h.Magic != OKVHID_FRAME_MAGIC) break;   /* desynchronised */
            if (h.Length > OKVHID_MAX_REPORT) break;
            if (h.Length && !OkvhidReadExact(pipe, ioEvent, ctx->StopEvent,
                                             payload, h.Length)) break;

            OkvhidTrace(ctx, "frame kind=%u len=%u", h.Kind, h.Length);

            if (h.Kind == OKVHID_FRAME_INPUT && h.Length) {
                (void)OkvhidDeliverInput(ctx, payload, h.Length);
            }
        }

        /*
         * Unpublish before closing. A writer holds PipeLock for the whole of
         * its write, so taking it here means no write is in flight on this
         * handle by the time it goes away.
         */
        WdfWaitLockAcquire(ctx->PipeLock, NULL);
        ctx->PipeConnected = FALSE;
        ctx->Pipe = NULL;
        WdfWaitLockRelease(ctx->PipeLock);

        CancelIoEx(pipe, NULL);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
    }

    CloseHandle(ioEvent);
    LocalFree(sd);
    return 0;
}

NTSTATUS
OkvhidPipeStart(_In_ PDEVICE_CONTEXT Ctx)
{
    Ctx->PipeStopping = FALSE;

    /* Manual reset: once stopping, every wait must see it, not just the first. */
    Ctx->StopEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (Ctx->StopEvent == NULL) return STATUS_INSUFFICIENT_RESOURCES;

    Ctx->WriteEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (Ctx->WriteEvent == NULL) {
        CloseHandle(Ctx->StopEvent);
        Ctx->StopEvent = NULL;
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    Ctx->PipeThread = CreateThread(NULL, 0, OkvhidPipeThread, Ctx, 0, NULL);
    if (Ctx->PipeThread == NULL) {
        CloseHandle(Ctx->WriteEvent);
        CloseHandle(Ctx->StopEvent);
        Ctx->WriteEvent = NULL;
        Ctx->StopEvent = NULL;
        return STATUS_UNSUCCESSFUL;
    }

    return STATUS_SUCCESS;
}

VOID
OkvhidPipeStop(_In_ PDEVICE_CONTEXT Ctx)
{
    if (Ctx->PipeThread == NULL) return;

    /*
     * Signal, then wait. The flag is what the loop tests between operations
     * and the event is what ends the operation it is currently inside; both
     * are needed, because either alone leaves a window where the thread checks
     * the flag just before blocking on something the event would have ended.
     */
    Ctx->PipeStopping = TRUE;
    SetEvent(Ctx->StopEvent);

    /* Bounded: if the thread is wedged, leaking it is better than hanging
     * device removal, which would wedge PnP for everything. */
    if (WaitForSingleObject(Ctx->PipeThread, 3000) == WAIT_TIMEOUT) {
        /* Leak the thread and its handle rather than free what it still uses. */
        Ctx->PipeThread = NULL;
        return;
    }

    CloseHandle(Ctx->PipeThread);
    Ctx->PipeThread = NULL;

    CloseHandle(Ctx->WriteEvent);
    Ctx->WriteEvent = NULL;
    CloseHandle(Ctx->StopEvent);
    Ctx->StopEvent = NULL;
}
