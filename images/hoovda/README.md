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

Public publication is available only through the explicit tagged release
workflow. That workflow reruns the passing seven-case `hoovda conformance`
gate, native-Linux smoke tests, and Playwright E2E before publishing any
versioned artifact. Passing proves the declared browser-profile corpus, not
unrestricted NVDA parity.
