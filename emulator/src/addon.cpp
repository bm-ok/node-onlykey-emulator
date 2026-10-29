/*
 * addon.cpp - the N-API surface.
 *
 * The firmware is a bare-metal program: setup() then an endless loop(). It
 * cannot run on the JS thread, so it gets its own std::thread and everything
 * it produces (LED changes, keystrokes, debug output, HID replies, reboot
 * requests) crosses back through ThreadSafeFunctions.
 *
 * JS surface:
 *   start({ storageDir, onLed, onKeyboard, onLog, onHid, onRestart })
 *   sendHid(buffer, iface)   host -> device, iface 1=FIDO 2=vendor
 *   setButton(n, down)       n = 1..6
 *   factoryReset()
 *   stop()
 */
#include <napi.h>

#include <thread>
#ifdef _WIN32
#include <windows.h>
#include <process.h>   /* _beginthreadex: std::thread cannot set a stack size */
#endif
#include <string>
#include <vector>

#include "ok_hal.h"
#include "okemu_press.h"

namespace {

struct Emu {
  std::thread thread;
  bool running = false;

  Napi::ThreadSafeFunction led;
  Napi::ThreadSafeFunction stream;
  Napi::ThreadSafeFunction restart;
  Napi::ThreadSafeFunction plugin;
};

Emu g;

/* ------------------------------------------------------------- sinks */

void on_led(const okemu_rgb *px, int count, void * /*ctx*/) {
  if (!g.led) return;
  std::vector<okemu_rgb> snap(px, px + count);
  g.led.NonBlockingCall([snap](Napi::Env env, Napi::Function cb) {
    Napi::Array arr = Napi::Array::New(env, snap.size());
    for (size_t i = 0; i < snap.size(); i++) {
      Napi::Object o = Napi::Object::New(env);
      o.Set("r", Napi::Number::New(env, snap[i].r));
      o.Set("g", Napi::Number::New(env, snap[i].g));
      o.Set("b", Napi::Number::New(env, snap[i].b));
      arr.Set(i, o);
    }
    cb.Call({arr});
  });
}

/*
 * The whole USB bus as one stream: onStream(buffer, iface, dir). JS demuxes on
 * iface (0 keyboard, 1 FIDO, 2 vendor, 3 SEREMU) and dir ('out' = device to
 * host, 'in' = host to device), which is exactly what the UI debug log wants.
 */
void on_stream(const uint8_t *d, size_t n, int iface, int dir, void *) {
  if (!g.stream) return;
  std::vector<uint8_t> buf(d, d + n);
  g.stream.NonBlockingCall([buf, iface, dir](Napi::Env env, Napi::Function cb) {
    cb.Call({Napi::Buffer<uint8_t>::Copy(env, buf.data(), buf.size()),
             Napi::Number::New(env, iface),
             Napi::String::New(env, dir == OKEMU_DIR_IN ? "in" : "out")});
  });
}

void on_restart(void * /*ctx*/) {
  if (!g.restart) return;
  g.restart.NonBlockingCall([](Napi::Env env, Napi::Function cb) {
    cb.Call({});
  });
}

}  // namespace

/*
 * A firmware plugin's event (plugins/key_chain: a derived public key the soft
 * key answered, a press record). The plugin declares okemu_plugin_event weak
 * and calls it only when a host provides it; Android's JNI does
 * (android/jni/okemu_jni.cpp), and so does this addon: onPluginEvent(name,
 * buffer), the module's 'plugin' event. Called on the firmware thread, so it
 * goes through a thread-safe function and never waits for JS.
 */
extern "C" void okemu_plugin_event(const char *name, const uint8_t *data, int len) {
  if (!g.plugin || !name || !data || len <= 0) return;
  std::string n(name);
  std::vector<uint8_t> buf(data, data + len);
  g.plugin.NonBlockingCall([n, buf](Napi::Env env, Napi::Function cb) {
    cb.Call({Napi::String::New(env, n), Napi::Buffer<uint8_t>::Copy(env, buf.data(), buf.size())});
  });
}

namespace {

/* ---------------------------------------------------------- bindings */

Napi::Value Start(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (g.running) {
    Napi::Error::New(env, "emulator already started").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "start(options) requires an object")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object opt = info[0].As<Napi::Object>();
  std::string dir = opt.Has("storageDir")
                        ? opt.Get("storageDir").As<Napi::String>().Utf8Value()
                        : std::string("./.onlykey-storage");

  /* The board, before anything maps or runs - see okemu_set_board(). */
  if (opt.Has("hardware") && !opt.Get("hardware").IsUndefined()) {
    if (!opt.Get("hardware").IsString()) {
      Napi::TypeError::New(env, "hardware must be a string").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    std::string hw = opt.Get("hardware").As<Napi::String>().Utf8Value();
    if (okemu_set_board(hw.c_str()) != 0) {
      Napi::TypeError::New(env, "hardware must be \"onlykey\", \"onlykey-bga\" or \"duo\", got \"" + hw + "\"")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }

  char err[512] = {0};
  if (okemu_hal_init(dir.c_str(), err, sizeof err) != 0) {
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  struct { const char *name; Napi::ThreadSafeFunction *slot; } cbs[] = {
    {"onLed",     &g.led},
    {"onStream",  &g.stream},
    {"onRestart", &g.restart},
    {"onPluginEvent", &g.plugin},
  };
  for (auto &c : cbs) {
    if (opt.Has(c.name) && opt.Get(c.name).IsFunction()) {
      *c.slot = Napi::ThreadSafeFunction::New(
          env, opt.Get(c.name).As<Napi::Function>(), c.name, 0, 1);
    }
  }

  okemu_set_led_sink(on_led, nullptr);
  okemu_set_stream_sink(on_stream, nullptr);
  okemu_set_restart_sink(on_restart, nullptr);

  /*
   * Detached immediately: the firmware sits in an endless loop() with no
   * cooperative exit, so it is never joined. Leaving a joinable std::thread
   * alive would make its destructor call std::terminate() whenever the process
   * exits without stop() - which is what any plain process.exit() does.
   */
  g.running = true;
#ifdef _WIN32
  /*
   * THE FIRMWARE THREAD NEEDS A BIGGER STACK THAN WINDOWS HANDS OUT.
   *
   * std::thread takes whatever the platform gives it, and that default is not
   * the same on both: glibc gives a new thread 8 MB, while Windows reserves
   * whatever the host executable's PE header asks for - 1 MB for node.exe.
   *
   * The firmware was written for a 64 KB-RAM microcontroller and is frugal,
   * but mbedtls is not: an RSA-2048 operation puts several mbedtls_mpi
   * working buffers on the stack, and the FIDO2 and WebAuthn paths nest
   * deeper still. Running the protocol section, 63 tests passed and then the
   * device host died with exit code 3221225725 - 0xC00000FD,
   * STATUS_STACK_OVERFLOW - part way through the WebAuthn tunnel tests.
   *
   * There is no portable way to set a stack size on std::thread, so Windows
   * gets _beginthreadex, which takes one. 8 MB matches what the Linux build
   * has always had, so this is not a new allowance - it is the same one,
   * asked for explicitly on a platform that does not grant it by default.
   *
   * Detached the same way, and for the same reason: the firmware's loop()
   * never returns, so the thread is never joined.
   */
  unsigned tid = 0;
  uintptr_t h = _beginthreadex(
      nullptr, 8u * 1024u * 1024u,
      [](void *) -> unsigned {
        /*
         * LEAVE ROOM TO REPORT AN OVERFLOW.
         *
         * When a thread exhausts its stack there is, by definition, no stack
         * left to run an exception handler on - so the vectored reporter in
         * okemu_restart.cpp never ran, and the process just vanished with a
         * status code and nothing else. That is why "no handler fired" was
         * mistaken for "not a stack problem" once already.
         *
         * SetThreadStackGuarantee reserves a slice that only the exception
         * machinery may use, so the overflow can be reported as an overflow.
         * 64 KB is the usual figure and is plenty for a snprintf and an
         * fwrite.
         */
        ULONG guarantee = 64 * 1024;
        SetThreadStackGuarantee(&guarantee);

        okemu_firmware_run();   /* returns only on CPU_RESTART() */
        g.running = false;
        return 0;
      },
      nullptr, 0, &tid);
  if (h) CloseHandle((HANDLE)h);
#else
  std::thread([] {
    okemu_firmware_run();   /* returns only on CPU_RESTART() */
    g.running = false;
  }).detach();
#endif

  return env.Undefined();
}

/*
 * sendHidTaken(buffer, iface[, timeoutMs]) -> Promise<boolean>: the write a USB
 * host gets from a hard key - settled once the firmware has TAKEN the report
 * (true), or at the deadline (false; the write still stands). The wait runs on
 * a worker thread: on the JS thread it would stall Node's event loop, and with
 * it an Electron main process (ok_hal.cpp, okemu_hid_wait_taken). sendHid stays
 * as it was, for callers that only queue.
 */
class TakenWorker : public Napi::AsyncWorker {
 public:
  TakenWorker(Napi::Env env, uint64_t ticket, uint32_t ms)
      : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), ticket_(ticket), ms_(ms) {}
  void Execute() override { taken_ = okemu_hid_wait_taken(ticket_, ms_); }
  void OnOK() override { deferred.Resolve(Napi::Boolean::New(Env(), taken_ != 0)); }
  Napi::Promise::Deferred deferred;

 private:
  uint64_t ticket_;
  uint32_t ms_;
  int taken_ = 0;
};

Napi::Value SendHidTaken(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "sendHidTaken(buffer, iface[, timeoutMs]) requires a Buffer and an interface")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  int iface = info[1].As<Napi::Number>().Int32Value();
  uint32_t ms = (info.Length() > 2 && info[2].IsNumber()) ? info[2].As<Napi::Number>().Uint32Value() : 1000;
  uint64_t ticket = 0;
  if (okemu_hid_deliver_ticket(buf.Data(), buf.Length(), iface, &ticket) != 0) {
    Napi::Error::New(env, "interface is not writable (use 1 = FIDO, 2 = vendor, 3 = SEREMU)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto *worker = new TakenWorker(env, ticket, ms);
  Napi::Promise promise = worker->deferred.Promise();
  worker->Queue();
  return promise;
}

Napi::Value SendHid(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "sendHid(buffer[, iface]) requires a Buffer")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  int iface = (info.Length() > 1 && info[1].IsNumber())
                  ? info[1].As<Napi::Number>().Int32Value()
                  : OKEMU_IFACE_FIDO;
  if (okemu_hid_deliver(buf.Data(), buf.Length(), iface) != 0) {
    Napi::Error::New(env,
        "interface is not writable (0 = keyboard is device->host only); "
        "use 1 = FIDO, 2 = vendor, 3 = SEREMU")
        .ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

/*
 * The keyboard interface's control-transfer channel, driven by the UHID
 * bridge: kbdSetReport(buffer) on a host SET_REPORT, kbdGetReport() to answer
 * a host GET_REPORT.
 */
Napi::Value KbdSetReport(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "kbdSetReport(buffer) requires a Buffer")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto buf = info[0].As<Napi::Buffer<uint8_t>>();
  okemu_kbd_set_report(buf.Data(), (uint32_t)buf.Length());
  return env.Undefined();
}

Napi::Value KbdGetReport(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  uint8_t out[8] = {0};
  int n = okemu_kbd_get_report(out);
  return Napi::Buffer<uint8_t>::Copy(env, out, n);
}

Napi::Value SetButton(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "setButton(n, down) requires (number, boolean)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  okemu_set_button(info[0].As<Napi::Number>().Int32Value(),
                   info[1].ToBoolean().Value() ? 1 : 0);
  return env.Undefined();
}

/*
 * pressQueue(buttons: number[], ticks: number[]) -> accepted
 *
 * Presses handed to the firmware's own dispatch - see okemu_press.h. This is
 * what pressButtons() uses, and unlike the DEBUG console it replaced it works
 * on a production build. Returns how many were queued; fewer than asked means
 * the queue was full or an entry was not a button.
 */
Napi::Value PressQueue(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsArray()) {
    Napi::TypeError::New(env, "pressQueue(buttons, ticks) requires two arrays")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Array b = info[0].As<Napi::Array>(), t = info[1].As<Napi::Array>();
  if (b.Length() != t.Length()) {
    Napi::RangeError::New(env, "pressQueue: buttons and ticks differ in length")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::vector<uint8_t> buttons(b.Length());
  std::vector<uint16_t> ticks(t.Length());
  for (uint32_t i = 0; i < b.Length(); i++) {
    int bn = b.Get(i).ToNumber().Int32Value();
    int tn = t.Get(i).ToNumber().Int32Value();
    /* Out of range becomes 0, which okemu_press_queue() refuses. */
    buttons[i] = (bn >= 1 && bn <= 6) ? (uint8_t)bn : 0;
    ticks[i] = (tn >= 1 && tn <= 0xFFFF) ? (uint16_t)tn : 0;
  }
  int n = buttons.empty() ? 0
        : okemu_press_queue(buttons.data(), ticks.data(), (int)buttons.size());
  return Napi::Number::New(env, n);
}

/* What the firmware is waiting for, packed (ok_hal.h okemu_confirm_state); -1 when it cannot say. */
Napi::Value ConfirmState(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), okemu_confirm_state());
}

/* Presses queued but not yet taken by the firmware; 0 means all taken. */
Napi::Value PressPending(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), okemu_press_pending());
}

/* setButtonTicks(n, ticks) - a finger on the pad for N sense rounds. */
Napi::Value SetButtonTicks(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "setButtonTicks(n, ticks) requires two numbers")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  okemu_set_button_ticks(info[0].As<Napi::Number>().Int32Value(),
                         info[1].As<Napi::Number>().Int32Value());
  return env.Undefined();
}

Napi::Value ButtonTicksLeft(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "buttonTicksLeft(n) requires a number")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  return Napi::Number::New(env,
      okemu_button_ticks_left(info[0].As<Napi::Number>().Int32Value()));
}

/* Sense rounds since start. A double holds it exactly for 2^53 rounds. */
Napi::Value Rounds(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), (double)okemu_rounds());
}

/* The model the firmware detected (5 OK_HW_COLOR, 9 OK_HW_DUO) - its onlykeyhw. */
Napi::Value DetectedHw(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), (double)okemu_detected_hw());
}

Napi::Value FactoryReset(const Napi::CallbackInfo &info) {
  okemu_factory_reset();
  return info.Env().Undefined();
}

/*
 * Whether the running firmware's callbacks hold the event loop. Unref: the process may exit while the firmware runs
 * (the thread goes with it); Ref: held again. The firmware is not stopped either way - it cannot be restarted in one
 * process, so a host that closes the key and may open it again unrefs instead of stopping.
 */
Napi::Value Ref(const Napi::CallbackInfo &info) {
  for (auto *t : {&g.led, &g.stream, &g.restart, &g.plugin}) {
    if (*t) t->Ref(info.Env());
  }
  return info.Env().Undefined();
}

Napi::Value Unref(const Napi::CallbackInfo &info) {
  for (auto *t : {&g.led, &g.stream, &g.restart, &g.plugin}) {
    if (*t) t->Unref(info.Env());
  }
  return info.Env().Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  okemu_hal_shutdown();
  for (auto *t : {&g.led, &g.stream, &g.restart, &g.plugin}) {
    if (*t) { t->Release(); }
  }
  /*
   * The firmware thread sits in an endless loop(); there is no cooperative
   * exit short of a reboot request, so it is left detached and the process
   * teardown reclaims it. Restarts respawn the process anyway.
   */
  if (g.thread.joinable()) g.thread.detach();
  g.running = false;
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start",        Napi::Function::New(env, Start));
  exports.Set("sendHid",      Napi::Function::New(env, SendHid));
  exports.Set("sendHidTaken", Napi::Function::New(env, SendHidTaken));
  exports.Set("setButton",    Napi::Function::New(env, SetButton));
  exports.Set("pressQueue",      Napi::Function::New(env, PressQueue));
  exports.Set("pressPending",    Napi::Function::New(env, PressPending));
  exports.Set("confirmState",    Napi::Function::New(env, ConfirmState));
  exports.Set("setButtonTicks",  Napi::Function::New(env, SetButtonTicks));
  exports.Set("buttonTicksLeft", Napi::Function::New(env, ButtonTicksLeft));
  exports.Set("rounds",          Napi::Function::New(env, Rounds));
  exports.Set("detectedHw",      Napi::Function::New(env, DetectedHw));
  exports.Set("factoryReset", Napi::Function::New(env, FactoryReset));
  exports.Set("stop",         Napi::Function::New(env, Stop));
  exports.Set("ref",          Napi::Function::New(env, Ref));
  exports.Set("unref",        Napi::Function::New(env, Unref));
  exports.Set("kbdSetReport", Napi::Function::New(env, KbdSetReport));
  exports.Set("kbdGetReport", Napi::Function::New(env, KbdGetReport));
  /* usb_desc.h interface numbers; HIDn in the UI is interface n-1. */
  exports.Set("IFACE_KEYBOARD", Napi::Number::New(env, OKEMU_IFACE_KEYBOARD));
  exports.Set("IFACE_FIDO",     Napi::Number::New(env, OKEMU_IFACE_FIDO));
  exports.Set("IFACE_VENDOR",   Napi::Number::New(env, OKEMU_IFACE_VENDOR));
  exports.Set("IFACE_SEREMU",   Napi::Number::New(env, OKEMU_IFACE_SEREMU));
  return exports;
}

}  // namespace

NODE_API_MODULE(onlykey_emulator, Init)
