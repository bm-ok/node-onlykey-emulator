/*
 * driver.c - entry point, device creation, and interface selection.
 *
 * One driver binary backs all four OnlyKey HID interfaces. Which one a given
 * device node is comes from its hardware ID, set by the INF:
 *
 *     root\okvhid_fido  ->  g_OkInterfaces[] row tagged L"fido"
 *
 * Doing it this way rather than four drivers means the descriptors, the
 * report plumbing and the bridge protocol exist once.
 */

#include "okvhid.h"

static NTSTATUS OkvhidSelectInterface(_In_ WDFDEVICE Device,
                                      _Outptr_ const OKVHID_INTERFACE **Iface);
static NTSTATUS OkvhidCreateQueues(_In_ WDFDEVICE Device,
                                   _In_ PDEVICE_CONTEXT Ctx);

NTSTATUS
DriverEntry(_In_ PDRIVER_OBJECT DriverObject, _In_ PUNICODE_STRING RegistryPath)
{
    WDF_DRIVER_CONFIG     config;
    WDF_OBJECT_ATTRIBUTES attributes;

    WDF_OBJECT_ATTRIBUTES_INIT(&attributes);
    attributes.EvtCleanupCallback = OkvhidEvtDriverContextCleanup;

    WDF_DRIVER_CONFIG_INIT(&config, OkvhidEvtDeviceAdd);

    return WdfDriverCreate(DriverObject, RegistryPath, &attributes, &config,
                           WDF_NO_HANDLE);
}

VOID
OkvhidEvtDriverContextCleanup(_In_ WDFOBJECT DriverObject)
{
    UNREFERENCED_PARAMETER(DriverObject);
}

/*
 * Anyone may open the interface; there is nothing to authorise here. The
 * point of the callback is not the policy, it is existing at all - see the
 * comment in OkvhidEvtDeviceAdd.
 */
VOID
OkvhidEvtDeviceFileCreate(_In_ WDFDEVICE Device, _In_ WDFREQUEST Request,
                          _In_ WDFFILEOBJECT FileObject)
{
    UNREFERENCED_PARAMETER(Device);
    UNREFERENCED_PARAMETER(FileObject);

    WdfRequestComplete(Request, STATUS_SUCCESS);
}

NTSTATUS
OkvhidEvtDeviceAdd(_In_ WDFDRIVER Driver, _Inout_ PWDFDEVICE_INIT DeviceInit)
{
    NTSTATUS                status;
    WDFDEVICE               device;
    PDEVICE_CONTEXT         ctx;
    WDF_OBJECT_ATTRIBUTES   attributes;
    WDF_IO_QUEUE_CONFIG     queueConfig;
    WDF_FILEOBJECT_CONFIG   fileConfig;
    const OKVHID_INTERFACE *iface;

    UNREFERENCED_PARAMETER(Driver);

    /*
     * A HID minidriver sits under the HID class driver, which is what talks
     * to hidclass.sys/hidparse.sys on our behalf. Without this the stack
     * builds but nothing ever asks us for a report descriptor.
     */
    WdfFdoInitSetFilter(DeviceInit);

    /*
     * Handle IRP_MJ_CREATE ourselves.
     *
     * WdfFdoInitSetFilter above makes this a filter, and a filter forwards
     * create requests down the stack instead of completing them. That is
     * right for the HID path - HIDCLASS sits above us - but it also means the
     * bridge cannot open GUID_DEVINTERFACE_OKVHID: the create is passed to
     * the root-enumerated PDO underneath, which does not implement it, and
     * CreateFile fails with ERROR_INVALID_FUNCTION. The interface enumerates
     * perfectly and simply cannot be opened, which points at the caller
     * rather than at the driver.
     *
     * Registering a file-object config stops the forwarding and lets us
     * complete the create locally. AutoForwardCleanupClose is turned off to
     * match: having completed the create here, forwarding the matching
     * cleanup and close would send them somewhere that never saw the open.
     */
    WDF_FILEOBJECT_CONFIG_INIT(&fileConfig,
                               OkvhidEvtDeviceFileCreate,
                               WDF_NO_EVENT_CALLBACK,   /* close   */
                               WDF_NO_EVENT_CALLBACK);  /* cleanup */
    fileConfig.AutoForwardCleanupClose = WdfFalse;

    WdfDeviceInitSetFileObjectConfig(DeviceInit, &fileConfig,
                                     WDF_NO_OBJECT_ATTRIBUTES);

    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, DEVICE_CONTEXT);
    /* Stops the pipe thread before the context it points at is freed. */
    attributes.EvtCleanupCallback = OkvhidEvtDeviceCleanup;

    status = WdfDeviceCreate(&DeviceInit, &attributes, &device);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    ctx = DeviceGetContext(device);
    RtlZeroMemory(ctx, sizeof(*ctx));

    status = OkvhidSelectInterface(device, &iface);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    ctx->Iface = iface;

    status = WdfSpinLockCreate(WDF_NO_OBJECT_ATTRIBUTES, &ctx->Lock);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    /* A wait lock, not a spin lock: writes to the pipe block, which a spin
     * lock forbids. */
    status = WdfWaitLockCreate(WDF_NO_OBJECT_ATTRIBUTES, &ctx->PipeLock);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    /*
     * Default queue: everything arrives here. HID IOCTLs come down from the
     * class driver, bridge IOCTLs up from the user-mode service. Parallel
     * because a parked read must not block a bridge push behind it.
     */
    WDF_IO_QUEUE_CONFIG_INIT_DEFAULT_QUEUE(&queueConfig,
                                           WdfIoQueueDispatchParallel);
    queueConfig.EvtIoDeviceControl = OkvhidEvtIoDeviceControl;

    status = WdfIoQueueCreate(device, &queueConfig, WDF_NO_OBJECT_ATTRIBUTES,
                              WDF_NO_HANDLE);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    status = OkvhidCreateQueues(device, ctx);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    /*
     * The pipe is what the emulator connects to. It is started here rather
     * than lazily, so a device that is present is a device that is reachable
     * - "plugged in" and "connectable" mean the same thing, which is what
     * makes removing the device a faithful unplug.
     */
    status = OkvhidPipeStart(ctx);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    return STATUS_SUCCESS;
}

/*
 * Tear the pipe down when the device goes away. This is the unplug path: the
 * thread exits, the pipe closes, and the emulator sees a clean disconnect
 * rather than a hang.
 */
VOID
OkvhidEvtDeviceCleanup(_In_ WDFOBJECT Device)
{
    PDEVICE_CONTEXT ctx = DeviceGetContext((WDFDEVICE)Device);
    if (ctx != NULL) {
        OkvhidPipeStop(ctx);
    }
}

/*
 * One manual queue, for the reads that must wait: IOCTL_HID_READ_REPORT sits
 * here until the token has something to say. Manual dispatch is what lets it
 * wait indefinitely - an idle OnlyKey is idle for minutes at a time, and a
 * timed-out read would present as a device fault.
 */
static NTSTATUS
OkvhidCreateQueues(_In_ WDFDEVICE Device, _In_ PDEVICE_CONTEXT Ctx)
{
    WDF_IO_QUEUE_CONFIG cfg;

    WDF_IO_QUEUE_CONFIG_INIT(&cfg, WdfIoQueueDispatchManual);
    return WdfIoQueueCreate(Device, &cfg, WDF_NO_OBJECT_ATTRIBUTES,
                            &Ctx->ReadReportQueue);
}

/*
 * Match the tail of the hardware ID against g_OkInterfaces[].Tag.
 *
 * The ID is "root\okvhid_fido" (or "OKVHID\fido" if you enumerate it some
 * other way), so a suffix match on "_fido"/"\fido" is both sufficient and
 * robust to the prefix changing. An unrecognised ID is a hard failure rather
 * than a default-to-keyboard, because silently enumerating the wrong
 * descriptor produces a device that looks fine and behaves wrongly.
 */
static NTSTATUS
OkvhidSelectInterface(_In_ WDFDEVICE Device,
                      _Outptr_ const OKVHID_INTERFACE **Iface)
{
    NTSTATUS       status;
    WDFMEMORY      memory;
    PCWSTR         hwid;
    size_t         bytes = 0;
    size_t         chars;
    size_t         i;
    size_t         tagLen;
    size_t         hwLen;

    *Iface = NULL;

    status = WdfDeviceAllocAndQueryProperty(Device, DevicePropertyHardwareID,
                                            NonPagedPoolNx,
                                            WDF_NO_OBJECT_ATTRIBUTES, &memory);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    hwid = (PCWSTR)WdfMemoryGetBuffer(memory, &bytes);
    if (hwid == NULL || bytes < sizeof(WCHAR)) {
        WdfObjectDelete(memory);
        return STATUS_INVALID_DEVICE_STATE;
    }

    /* DevicePropertyHardwareID is a REG_MULTI_SZ; the first string is the
     * most specific one, which is the one the INF matched. */
    chars = bytes / sizeof(WCHAR);
    for (hwLen = 0; hwLen < chars && hwid[hwLen] != L'\0'; hwLen++) {
        /* count */
    }

    for (i = 0; i < OKVHID_INTERFACE_COUNT; i++) {
        const OKVHID_INTERFACE *cand = &g_OkInterfaces[i];

        for (tagLen = 0; cand->Tag[tagLen] != L'\0'; tagLen++) {
            /* count */
        }
        if (hwLen < tagLen + 1) {
            continue;
        }

        if (_wcsnicmp(hwid + (hwLen - tagLen), cand->Tag, tagLen) == 0) {
            WCHAR sep = hwid[hwLen - tagLen - 1];
            if (sep == L'_' || sep == L'\\') {
                *Iface = cand;
                break;
            }
        }
    }

    WdfObjectDelete(memory);

    return (*Iface != NULL) ? STATUS_SUCCESS : STATUS_DEVICE_CONFIGURATION_ERROR;
}
