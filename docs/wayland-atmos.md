# Wayland / Dolby Atmos investigation

The existing player in `ui/js/player.js` uses Electron/Chromium HTML5 video and hls.js.
It does **not** provide direct HDMI compressed-audio passthrough controls. Selecting
5.1 or 7.1 in Plasma changes PCM speaker layout; it does not enable Atmos.

## Diagnostics
In the desktop app, open **Settings → HDMI audio diagnostics → Copy**.
This reads `pactl info`, `pactl list short sinks`, `aplay -l`, and
`XDG_SESSION_TYPE` and copies the result to the clipboard. It makes no
changes to system audio settings and does not assert Atmos capability.

## What is still required for Atmos
- Confirm exact Hisense U8 model, eARC enabled, Digital Audio Out set to Pass Through.
- Confirm Fire TV soundbar's exact model and actual reported incoming audio format.
- Test with an authorized source containing E-AC3 JOC (streaming Atmos), then
  optionally TrueHD Atmos (requires compatible eARC passthrough).
- Implement and test a **Wayland-native in-window video renderer with an encoded
  audio passthrough path**. An external MPV fullscreen process is not a replacement
  for the existing remote-first overlay. libmpv is a possible backend but native
  texture integration with Electron on Wayland is nontrivial; do not advertise
  that capability until it is built and tested.
- Keep Chromium playback as a fallback; add backend capabilities and codec
  reporting before exposing unverified Atmos toggles.

## Development check
Run `npm run test:ui` and test settings with a remote on KDE neon Wayland.
Audio hardware validation requires the real mini PC / TV / soundbar chain.
