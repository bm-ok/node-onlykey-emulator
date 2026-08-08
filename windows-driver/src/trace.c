/*
 * trace.c - a log file, because there is nowhere else for this driver to talk.
 *
 * A UMDF driver runs inside WUDFHost as a service account. It has no console,
 * its stdout goes nowhere, and OutputDebugString lands in a session-0 buffer
 * that needs a debugger attached to read. WPP is the supported answer and it
 * needs the WDK's tracing toolchain plus a trace session to decode anything -
 * a lot of machinery to answer "did IOCTL_HID_READ_REPORT ever arrive".
 *
 * So: a plain text file, opened and closed per line - slow, and it does not
 * matter, because this is off unless someone turns it on and when it is on the
 * machine is being debugged rather than measured.
 *
 * It goes in %ProgramData%\okvhid\, not the temp directory. WUDFHost's temp
 * directory is C:\Windows\Temp, which it can certainly write - and which the
 * logged-in user cannot read. A log only an administrator can open is a log
 * you cannot use while debugging as yourself. ProgramData inherits read access
 * for Users, so both halves of this system can see it.
 *
 * Turned on with a DWORD, no reinstall and no reboot:
 *
 *   reg add HKLM\SOFTWARE\okvhid /v Trace /t REG_DWORD /d 1 /f
 *
 * The value is read once per device, when its pipe starts. Toggling it means
 * replugging - windows-driver\hotplug.ps1 -Cycle.
 */

#include "okvhid.h"

#include <stdarg.h>
#include <stdio.h>

/* Enough for a long ceremony, far short of a problem. */
#define OKVHID_TRACE_MAX_BYTES (32 * 1024 * 1024)

static LONG g_TraceEnabled = -1;        /* -1 not yet read, 0 off, 1 on */

/*
 * Read the switch once. Racing threads may both read the registry, which is
 * harmless - they will agree on the answer.
 */
static BOOLEAN
OkvhidTraceEnabled(VOID)
{
    HKEY  key;
    DWORD value = 0;
    DWORD size = sizeof(value);
    DWORD type = 0;
    LONG  cached = g_TraceEnabled;

    if (cached >= 0) return (BOOLEAN)(cached != 0);

    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\okvhid", 0,
                      KEY_QUERY_VALUE, &key) == ERROR_SUCCESS) {
        if (RegQueryValueExW(key, L"Trace", NULL, &type,
                             (LPBYTE)&value, &size) != ERROR_SUCCESS ||
            type != REG_DWORD) {
            value = 0;
        }
        RegCloseKey(key);
    }

    InterlockedExchange(&g_TraceEnabled, value ? 1 : 0);
    return (BOOLEAN)(value != 0);
}

VOID
OkvhidTrace(_In_opt_ PDEVICE_CONTEXT Ctx, _In_ PCSTR Format, ...)
{
    CHAR    line[512];
    CHAR    path[MAX_PATH];
    WCHAR   temp[MAX_PATH];
    HANDLE  file;
    DWORD   written = 0;
    size_t  len = 0;
    va_list args;
    ULONG   iface = 9;
    SYSTEMTIME now;

    if (!OkvhidTraceEnabled()) return;

    if (Ctx != NULL && Ctx->Iface != NULL) iface = Ctx->Iface->InterfaceNumber;

    GetLocalTime(&now);
    (void)StringCchPrintfA(line, ARRAYSIZE(line), "%02u:%02u:%02u.%03u [%u] ",
                           now.wHour, now.wMinute, now.wSecond,
                           now.wMilliseconds, iface);
    (void)StringCchLengthA(line, ARRAYSIZE(line), &len);

    va_start(args, Format);
    (void)StringCchVPrintfA(line + len, ARRAYSIZE(line) - len, Format, args);
    va_end(args);

    (void)StringCchCatA(line, ARRAYSIZE(line), "\r\n");
    (void)StringCchLengthA(line, ARRAYSIZE(line), &len);

    if (GetEnvironmentVariableW(L"ProgramData", temp, ARRAYSIZE(temp)) == 0) {
        (void)StringCchCopyW(temp, ARRAYSIZE(temp), L"C:\\ProgramData");
    }

    (void)StringCchPrintfA(path, ARRAYSIZE(path), "%ls\\okvhid", temp);
    (void)CreateDirectoryA(path, NULL);     /* fine if it is already there */
    (void)StringCchCatA(path, ARRAYSIZE(path), "\\okvhid.log");

    /*
     * FILE_APPEND_DATA without FILE_WRITE_DATA is what makes concurrent
     * appends from four interfaces atomic per write - the file system does
     * the seek-to-end under its own lock, so lines interleave but never tear.
     */
    file = CreateFileA(path, FILE_APPEND_DATA | FILE_READ_ATTRIBUTES,
                       FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                       OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return;

    /*
     * Stop at a cap rather than rotating. The emulator's debug console alone
     * writes about 100 KB a second through this, so an overnight run with the
     * switch left on would fill the system drive - and a driver that can do
     * that is worse than one with no logging at all. Stopping keeps the
     * beginning, which is where the interesting part of a trace is; delete the
     * file to start a fresh one.
     */
    {
        LARGE_INTEGER size;
        if (GetFileSizeEx(file, &size) && size.QuadPart > OKVHID_TRACE_MAX_BYTES) {
            CloseHandle(file);
            return;
        }
    }

    (void)WriteFile(file, line, (DWORD)len, &written, NULL);
    CloseHandle(file);
}
