# Orca runtime image

Stack: Playwright Chromium, Orca, AT-SPI 2, Xvfb, Matchbox, Speech Dispatcher,
`xdotool`, and the v1 local control service.

Published reference image architecture: Linux amd64. Base image digest is pinned
to that architecture; no untested multi-architecture manifest is claimed.

Reference inputs pin Playwright `1.62.1`, Chromium `151.0.7922.34`, upstream
GNOME Orca commit `46c56130b2275a7e9637c24ac95462f02872ae80`, AT-SPI `2.58.8`,
Speech Dispatcher `0.12.0~rc2`, Ubuntu base digest, Matchbox, Xvfb, and
`xdotool`. The final image copies only Playwright's Chromium payload; Firefox,
WebKit, headless shell, build tools, headers, locale catalogs, help, desktop
launchers, icons, and Orca development files stay outside it.
No Orca fork or source patch is used.
Ubuntu dependency repositories remain time-varying. Published image digest,
SBOM, and provenance are the exact artifact lock for a release build.

Build and smoke-test:

```bash
podman build -t hoosaidthat-orca:dev -f images/orca/Dockerfile .
CONTAINER_ENGINE=podman bash images/orca/smoke-test.sh hoosaidthat-orca:dev
```

The smoke test starts a loopback fixture page, launches the actual stack, checks
CDP and every control-plane health component, verifies AT-SPI web-document focus,
and requires captured Orca speech.

The output module deliberately renders no audio. It records normalized text at
the Speech Dispatcher presentation-request boundary. That is the same strict
capture pattern proven in `../screenreader/screenreader-pathfinder`; research,
planner, and privileged verifier layers are not copied into this test runtime.

The v1 action catalog omits `Ctrl+Home`/`Ctrl+End` document-boundary gestures.
Live review found nondeterministic stalls after those chords in isolated
Chromium contexts. Unknown actions fail closed; those gestures can return only
after a runtime-version qualification test is reliable.

Chromium runs with `--no-sandbox`, and the container uses host networking so a
browser inside it can reach Playwright `webServer` processes on loopback. Use
only for trusted test targets on isolated workers.
