ARG HOOVDA_IMAGE=hoovda-engine:dev
FROM ${HOOVDA_IMAGE} AS hoovda-engine

FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac

ARG DEBIAN_FRONTEND=noninteractive
USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      at-spi2-core \
      curl \
      dbus-x11 \
      espeak-ng \
      ffmpeg \
      fonts-liberation \
      fonts-noto-color-emoji \
      liblouis-bin \
      libxres1 \
      matchbox-window-manager \
      tini \
      xdotool \
      xvfb \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o pwuser -g pwuser -m 0700 /opt/hoosaidthat /tmp/hoosaidthat

COPY --from=hoovda-engine /usr/local/bin/hoovda /usr/local/bin/hoovda
COPY --from=hoovda-engine /opt/hoovda-runtime /opt/hoovda-runtime
COPY --from=hoovda-engine /usr/src/hoovda-third-party /usr/src/hoovda-third-party
COPY --from=hoovda-engine /usr/share/doc/hoovda /usr/share/doc/hoovda
COPY LICENSE /usr/share/doc/hoosaidthat/LICENSE
COPY --chown=pwuser:pwuser images/hoovda/entrypoint.sh /opt/hoosaidthat/entrypoint.sh
COPY --chown=pwuser:pwuser images/hoovda/runtime-contract.json /opt/hoosaidthat/runtime-contract.json
COPY --chown=pwuser:pwuser images/orca/bootstrap.html /opt/hoosaidthat/bootstrap.html

RUN chmod 0755 /opt/hoosaidthat/entrypoint.sh /usr/local/bin/hoovda

ARG IMAGE_VERSION=dev
LABEL org.opencontainers.image.title="HooSaidThat HooVDA runtime" \
      org.opencontainers.image.description="HooVDA, Chromium, AT-SPI, physical X11 input, and synchronized evidence recording" \
      org.opencontainers.image.source="https://github.com/openhoo/hoosaidthat" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0 AND GPL-3.0-or-later AND LGPL-2.1-or-later" \
      dev.hoosaidthat.corresponding-source="/usr/src/hoovda-third-party" \
      dev.hoosaidthat.third-party-notices="/usr/share/doc/hoovda/THIRD_PARTY_NOTICES.md" \
      dev.hoosaidthat.protocol="2" \
      dev.hoosaidthat.screenreader="hoovda" \
      dev.hoosaidthat.profile="nvda-web-2026.1.1" \
      dev.hoosaidthat.platform="linux/amd64" \
      dev.hoosaidthat.windows="absent" \
      dev.hoosaidthat.release-gate="oracle-conformance-required"

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PATH=/opt/hoovda-runtime/bin:$PATH \
    LD_LIBRARY_PATH=/opt/hoovda-runtime/lib/x86_64-linux-gnu:/opt/hoovda-runtime/lib \
    XDG_DATA_DIRS=/opt/hoovda-runtime/share:/usr/local/share:/usr/share \
    HST_CONTROL_PORT=3000 \
    HST_CDP_PORT=9222 \
    HST_DISPLAY_NUMBER=99 \
    HST_VIEWPORT_WIDTH=1280 \
    HST_VIEWPORT_HEIGHT=720 \
    HST_START_URL=file:///opt/hoosaidthat/bootstrap.html \
    HOOVDA_PROFILE=nvda-web-2026.1.1 \
    HOOVDA_LOCALE=en-US \
    HOOVDA_KEYBOARD_LAYOUT=desktop

USER pwuser
WORKDIR /tmp/hoosaidthat

EXPOSE 3000 9222
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=2s --start-period=20s --retries=3 \
  CMD curl --fail --silent --show-error --max-time 1 --header "Authorization: Bearer $${HST_CONTROL_TOKEN}" "http://127.0.0.1:$${HST_CONTROL_PORT}/v2/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/hoosaidthat/entrypoint.sh"]
