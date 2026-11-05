# libokemu.so - the OnlyKey firmware, compiled for Android.
#
# The Android build of the same soft key the Node addon is: the same src/,
# core-override/, shim/ and staged .stage/ tree in emulator/, staged by the same
# scripts/stage.js (OKEMU_TARGET=android) and listed by the same
# scripts/gen-sources.js (sources.cmake beside sources.gypi). Ported from
# ok-rn/android/okemu/CMakeLists.txt; only the paths moved.
#
# Two differences of substance from binding.gyp:
#
#   * No -fpermissive. That is a GCC flag; clang accepts it as an unused
#     argument and implements nothing. Anything GCC was downgrading to a
#     warning is a hard error here, so OKEMU_LENIENT below re-permits the
#     specific constructs this decade-old Arduino code relies on, one named
#     warning at a time rather than with a blanket -w.
#
#   * The N-API target is gone. jni/okemu_jni.cpp replaces src/addon.cpp and is
#     compiled at C++17 while the firmware stays at gnu++11 - the standard it
#     was written against - so the two cannot share a compile line.
#
# Run scripts/stage.js (OKEMU_TARGET=android) and scripts/gen-sources.js before
# configuring; build.gradle beside this file does that at configuration time.

cmake_minimum_required(VERSION 3.22.1)
project(okemu C CXX)

# emulator/ - where src, core-override, shim, .stage and sources.cmake live.
get_filename_component(OKEMU_DIR ${CMAKE_CURRENT_SOURCE_DIR}/.. ABSOLUTE)
set(OKEMU_ANDROID_DIR ${CMAKE_CURRENT_SOURCE_DIR})

if(NOT EXISTS ${OKEMU_DIR}/sources.cmake)
  message(FATAL_ERROR
    "sources.cmake missing. In emulator/, run:\n"
    "  OKEMU_TARGET=android node scripts/stage.js && node scripts/gen-sources.js")
endif()
include(${OKEMU_DIR}/sources.cmake)

# Windows hosts: the staged sources sit outside this folder, so CMake names each
# object after the source's absolute path (CMakeFiles/okemu_firmware.dir/C_/Users/
# .../emulator/.stage/libraries/Crypto/...). Under a host app's .cxx folder that
# passes the 248 characters Windows allows a directory, and ninja fails at mkdir.
# CMake's default limit (250) is for the whole object file path, so the folder
# above it can still pass 248. At 240 CMake hashes the part after its own build
# folder until the whole path fits; it cannot go much lower, because only that
# part can be shortened. Other hosts have no such limit and keep the readable
# names.
if(CMAKE_HOST_WIN32)
  set(CMAKE_OBJECT_PATH_MAX 240)
endif()

# ----------------------------------------------------------------- the library

# Two targets, as in binding.gyp - and for a reason beyond the C++ standard.
#
# libraries/tweetnacl and libraries/justhashtweetnacl are both complete copies
# of TweetNaCl and define the same 25 crypto_* symbols. Linking every object
# into one shared library makes that a duplicate-symbol error. Archiving the
# firmware first lets the linker pull only the objects it actually needs, which
# is how the Node emulator links cleanly without anyone noticing the clash.
add_library(okemu_firmware STATIC ${OKEMU_SOURCES})
add_library(okemu SHARED ${OKEMU_ANDROID_DIR}/jni/okemu_jni.cpp)

# shim/ first: our Adafruit_NeoPixel.h and rsa.h must shadow the upstream
# copies further down the path.
target_include_directories(okemu_firmware PUBLIC
  ${OKEMU_DIR}/shim
  ${OKEMU_DIR}/src

  ${OKEMU_DIR}/.stage/libraries/onlykey
  ${OKEMU_DIR}/.stage/libraries/onlykey/utility
  ${OKEMU_DIR}/.stage/libraries/Crypto
  ${OKEMU_DIR}/.stage/libraries/SoftTimer
  ${OKEMU_DIR}/.stage/libraries/T3Mac
  ${OKEMU_DIR}/.stage/libraries/base64
  ${OKEMU_DIR}/.stage/libraries/password
  ${OKEMU_DIR}/.stage/libraries/sha1
  ${OKEMU_DIR}/.stage/libraries/sha256
  ${OKEMU_DIR}/.stage/libraries/totp
  ${OKEMU_DIR}/.stage/libraries/tweetnacl
  ${OKEMU_DIR}/.stage/libraries/justhashtweetnacl
  ${OKEMU_DIR}/.stage/libraries/uECC
  ${OKEMU_DIR}/.stage/libraries/ykcore
  ${OKEMU_DIR}/.stage/libraries/yksim
  ${OKEMU_DIR}/.stage/libraries/randombytes
  ${OKEMU_DIR}/.stage/libraries/fido2
  ${OKEMU_DIR}/.stage/libraries/tinycbor
  ${OKEMU_DIR}/.stage/libraries/mbedtls-2.4.0
  ${OKEMU_DIR}/.stage/libraries/flashkinetis

  ${OKEMU_DIR}/.stage/sketch
  ${OKEMU_DIR}/.stage/core

  # The stock Arduino libraries are staged too, so every include path points
  # inside .stage and any of them can be patched. Time additionally has its
  # one-line Time.h shim removed - see defuseTimeHeader() in scripts/stage.js.
  ${OKEMU_DIR}/.stage/libraries/EEPROM
  ${OKEMU_DIR}/.stage/libraries/ADC
  ${OKEMU_DIR}/.stage/libraries/Time
)

# Same board configuration the real firmware is built with - see
# arduino-1.6.5-r5/preferences.txt (board=teensy31, usb=rawhid, 72 MHz, en-us).
# OK_EMULATOR is what gates the firmware's own hosted-build branches; the
# device toolchain never defines it.
target_compile_definitions(okemu_firmware PUBLIC
  __MK20DX256__
  TEENSYDUINO=127
  USB_RAWHID
  F_CPU=72000000
  ARDUINO=10605
  LAYOUT_US_ENGLISH
  OK_EMULATOR=1

  # Arduino's TimeLib.h does:
  #
  #     #if !defined(__time_t_defined)   // avoid conflict with newlib or other posix libc
  #     typedef unsigned long time_t;
  #     #endif
  #
  # __time_t_defined is a *glibc* macro. bionic defines time_t (as a signed
  # long) but never that macro, so the guard does not fire and the typedef
  # collides. Declaring it satisfies the guard and leaves bionic's time_t in
  # place; both are 32-bit on armeabi-v7a, differing only in signedness, which
  # matters no earlier than 2038.
  __time_t_defined

  # Where the emulated flash array lives: the NAME of a variable the HAL sets
  # once the kernel has told it where the mapping landed (src/ok_hal.cpp,
  # __ANDROID__ branch), not an address. A fixed address is a bet against every
  # runtime's allocator on every device, and 0x44000000 lost: ART's JIT zygote
  # cache occupies exactly that range on a Pixel 6a running Android 16.
  #
  # ok_hal.h and shim/okemu_prelude.h say the same under __ANDROID__ (#ifndef),
  # and okcore.h's rebased constants (scripts/stage.js) read it, so the HAL and
  # the firmware cannot disagree about where the array is.
  OKEMU_FLASH_BASE=okemu_flash_base
)


# Constructs GCC's -fpermissive waved through. Listed individually so that a
# genuinely new error is not hidden by a blanket -w, which is what the Node
# emulator uses. Trim this list as the code is fixed, never extend it blindly.
set(OKEMU_LENIENT
  -Wno-write-strings                  # string literal -> char*
  -Wno-narrowing                      # narrowing in braced init
  -Wno-int-conversion
  -Wno-implicit-function-declaration   # K&R-era C in the vendored libraries
  -Wno-return-type
  -Wno-parentheses
  -Wno-sign-compare
  -Wno-unused-variable
  -Wno-unused-function
  -Wno-unused-but-set-variable
  -Wno-deprecated-declarations
  -Wno-invalid-offsetof
  -Wno-register                        # 'register' is removed in C++17, used here
  -Wno-misleading-indentation
  -Wno-macro-redefined
  -Wno-pointer-sign
)

# -fno-strict-aliasing and -fwrapv: the firmware type-puns through peripheral
# registers and relies on wrapping arithmetic. Both were load-bearing on the
# MK20DX256 too.
target_compile_options(okemu_firmware PRIVATE
  -fno-strict-aliasing
  -fwrapv
  -fPIC
  # okeeprom.c builds its address tables as one deeply parenthesised constant
  # expression. clang's default nesting cap is 256; GCC has no equivalent limit,
  # which is why the Node emulator never had to raise it.
  -fbracket-depth=1024
  ${OKEMU_LENIENT}
  # okemu_prelude.h renames Teensy's random()/srandom() away from libc's before
  # any translation unit can see both. Force-included so the ordering holds
  # even in files that reach <stdlib.h> only indirectly.
  -include ${OKEMU_DIR}/shim/okemu_prelude.h
  $<$<COMPILE_LANGUAGE:CXX>:-std=gnu++11>
  $<$<COMPILE_LANGUAGE:C>:-std=gnu11>
)

# jni/okemu_jni.cpp is ours and modern: C++17, and none of the leniency the
# firmware needs. It inherits only the include paths and defines, via PUBLIC.
target_compile_features(okemu PRIVATE cxx_std_17)
set_target_properties(okemu_firmware PROPERTIES POSITION_INDEPENDENT_CODE ON)

# bionic exports recvmsg(2) exactly as glibc does, and okcore.cpp defines its
# own. -Bsymbolic binds our references to our definition rather than letting
# the dynamic linker interpose libc's.
target_link_options(okemu PRIVATE -Wl,-Bsymbolic)
# 16 KB PAGES (Android 15+; Google Play requires it for new apps from Nov 2025): the library's segments aligned to
# 16 KB, so it loads on a phone whose kernel runs 16 KB pages. NDK r27 still links 4 KB by default (r28 does this
# itself) - the APK's other libraries already were; this one was 0x1000 (llvm-readelf -l, 2026-11-05).
target_link_options(okemu PRIVATE -Wl,-z,max-page-size=16384)

find_library(log-lib log)
target_link_libraries(okemu okemu_firmware ${log-lib})
