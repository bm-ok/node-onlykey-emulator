/*
 * okemu_flash.cpp - host implementation of the flashkinetis API.
 *
 * The upstream flashkinetis.cpp issues FTFL command sequences and spins on
 * FTFL_FSTAT waiting for the flash controller to retire them; with no
 * controller behind the register those loops never complete. We provide the
 * same entry points against the file-backed flash array the HAL mapped at the
 * real MK20DX256 addresses, so the firmware's own `*(unsigned int *)adr` reads
 * observe our writes exactly as they would on hardware.
 *
 * Upstream's flashkinetis.cpp is simply not compiled; the source is untouched.
 *
 * NOR semantics are preserved because the firmware depends on them: erase sets
 * a sector to 0xFF, and programming can only clear bits, never set them. A
 * word that has already been programmed cannot be rewritten to a different
 * value without an erase first - that is what flashCheckSectorErased() and the
 * firmware's "first empty sector" scan rely on.
 */
#include <stdint.h>
#include <string.h>

#include "flashkinetis.h"
#include "ok_hal.h"

namespace {

/*
 * Both of these are relative to OKEMU_FLASH_BASE, which is not always zero.
 *
 * They used to read `a < OKEMU_FLASH_SIZE` and `FLASH_SECTOR_SIZE`, which is
 * the same thing only while the flash array is mapped at address 0 - true on
 * Linux and nowhere else. Where the base moves (Windows, where the bottom
 * 64 KB of the address space cannot be mapped at all), every address the
 * firmware handed in fell outside the window, in_flash() said no, and
 * flashEraseSector() and flashProgramWord() returned their failure code
 * without writing anything.
 *
 * Nothing announced that. The firmware's own callers ignore the return, so a
 * device would boot, take a PIN, report it committed, and come back from the
 * next reboot with no PIN set and an empty flash.bin - because not one byte
 * had ever been written. The write path was rejecting every address it was
 * given while the read path worked perfectly.
 *
 * With OKEMU_FLASH_BASE == 0 these are exactly the old expressions, so the
 * Linux build is unchanged.
 */
inline uintptr_t flash_begin() { return (uintptr_t)OKEMU_FLASH_BASE; }
inline uintptr_t flash_end()   { return flash_begin() + (uintptr_t)OKEMU_FLASH_SIZE; }

/* The MK20DX256's first sector holds the reset vectors and flash config
 * field; the library refuses to touch it unless explicitly overridden. */
inline uintptr_t first_sector_end() { return flash_begin() + FLASH_SECTOR_SIZE; }

inline bool in_flash(uintptr_t a) {
  return a >= flash_begin() && a < flash_end();
}

volatile uint8_t *ftfl_fsec() { return (volatile uint8_t *)0x40020002UL; }  /* kinetis.h:2350 */

}  // namespace

/*
 * Returns 0 when every word in the sector containing `address` reads as
 * erased, non-zero otherwise - matching the upstream return convention.
 */
int flashCheckSectorErased(unsigned long *address) {
  uintptr_t a = (uintptr_t)address & ~(uintptr_t)(FLASH_SECTOR_SIZE - 1);
  if (!in_flash(a)) return 1;
  const uint8_t *p = (const uint8_t *)a;
  for (size_t i = 0; i < FLASH_SECTOR_SIZE; i++)
    if (p[i] != 0xFF) return 1;
  return 0;
}

int flashEraseSector(unsigned long *address, bool allowFirstSector) {
  uintptr_t a = (uintptr_t)address & ~(uintptr_t)(FLASH_SECTOR_SIZE - 1);
  if (!in_flash(a)) return 1;
  if (a < first_sector_end() && !allowFirstSector) return 1;
  memset((void *)a, 0xFF, FLASH_SECTOR_SIZE);
  return 0;
}

int flashProgramWord(unsigned long *address, unsigned long *data,
                     bool allowFirstSector, bool overrideSafetyForConfig) {
  uintptr_t a = (uintptr_t)address;
  if (!in_flash(a) || (a & 3u)) return 1;
  if (a < first_sector_end() && !allowFirstSector && !overrideSafetyForConfig)
    return 1;

  volatile uint32_t *dst = (volatile uint32_t *)a;
  const uint32_t want = *(const uint32_t *)data;
  const uint32_t cur  = *dst;

  /* Programming may only clear bits. If the target still holds bits the new
   * value needs set, the word must be erased first - report the failure the
   * same way the hardware would rather than silently writing. */
  if ((cur & want) != want) return 1;

  *dst = want;
  return 0;
}

void flashSetFlexRAM(void) {
  /* FlexRAM is already "configured": the EEPROM override backs it directly. */
}

unsigned long flashFirstEmptySector(void) {
  for (uintptr_t a = first_sector_end(); a < flash_end();
       a += FLASH_SECTOR_SIZE) {
    if (flashCheckSectorErased((unsigned long *)a) == 0) return (unsigned long)a;
  }
  return 0;
}

/*
 * On hardware this burns the FSEC byte in the flash config field, which the
 * firmware then reads back to decide whether it has already been provisioned.
 * We just latch the value into the mapped register.
 */
int flashSecurityLockBits(uint8_t newValueForFSEC) {
  *ftfl_fsec() = newValueForFSEC;
  return 0;
}

void flashEraseAll() {
  okemu_factory_reset();
}
