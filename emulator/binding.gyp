{
  "includes": ["sources.gypi"],

  # Shared by both targets: the addon needs ok_hal.h, the firmware needs the
  # rest. Staged paths are produced by scripts/stage.js.
  "target_defaults": {
    "include_dirs": [
      # shim first: our Adafruit_NeoPixel.h and rsa.h must shadow the
      # upstream copies further down the path.
      "shim",
      "src",

      # OnlyKey's vendored libraries
      ".stage/libraries/onlykey",
      ".stage/libraries/onlykey/utility",
      ".stage/libraries/Crypto",
      ".stage/libraries/SoftTimer",
      ".stage/libraries/T3Mac",
      ".stage/libraries/base64",
      ".stage/libraries/password",
      ".stage/libraries/sha1",
      ".stage/libraries/sha256",
      ".stage/libraries/totp",
      ".stage/libraries/tweetnacl",
      ".stage/libraries/justhashtweetnacl",
      ".stage/libraries/uECC",
      ".stage/libraries/ykcore",
      ".stage/libraries/yksim",
      ".stage/libraries/randombytes",
      ".stage/libraries/fido2",
      ".stage/libraries/tinycbor",
      ".stage/libraries/mbedtls-2.4.0",
      ".stage/libraries/flashkinetis",

      # the sketch itself
      ".stage/sketch",

      # staged Teensy core (OnlyKey USB stack + our overrides overlaid)
      ".stage/core",

      # stock Arduino libraries the firmware uses. Relative to emulator/, so
      # ../.. is the folder this repo sits in, beside the component checkouts.
      "../../arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/hardware/teensy/avr/libraries/EEPROM",
      "../../arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/hardware/teensy/avr/libraries/Time",
      "../../arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/hardware/teensy/avr/libraries/ADC"
    ],

    # Same board configuration the real firmware is built with - see
    # arduino-1.6.5-r5/preferences.txt (board=teensy31, usb=rawhid,
    # speed=72 MHz, keys=en-us) and hardware/teensy/avr/boards.txt.
    "defines": [
      "__MK20DX256__",
      "TEENSYDUINO=127",
      "USB_RAWHID",
      "F_CPU=72000000",
      "ARDUINO=10605",
      "LAYOUT_US_ENGLISH",

      # The firmware sources carry a handful of host-build adaptations behind
      # #ifdef OK_EMULATOR. The device toolchain never defines it, so the ARM
      # build compiles the #else branch and is unaffected. See README's
      # "Running 32-bit firmware on a 64-bit host".
      "OK_EMULATOR=1"
    ],

    "conditions": [
      # ----------------------------------------------------------------
      # WINDOWS: satisfy Arduino's glibc-only time_t guard.
      #
      # libraries/Time/TimeLib.h:19-22 reads
      #
      #     #if !defined(__time_t_defined)  // avoid conflict with newlib
      #     typedef unsigned long time_t;   //    or other posix libc
      #
      # but __time_t_defined is not a POSIX macro - it is glibc's own
      # internal guard. glibc is the one libc where it happens to work.
      # The UCRT defines time_t (as __int64) and does not define that
      # macro, so the guard fails to fire and the library redefines a
      # type the CRT already owns:
      #
      #     TimeLib.h(21,23): error C2371: 'time_t': redefinition;
      #                                    different basic types
      #
      # Declaring the macro satisfies the guard and leaves the CRT's
      # time_t in place. This is the same one-line fix the Android build
      # settled on - see ok-rn/android/okemu/CMakeLists.txt:99-109 and
      # ok-rn/FINDING-arduino-time-host-hostile.md, which measured the
      # identical failure against bionic.
      #
      # Kept as a define rather than a staged patch because the defect is
      # in a stock Arduino library, not in OnlyKey's sources: nothing we
      # own is edited to work around it.
      # ----------------------------------------------------------------
      ["OS=='win'", {
        "defines": ["__time_t_defined"],

        # --------------------------------------------------------------
        # BUILD WITH CLANG, NOT MSVC.
        #
        # The firmware is written for arm-none-eabi-gcc and says so on
        # every page: __attribute__((always_inline)), __attribute__((pure)),
        # statement expressions, and AVR headers that redefine utoa and the
        # eeprom_* family. MSVC rejects all of it - the first attempt here
        # produced 28x C2059, 21x C4430, 18x C2086 and gave up with C1003.
        #
        # clang-cl speaks both dialects: GCC's language extensions and
        # MSVC's command line and ABI. It ships inside Visual Studio as the
        # "C++ Clang tools for Windows" component, so this adds no
        # toolchain the machine did not already have.
        #
        # The alternative was patching 127 translation units of somebody
        # else's firmware to please one compiler. Changing the compiler is
        # one line and leaves the sources honest.
        # --------------------------------------------------------------
        "msbuild_toolset": "ClangCL",

        "msvs_settings": {
          "VCCLCompilerTool": {
            "AdditionalOptions": [
              # The forced include. gyp's "cflags" below are make/ninja
              # only and are silently dropped by the MSBuild generator, so
              # the prelude has to be named again here or every TU builds
              # without it - see shim/okemu_prelude.h for what it fixes.
              "/FI<(module_root_dir)/shim/okemu_prelude.h",

              # 32-bit firmware on a 64-bit host: it stores pointers in
              # unsigned long and relies on wrapping arithmetic, and the
              # HAL backs registers and flash with mapped memory that
              # strict aliasing would let the compiler reorder. Same two
              # flags the Linux build passes, in clang-cl spelling.
              "/clang:-fno-strict-aliasing",
              "/clang:-fwrapv",

              # okeeprom.c passes `int addr` to the AVR eeprom_*_byte API,
              # whose parameters are typed uint8_t*. That is the AVR
              # convention - the "pointer" is an address-as-integer, and the
              # emulator's own override converts it straight back:
              #
              #     uint8_t eeprom_read_byte(const uint8_t *addr) {
              #       return okemu_eeprom_read((uint32_t)(uintptr_t)addr);
              #
              # so nothing is dereferenced and no address is lost. clang 16
              # promoted -Wint-conversion from a warning to an error by
              # default, which is why this builds elsewhere and not here. /w
              # does not cover it - a default-error is not a warning.
              "/clang:-Wno-int-conversion",

              "/w"
            ]
          }
        }
      }]
    ]
  },

  "targets": [
    {
      # ------------------------------------------------------------------
      # The firmware, built as close to its native configuration as a host
      # compiler allows: gnu++11, the standard it was written against.
      # ------------------------------------------------------------------
      "target_name": "okemu_firmware",
      "type": "static_library",
      "sources": ["<@(okemu_sources)"],

      # make runs from build/, so the forced include needs an absolute path
      "cflags": [
        "-w", "-fpermissive", "-fPIC",
        "-include", "<(module_root_dir)/shim/okemu_prelude.h"
      ],
      "cflags_cc": [
        "-w", "-fpermissive", "-fPIC", "-std=gnu++11", "-fexceptions",
        "-include", "<(module_root_dir)/shim/okemu_prelude.h"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],

      # The firmware is 32-bit code: it stores pointers in unsigned long and
      # relies on wrapping arithmetic. Keep GCC from exploiting the resulting
      # UB, and stop strict aliasing from reordering the register and flash
      # accesses that the HAL backs with mmap'd memory.
      "conditions": [
        ["OS=='linux'", {
          "cflags+": ["-fno-strict-aliasing", "-fwrapv"],
          "cflags_cc+": ["-fno-strict-aliasing", "-fwrapv"]
        }]
      ]
    },
    {
      # ------------------------------------------------------------------
      # The N-API surface. node-addon-api requires C++17, which is why this
      # cannot share a compile line with the firmware above.
      # ------------------------------------------------------------------
      "target_name": "onlykey_emulator",
      "sources": ["src/addon.cpp"],
      "dependencies": ["okemu_firmware"],

      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=gnu++17", "-fexceptions"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],

      # -Bsymbolic: bind the firmware's internal calls to its OWN definitions.
      #
      # The firmware was written for a freestanding target where the only code
      # in the image is its own, so it uses names that collide with libc -
      # okcore.cpp defines `recvmsg`, the OnlyKey message pump. Built as a
      # shared object those symbols are exported with default visibility and
      # their call sites go through the PLT, so the dynamic linker resolves
      # them against the global scope - node and libc - first. glibc exports
      # recvmsg(2), so every `recvmsg(0)` in the firmware was calling the
      # SOCKET syscall instead: it failed silently, and the device accepted HID
      # packets while never once reading them.
      #
      # -Bsymbolic resolves defined symbols within this module and leaves
      # undefined ones (the N-API entry points, libc) alone.
      "ldflags": ["-Wl,-Bsymbolic", "-rdynamic"]
    }
  ]
}
