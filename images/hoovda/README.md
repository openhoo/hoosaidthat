# HooVDA Playwright runtime

Linux/amd64 image containing HooVDA, Playwright Chromium, AT-SPI, Xvfb,
physical X11 input, eSpeak NG, Liblouis, and FFmpeg evidence recording.
No Windows component, NVDA binary, NVDA source, compatibility layer, or fork.

Local build requires sibling `../hoovda` checkout:

```bash
podman build --platform linux/amd64 -t hoovda-engine:dev ../hoovda
podman build --platform linux/amd64 -t hoosaidthat-hoovda:dev \
  -f images/hoovda/Dockerfile .
```

Public publication remains disabled until `hoovda conformance` passes complete
NVDA 2026.1.1 black-box oracle coverage.
