/*
 * okemu_regs.cpp - backing store for the firmware's register blocks.
 *
 * NO FIXED ADDRESSES. The firmware reaches its hardware through kinetis.h, and
 * every register there is a literal absolute address:
 *
 *     #define FTFL_FSEC  (*(const uint8_t *)0x40020002)
 *     #define SYST_CVR   (*(volatile uint32_t *)0xE000E018)
 *
 * This emulator used to mmap those windows at their real MK20DX256 addresses
 * (0x40000000, 0x42000000, 0xE0000000), which is a bet that nothing else in
 * the process lives there. The bet was lost more than once:
 *
 *   0x42000000  the 32 MB bit-band alias collided with V8's own heap; ASLR
 *               moves the heap each run, so the daemon crash-looped
 *               intermittently until the region was made optional;
 *   0x40000000  ok-rn's copy of this HAL (android/okemu) could not start on a
 *               moto g 5G (2023, Android 14): ART reserves 0x32000000-
 *               0x42000000 in every process before any app code runs, and the
 *               mapping failed with "File exists" (2026-09-26);
 *   0xE0000000  above the 3 GB user/kernel split on 32-bit ARM, so it can
 *               never be mapped there at all.
 *
 * Another runtime, another allocator, another collision - there is no address
 * that is safe in every process. So both blocks are ordinary arrays owned by
 * this module, and scripts/stage.js rewrites every register in the staged
 * sources to index them (rewriteRegisterBlocks(): OKEMU_PBRIDGE(a),
 * OKEMU_SCS(a)). The address arithmetic still resolves at compile time, so the
 * generated code is the same shape it always was - it just points into memory
 * the process owns. ok-rn made the same change first; this is its port.
 *
 * They are STATIC, not mmapped, for two reasons. They exist the moment the
 * module is loaded, before any C++ constructor - T3Mac.cpp reads SIM_UID*
 * from a file-scope initializer during dlopen (ok_hal.cpp seeds them first,
 * from a priority-101 constructor). And a static array cannot fail to map.
 *
 * Page-aligned on purpose: okemu_restart.cpp write-protects the page holding
 * SCB_AIRCR so a store to it faults and can be turned into a restart request,
 * and page protection works on whole pages.
 */
#include <stddef.h>

#ifndef OKEMU_REGS_ALIGN
#define OKEMU_REGS_ALIGN 4096
#endif

#ifdef _MSC_VER
#define OKEMU_ALIGNED(n) __declspec(align(n))
#else
#define OKEMU_ALIGNED(n) __attribute__((aligned(n)))
#endif

extern "C" {
/* 0xE0000000 - 0xE00FFFFF: SCB, NVIC, SysTick, DWT. */
OKEMU_ALIGNED(OKEMU_REGS_ALIGN)
unsigned char okemu_scs_base[0x00100000];

/* 0x40000000 - 0x400FFFFF: FTFL, SIM, PORT, TSI, ADC, GPIO. */
OKEMU_ALIGNED(OKEMU_REGS_ALIGN)
unsigned char okemu_pbridge_base[0x00100000];
}
