/*
 * hid.c - the HID minidriver surface.
 *
 * Everything the HID class driver asks of us arrives here. The interesting
 * ones are GET_REPORT_DESCRIPTOR, which is where the authentic OnlyKey bytes
 * go out, and READ_REPORT, which is the device -> host path and therefore the
 * one that has to be able to wait forever.
 *
 * On HID_XFER_PACKET
 * ------------------
 * There isn't one. Under KMDF a report IOCTL carries a HID_XFER_PACKET, which
 * holds a POINTER to the report; under UMDF, mshidumdf.sys has already
 * resolved it and the request's buffer holds the report bytes themselves,
 * flat. Treating that buffer as a packet compiles cleanly, passes its own
 * length check on anything 16 bytes or larger, and then dereferences report
 * data as a pointer. See the note above OkvhidGetString for what that looks
 * like from the outside.
 */

#include "okvhid.h"

/*
 * bcdHID 0x0111 (1.11). The real OnlyKey reports the same, and hidparse does
 * not care, but a mismatch shows up in a USB trace comparison and there is no
 * reason to introduce a difference.
 */
#define OKVHID_BCD_HID 0x0111

static NTSTATUS OkvhidHandleHidIoctl(_In_ WDFDEVICE Device,
                                     _In_ WDFREQUEST Request,
                                     _In_ size_t OutputBufferLength,
                                     _In_ size_t InputBufferLength,
                                     _In_ ULONG IoControlCode,
                                     _Out_ BOOLEAN *Handled);
static NTSTATUS OkvhidGetDeviceDescriptor(_In_ PDEVICE_CONTEXT Ctx,
                                          _In_ WDFREQUEST Request);
static NTSTATUS OkvhidGetReportDescriptor(_In_ PDEVICE_CONTEXT Ctx,
                                          _In_ WDFREQUEST Request);
static NTSTATUS OkvhidGetDeviceAttributes(_In_ WDFREQUEST Request);
static NTSTATUS OkvhidReadReport(_In_ PDEVICE_CONTEXT Ctx,
                                 _In_ WDFREQUEST Request);
static NTSTATUS OkvhidWriteReport(_In_ PDEVICE_CONTEXT Ctx,
                                  _In_ WDFREQUEST Request, _In_ ULONG Kind);
static NTSTATUS OkvhidGetFeature(_In_ PDEVICE_CONTEXT Ctx,
                                 _In_ WDFREQUEST Request);
static NTSTATUS OkvhidGetString(_In_ PDEVICE_CONTEXT Ctx,
                                _In_ WDFREQUEST Request);

/*
 * Single entry point for the default queue. HID IOCTLs are tried first, then
 * the bridge's; anything neither claims is failed rather than forwarded,
 * since this device has nothing below it.
 */
VOID
OkvhidEvtIoDeviceControl(_In_ WDFQUEUE Queue, _In_ WDFREQUEST Request,
                         _In_ size_t OutputBufferLength,
                         _In_ size_t InputBufferLength,
                         _In_ ULONG IoControlCode)
{
    WDFDEVICE device = WdfIoQueueGetDevice(Queue);
    BOOLEAN   handled = FALSE;
    NTSTATUS  status;

    /*
     * HID IOCTLs only. There is no longer a private ioctl surface: the
     * emulator reaches this driver over a named pipe instead, because with
     * HIDCLASS on the stack a create on our own device interface never gets
     * past it. See public.h.
     */
    status = OkvhidHandleHidIoctl(device, Request, OutputBufferLength,
                                  InputBufferLength, IoControlCode, &handled);
    if (!handled) {
        status = STATUS_NOT_SUPPORTED;
    }
    /*
     * STATUS_PENDING means the handler parked the request on a manual queue
     * and owns it now. Completing it here would be a double completion.
     */
    if (status != STATUS_PENDING) {
        WdfRequestComplete(Request, status);
    }
}

static NTSTATUS
OkvhidHandleHidIoctl(_In_ WDFDEVICE Device, _In_ WDFREQUEST Request,
                     _In_ size_t OutputBufferLength,
                     _In_ size_t InputBufferLength, _In_ ULONG IoControlCode,
                     _Out_ BOOLEAN *Handled)
{
    PDEVICE_CONTEXT ctx = DeviceGetContext(Device);

    UNREFERENCED_PARAMETER(OutputBufferLength);
    UNREFERENCED_PARAMETER(InputBufferLength);

    OkvhidTrace(ctx, "ioctl 0x%08X in=%Iu out=%Iu", IoControlCode,
                InputBufferLength, OutputBufferLength);

    *Handled = TRUE;

    switch (IoControlCode) {

    case IOCTL_HID_GET_DEVICE_DESCRIPTOR:
        return OkvhidGetDeviceDescriptor(ctx, Request);

    case IOCTL_HID_GET_REPORT_DESCRIPTOR:
        return OkvhidGetReportDescriptor(ctx, Request);

    case IOCTL_HID_GET_DEVICE_ATTRIBUTES:
        return OkvhidGetDeviceAttributes(Request);

    case IOCTL_HID_READ_REPORT:
        return OkvhidReadReport(ctx, Request);

    case IOCTL_HID_WRITE_REPORT:
    case IOCTL_HID_SET_OUTPUT_REPORT:
        return OkvhidWriteReport(ctx, Request, OKVHID_FRAME_OUTPUT);

    /*
     * The keyboard interface's 8-byte Feature report is not decoration.
     * OnlyKey's usb_dev.c uses SET_REPORT on it as a side channel, filling
     * setBuffer[] which process_setreport() consumes - it is how the OnlyKey
     * app sends configuration. Dropping these would make the app unable to
     * send those packets at all.
     */
    case IOCTL_HID_SET_FEATURE:
        return OkvhidWriteReport(ctx, Request, OKVHID_FRAME_FEATURE);

    case IOCTL_HID_GET_FEATURE:
    case IOCTL_HID_GET_INPUT_REPORT:
        return OkvhidGetFeature(ctx, Request);

    case IOCTL_HID_GET_STRING:
        return OkvhidGetString(ctx, Request);

    /*
     * Idle/wake and boot-protocol switching. A software device is never
     * suspended and the keyboard descriptor is already report-protocol, so
     * succeeding is both honest and what the class driver wants to hear.
     */
    case IOCTL_HID_SEND_IDLE_NOTIFICATION_REQUEST:
    case IOCTL_HID_ACTIVATE_DEVICE:
    case IOCTL_HID_DEACTIVATE_DEVICE:
        return STATUS_SUCCESS;

    default:
        *Handled = FALSE;
        return STATUS_NOT_SUPPORTED;
    }
}

static NTSTATUS
OkvhidGetDeviceDescriptor(_In_ PDEVICE_CONTEXT Ctx, _In_ WDFREQUEST Request)
{
    NTSTATUS       status;
    WDFMEMORY      memory;
    HID_DESCRIPTOR desc;

    status = WdfRequestRetrieveOutputMemory(Request, &memory);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    RtlZeroMemory(&desc, sizeof(desc));
    desc.bLength         = sizeof(HID_DESCRIPTOR);
    desc.bDescriptorType = HID_HID_DESCRIPTOR_TYPE;
    desc.bcdHID          = OKVHID_BCD_HID;
    desc.bCountry        = 0;
    desc.bNumDescriptors = 1;
    desc.DescriptorList[0].bReportType = HID_REPORT_DESCRIPTOR_TYPE;
    desc.DescriptorList[0].wReportLength = Ctx->Iface->ReportDescriptorSize;

    status = WdfMemoryCopyFromBuffer(memory, 0, &desc, sizeof(desc));
    if (!NT_SUCCESS(status)) {
        return status;
    }

    WdfRequestSetInformation(Request, sizeof(desc));
    return STATUS_SUCCESS;
}

/*
 * The authentic bytes go out here. They are whatever descriptors.h holds,
 * which is whatever the emulator's hid-descriptors.js holds, which is what
 * was captured from a physical OnlyKey. Nothing is synthesised.
 */
static NTSTATUS
OkvhidGetReportDescriptor(_In_ PDEVICE_CONTEXT Ctx, _In_ WDFREQUEST Request)
{
    NTSTATUS  status;
    WDFMEMORY memory;
    size_t    available = 0;

    status = WdfRequestRetrieveOutputMemory(Request, &memory);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    (VOID)WdfMemoryGetBuffer(memory, &available);
    if (available < Ctx->Iface->ReportDescriptorSize) {
        return STATUS_BUFFER_TOO_SMALL;
    }

    status = WdfMemoryCopyFromBuffer(memory, 0,
                                     (PVOID)Ctx->Iface->ReportDescriptor,
                                     Ctx->Iface->ReportDescriptorSize);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    WdfRequestSetInformation(Request, Ctx->Iface->ReportDescriptorSize);
    return STATUS_SUCCESS;
}

/*
 * 1D50:60FC. This is what hidapi reports as vendorId/productId, and it is
 * half of what real OnlyKey software matches on - the other half being the
 * string descriptors, which OkvhidGetString supplies.
 */
static NTSTATUS
OkvhidGetDeviceAttributes(_In_ WDFREQUEST Request)
{
    NTSTATUS               status;
    PHID_DEVICE_ATTRIBUTES attrs = NULL;

    status = WdfRequestRetrieveOutputBuffer(Request, sizeof(*attrs),
                                            (PVOID *)&attrs, NULL);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    RtlZeroMemory(attrs, sizeof(*attrs));
    attrs->Size        = sizeof(HID_DEVICE_ATTRIBUTES);
    attrs->VendorID    = OKVHID_VENDOR_ID;
    attrs->ProductID   = OKVHID_PRODUCT_ID;
    attrs->VersionNumber = OKVHID_VERSION;

    WdfRequestSetInformation(Request, sizeof(*attrs));
    return STATUS_SUCCESS;
}

/*
 * device -> host.
 *
 * If the bridge has already pushed something, complete immediately. Otherwise
 * park the request on the manual queue and return STATUS_PENDING - the caller
 * must not complete it. An OnlyKey sitting idle between button presses leaves
 * a read outstanding for minutes at a time, which is why the queue is manual
 * and carries no timeout.
 */
static NTSTATUS
OkvhidReadReport(_In_ PDEVICE_CONTEXT Ctx, _In_ WDFREQUEST Request)
{
    NTSTATUS     status;
    OKVHID_ENTRY entry;
    PVOID        buffer = NULL;
    size_t       length = 0;

    if (OkvhidTryPopInput(Ctx, &entry)) {
        status = WdfRequestRetrieveOutputBuffer(Request, entry.Length,
                                                &buffer, &length);
        if (!NT_SUCCESS(status)) {
            OkvhidTrace(Ctx, "readreport: RetrieveOutputBuffer 0x%08X", status);
            return status;
        }
        if (length < entry.Length) {
            OkvhidTrace(Ctx, "readreport: buffer %Iu < report %u",
                        length, entry.Length);
            return STATUS_BUFFER_TOO_SMALL;
        }

        RtlCopyMemory(buffer, entry.Data, entry.Length);
        WdfRequestSetInformation(Request, entry.Length);
        OkvhidTrace(Ctx, "readreport: completed %u from ring", entry.Length);
        return STATUS_SUCCESS;
    }

    status = WdfRequestForwardToIoQueue(Request, Ctx->ReadReportQueue);
    if (!NT_SUCCESS(status)) {
        OkvhidTrace(Ctx, "readreport: ForwardToIoQueue 0x%08X", status);
        return status;
    }
    OkvhidTrace(Ctx, "readreport: parked");

    /* Closes the race against a push that landed while we were parking. */
    OkvhidDrainInput(Ctx);

    return STATUS_PENDING;
}

/*
 * host -> device. Both output and feature reports land here; Kind is what
 * tells the bridge which of the guest's channels to write it to.
 */
static NTSTATUS
OkvhidWriteReport(_In_ PDEVICE_CONTEXT Ctx, _In_ WDFREQUEST Request,
                  _In_ ULONG Kind)
{
    NTSTATUS status;
    PVOID    report = NULL;
    size_t   available = 0;
    ULONG    length;

    status = WdfRequestRetrieveInputBuffer(Request, 1, &report, &available);
    if (!NT_SUCCESS(status)) {
        OkvhidTrace(Ctx, "write: RetrieveInputBuffer 0x%08X", status);
        return status;
    }
    if (available == 0) {
        return STATUS_INVALID_PARAMETER;
    }

    length = (ULONG)available;
    if (length > OKVHID_MAX_REPORT) {
        length = OKVHID_MAX_REPORT;
    }

    /* Keep the last feature value so a GET_FEATURE reads back what was set,
     * which is what the real interface does. */
    if (Kind == OKVHID_FRAME_FEATURE) {
        WdfSpinLockAcquire(Ctx->Lock);
        RtlCopyMemory(Ctx->FeatureCache, report, length);
        Ctx->FeatureCacheLength = (USHORT)length;
        WdfSpinLockRelease(Ctx->Lock);
    }

    OkvhidTrace(Ctx, "write: kind=%u len=%u", Kind, length);

    status = OkvhidDeliverOutput(Ctx, Kind, report, length);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    WdfRequestSetInformation(Request, available);
    return STATUS_SUCCESS;
}

static NTSTATUS
OkvhidGetFeature(_In_ PDEVICE_CONTEXT Ctx, _In_ WDFREQUEST Request)
{
    NTSTATUS status;
    PVOID    report = NULL;
    size_t   available = 0;
    ULONG    length;

    status = WdfRequestRetrieveOutputBuffer(Request, 1, &report, &available);
    if (!NT_SUCCESS(status)) {
        OkvhidTrace(Ctx, "getfeature: RetrieveOutputBuffer 0x%08X", status);
        return status;
    }

    WdfSpinLockAcquire(Ctx->Lock);
    length = Ctx->FeatureCacheLength;
    if (length > available) {
        length = (ULONG)available;
    }
    if (length > 0) {
        RtlCopyMemory(report, Ctx->FeatureCache, length);
    }
    /* Never written yet: report zeros rather than uninitialised stack. */
    if (length < available) {
        RtlZeroMemory((PUCHAR)report + length, available - length);
    }
    WdfSpinLockRelease(Ctx->Lock);

    WdfRequestSetInformation(Request, available);
    return STATUS_SUCCESS;
}

/*
 * CRYPTOTRUST / ONLYKEY / 1000000000.
 *
 * These are load-bearing, not cosmetic. onlykey-testing/lib/hid.js and
 * python-onlykey both identify the device as
 *
 *     d.manufacturer === 'CRYPTOTRUST' && d.product === 'ONLYKEY'
 *
 * and a device that omits them enumerates perfectly and is then invisible to
 * every real client. This is the same reason the emulator moved off UHID.
 */
static NTSTATUS
OkvhidGetString(_In_ PDEVICE_CONTEXT Ctx, _In_ WDFREQUEST Request)
{
    NTSTATUS status;
    PCWSTR   value;
    size_t   bytes;
    PVOID    buffer = NULL;
    size_t   length = 0;
    PULONG   idIn = NULL;
    ULONG    id;

    UNREFERENCED_PARAMETER(Ctx);

    /*
     * The string index arrives as a 4-byte input buffer, not in
     * Type3InputBuffer. That field is the KMDF spelling; under UMDF the
     * METHOD_NEITHER parameters have already been marshalled into ordinary
     * buffers - which is what UmdfMethodNeitherAction=Copy in the INF asks
     * for - and Type3InputBuffer holds nothing usable.
     *
     * Low word is the string index, high word a language ID, which is
     * ignored: the real device only publishes 0x409.
     */
    status = WdfRequestRetrieveInputBuffer(Request, sizeof(ULONG),
                                           (PVOID *)&idIn, &length);
    if (!NT_SUCCESS(status) || length < sizeof(ULONG)) {
        OkvhidTrace(Ctx, "getstring: no id (0x%08X, %Iu bytes)", status, length);
        return NT_SUCCESS(status) ? STATUS_BUFFER_TOO_SMALL : status;
    }
    id = *idIn;

    switch (id & 0x0000FFFF) {
    case HID_STRING_ID_IMANUFACTURER: value = OKVHID_MANUFACTURER; break;
    case HID_STRING_ID_IPRODUCT:      value = OKVHID_PRODUCT;      break;
    case HID_STRING_ID_ISERIALNUMBER: value = OKVHID_SERIAL;       break;
    default:                          return STATUS_INVALID_PARAMETER;
    }

    bytes = (wcslen(value) + 1) * sizeof(WCHAR);

    status = WdfRequestRetrieveOutputBuffer(Request, bytes, &buffer, &length);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    if (length < bytes) {
        return STATUS_BUFFER_TOO_SMALL;
    }

    RtlCopyMemory(buffer, value, bytes);
    WdfRequestSetInformation(Request, bytes);
    return STATUS_SUCCESS;
}

/*
 * There is no HID_XFER_PACKET here, and assuming there was cost a crash.
 *
 * Under KMDF a report IOCTL carries a HID_XFER_PACKET - a length, a report ID
 * and a POINTER to the data - in Parameters.Others.Arg1. Under UMDF it does
 * not carry one at all. mshidumdf.sys has already resolved the packet and
 * hands the framework the report bytes themselves, so the input buffer of an
 * IOCTL_HID_WRITE_REPORT is the report, flat, and nothing else.
 *
 * Reading it as a HID_XFER_PACKET compiles, and on a 64-byte CTAP-HID packet
 * it succeeds: 64 is comfortably larger than sizeof(HID_XFER_PACKET), so the
 * length check passes and bytes 0-7 of the CTAP frame get dereferenced as
 * reportBuffer. WUDFHost dies, PnP restarts the device, Windows says "reinsert
 * your security key", and it happens again on the retry. The keyboard hid it:
 * its LED report is one byte, which fails the length check and returns an
 * error instead of faulting.
 *
 * The trace is what named it - in=1 on the keyboard and in=64 on FIDO are
 * report sizes, not structure sizes.
 */
