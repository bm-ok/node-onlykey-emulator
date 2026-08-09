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

      # stock Arduino libraries the firmware uses
      "../onlykey/arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/hardware/teensy/avr/libraries/EEPROM",
      "../onlykey/arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/hardware/teensy/avr/libraries/Time",
      "../onlykey/arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/hardware/teensy/avr/libraries/ADC"
    ],

    "conditions": [
      # ----------------------------------------------------------------
      # Windows: the Arduino Time directory cannot be on the include path.
      #
      # It contains Time.h, and Windows filesystems are case-insensitive, so
      # the MSVC STL's <ctime> doing `#include <time.h>` finds Arduino's
      # header instead of the CRT's. Every translation unit that reaches
      # <chrono>, <thread> or <mutex> then fails inside <ctime> with a page of
      # "no member named 'clock_t' in the global namespace" - which points
      # nowhere near the cause. Include order cannot fix it: -I directories
      # beat the system ones for angled includes.
      #
      # Time.h is a single line forwarding to TimeLib.h, and every firmware
      # reference to it is quoted, so stage.js stages TimeLib.h on its own
      # into .stage/wincompat and patches those four includes to point at it
      # directly. Time.cpp and DateStrings.cpp compile from the Arduino tree
      # and resolve "Time.h" against their own directory, so they still work.
      # ----------------------------------------------------------------
      ["OS=='win'", {
        "include_dirs!": [
          "../onlykey/arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/hardware/teensy/avr/libraries/Time"
        ],
        "include_dirs": [".stage/wincompat"]
      }]
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
        }],

        # ------------------------------------------------------------------
        # Windows.
        #
        # None of the cflags above apply here: gyp only emits cflags/cflags_cc
        # for the make and ninja generators, so on the msvs generator every
        # one of them - including the forced include of okemu_prelude.h - is
        # silently dropped. That is not a warning, it is a no-op, and the
        # first symptom is TimeLib.h redefining time_t because the prelude
        # that would have prevented it was never included.
        #
        # ForcedIncludeFiles is the MSVC spelling of -include. The path
        # resolves through include_dirs, where shim/ is already first.
        # ------------------------------------------------------------------
        ["OS=='win'", {
          "msvs_settings": {
            # node-gyp's common.gypi turns on whole-program optimisation for
            # Release and hands the librarian /LTCG:INCREMENTAL. That is an
            # MSVC spelling; the ClangCL toolset uses llvm-lib.exe, which
            # rejects it outright with "/LTCG:INCREMENTAL: no such file or
            # directory" - an error that reads like a missing file rather
            # than an unknown flag. LTCG buys nothing here anyway: clang does
            # its cross-TU work through its own LTO, not MSVC's.
            "VCLibrarianTool": {
              "AdditionalOptions!": ["/LTCG:INCREMENTAL"]
            },
            "VCCLCompilerTool": {
              "WholeProgramOptimization": "false",
              "ForcedIncludeFiles": ["okemu_prelude.h"],
              # The firmware is 2015-era Arduino C++ and warns constantly.
              # This is the -w the POSIX side passes.
              "WarningLevel": "0",
              "SuppressStartupBanner": "true",
              # /EHsc. The firmware itself does not throw, but the staged
              # tree includes C++ standard headers that require unwinding
              # semantics to be declared.
              "ExceptionHandling": "1",
              "AdditionalOptions": [
                "-fno-strict-aliasing",
                "-fwrapv",
                "-std=gnu++11",
                "-Wno-everything",
                # uECC.c calls uECC_point_mult() eleven lines before defining
                # it, and its declaration lives in uECC_vli.h, which that
                # translation unit does not include. C89 allowed the implicit
                # declaration; GCC still only warns, so the POSIX build's -w
                # hides it. clang 16 promoted it to an error, and -Wno-everything
                # does not cover errors.
                #
                # Restoring the GCC behaviour keeps Windows consistent with the
                # build that already ships rather than making it uniquely
                # strict. It is a latent issue in uECC either way - the call
                # site and the definition happen to agree - and the real fix is
                # for uECC.c to include its own header, which is firmware.
                "-Wno-implicit-function-declaration",
                "-Wno-error=implicit-function-declaration"
              ]
            }
          },
          # clang-cl, not MSVC. The firmware is GCC-flavoured C++:
          # __attribute__ appears over 170 times - always_inline, packed,
          # aligned, weak - plus GCC inline assembly, and cl.exe has no
          # concept of any of it. Measured, not assumed: every probe
          # translation unit dies on the first __attribute__ it reaches, in a
          # header, before compiling a line of real code.
          #
          # Neutralising __attribute__ with a macro is not an option either:
          # `packed` is load-bearing on the USB descriptor structs, so
          # dropping it changes struct layout and yields descriptors that are
          # subtly wrong rather than a compile error.
          #
          # clang-cl understands the GNU extensions and still emits MSVC-ABI
          # objects, which is what lets the result link into Node.
          #
          # Needs the "C++ Clang Compiler for Windows" and "MSBuild support
          # for LLVM (clang-cl) toolset" components - see SETUP.md.
          "msbuild_toolset": "ClangCL"
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

      # Forward slashes, and <!( rather than <!@(.
      #
      # include_dir is a native path, so on Windows it comes back as
      # `node_modules\node-addon-api` - and the backslash-n is consumed as an
      # escape on its way through gyp, leaving `node_modulesnode-addon-api`
      # and a "'napi.h' file not found" that names the wrong problem
      # entirely. Normalising to forward slashes avoids it; Windows accepts
      # them everywhere, and on POSIX there is nothing to normalise.
      #
      # String.fromCharCode(92) rather than a backslash, and that is not
      # squeamishness - it is the only form that survives both shells.
      # gyp runs this through cmd on Windows and /bin/sh on POSIX, and they
      # disagree about backslashes inside double quotes: sh collapses `\\` to
      # `\`, so the obvious `.replace(/\\/g,'/')` reaches node as
      # `.replace(/\/g,'/')`, where the backslash escapes the slash, the regex
      # literal never closes, and the build dies with "SyntaxError: missing )
      # after argument list" pointing at node-addon-api. A command containing
      # no backslash at all cannot be quoted wrongly by either shell.
      #
      # <!( keeps the result as one string instead of splitting it on
      # whitespace, which also makes a path containing spaces survive.
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir.split(String.fromCharCode(92)).join('/')\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=gnu++17", "-fexceptions"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],

      "conditions": [
        # Same toolset as the firmware static library it links against.
        # Mixing ClangCL and MSVC across the two would probably work - both
        # target the MSVC ABI - but "probably" is not a good property for a
        # link step, and a mismatch surfaces as unresolved symbols rather
        # than as anything that names the cause.
        #
        # No ForcedIncludeFiles here: okemu_prelude.h is for the firmware,
        # and it renames random()/srandom(), which addon.cpp has no reason to
        # inherit. The POSIX side keeps the same split - the prelude is on
        # the firmware target's cflags, not in target_defaults.
        ["OS=='win'", {
          "msbuild_toolset": "ClangCL",
          "msvs_settings": {
            # Same reason as the firmware target: the LLVM tools do not take
            # MSVC's LTCG spellings.
            "VCLinkerTool": {
              "LinkTimeCodeGeneration": "0"
            },
            "VCCLCompilerTool": {
              "WholeProgramOptimization": "false",
              "ExceptionHandling": "1",
              "WarningLevel": "3"
              #
              # Deliberately no -std here, unlike the POSIX side's gnu++17.
              # node-gyp's common.gypi already passes -std:c++20, and Node 24's
              # own headers want it; overriding downwards on the target that
              # actually includes node.h is how you get template errors deep
              # inside V8 that have nothing to do with this code. C++20 is a
              # superset of what addon.cpp needs, so there is nothing to gain
              # by forcing it back.
              #
              # The firmware target is the opposite case: it includes no Node
              # headers and genuinely needs gnu++11, so it overrides there.
            }
          }
        }]
      ],

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
      #
      # Nothing to port to Windows here, and nothing missing. gyp drops
      # ldflags on the msvs generator, and the problem this solves does not
      # exist there: the PE loader has no global symbol interposition, so a
      # firmware symbol named recvmsg cannot be captured by anyone else's.
      "ldflags": ["-Wl,-Bsymbolic", "-rdynamic"]
    }
  ]
}
