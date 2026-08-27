FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac AS playwright-browser

FROM playwright-browser AS builder

ARG DEBIAN_FRONTEND=noninteractive

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      gettext \
      gobject-introspection \
      itstool \
      libdbus-1-dev \
      libgirepository1.0-dev \
      libglib2.0-dev \
      libgtk-3-dev \
      libxi-dev \
      libx11-dev \
      libxml2-dev \
      libxtst-dev \
      meson \
      ninja-build \
      pkg-config \
      python-gi-dev \
      python3-dasbus \
      python3-dev \
      python3-gi \
      python3-pytest \
      python3-pytest-mock \
      python3-speechd \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/build

ARG AT_SPI_COMMIT=042f105fc26265a5507b11a6673ab9c64d756169
ARG AT_SPI_SHA256=17feb9328acc6b7efcabb5a7cb089a552108fdff3af077893ad3b9049adec7ac

RUN curl --fail --location --retry 3 \
      "https://github.com/GNOME/at-spi2-core/archive/${AT_SPI_COMMIT}.tar.gz" \
      --output at-spi.tar.gz \
 && echo "${AT_SPI_SHA256}  at-spi.tar.gz" | sha256sum --check --strict \
 && mkdir at-spi \
 && tar --extract --gzip --file at-spi.tar.gz --directory at-spi --strip-components=1 \
 && meson setup at-spi/_build at-spi \
      --buildtype=release \
      --prefix=/usr/local \
      -Ddocs=false \
      -Dgtk2_atk_adaptor=false \
      -Dintrospection=enabled \
      -Duse_systemd=false \
      -Dx11=enabled \
 && meson compile -C at-spi/_build \
 && meson install -C at-spi/_build \
 && ldconfig

ENV GI_TYPELIB_PATH=/usr/local/lib/x86_64-linux-gnu/girepository-1.0 \
    LD_LIBRARY_PATH=/usr/local/lib/x86_64-linux-gnu \
    PKG_CONFIG_PATH=/usr/local/lib/x86_64-linux-gnu/pkgconfig \
    PYTHONPATH=/usr/local/lib/python3/dist-packages:/usr/local/lib/python3.12/dist-packages

ARG ORCA_COMMIT=46c56130b2275a7e9637c24ac95462f02872ae80
ARG ORCA_SHA256=17625404092bc44a6ef372c5e3e88744b0432c0737f111e84915f34176b64f5f

RUN curl --fail --location --retry 3 \
      "https://github.com/GNOME/orca/archive/${ORCA_COMMIT}.tar.gz" \
      --output orca.tar.gz \
 && echo "${ORCA_SHA256}  orca.tar.gz" | sha256sum --check --strict \
 && mkdir orca \
 && tar --extract --gzip --file orca.tar.gz --directory orca --strip-components=1 \
 && meson setup orca/_build orca \
      --buildtype=release \
      --prefix=/usr/local \
      -Dmathcat=false \
      -Dspiel=false \
 && meson compile -C orca/_build \
 && meson test -C orca/_build --suite unit --no-rebuild --print-errorlogs \
 && meson install -C orca/_build \
 && glib-compile-schemas /usr/local/share/glib-2.0/schemas \
 && find /usr/local -type d -name __pycache__ -prune -exec rm -rf '{}' + \
 && rm -rf \
      /usr/local/include \
      /usr/local/lib/x86_64-linux-gnu/pkgconfig \
      /usr/local/man \
      /usr/local/share/gir-1.0 \
      /usr/local/share/locale \
      /usr/local/share/applications \
      /usr/local/share/help \
      /usr/local/share/icons \
      /usr/local/lib/systemd \
      /usr/local/etc/xdg/autostart

FROM docker.io/library/ubuntu:24.04@sha256:1e0a86e57d247923571b75e0aaf48a1449cf8c543d51fb3e07a4a7d7bfa79316

ARG DEBIAN_FRONTEND=noninteractive
ARG ORCA_COMMIT=46c56130b2275a7e9637c24ac95462f02872ae80
ARG AT_SPI_VERSION=2.58.8
ARG DBUS_X11_VERSION=1.14.10-4ubuntu4.1
ARG MATCHBOX_VERSION=1.2.2+git20200512-1build1
ARG PYTHON_DASBUS_VERSION=1.7-2
ARG SPEECH_DISPATCHER_VERSION=0.12.0~rc2-2build3
ARG XDOTOOL_VERSION=1:3.20160805.1-5build1
ARG XVFB_VERSION=2:21.1.12-1ubuntu1.6
ARG TINI_VERSION=0.19.0-1

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      at-spi2-core \
      ca-certificates \
      dbus-x11="${DBUS_X11_VERSION}" \
      fonts-freefont-ttf \
      fonts-ipafont-gothic \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-tlwg-loma-otf \
      fonts-unifont \
      fonts-wqy-zenhei \
      gir1.2-gtk-3.0 \
      libasound2t64 \
      libatk-bridge2.0-0t64 \
      libatk1.0-0t64 \
      libatspi2.0-0t64 \
      libcairo2 \
      libcups2t64 \
      libdbus-1-3 \
      libdrm2 \
      libfontconfig1 \
      libfreetype6 \
      libgbm1 \
      libglib2.0-0t64 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      matchbox-window-manager="${MATCHBOX_VERSION}" \
      python3 \
      python3-dasbus="${PYTHON_DASBUS_VERSION}" \
      python3-gi \
      python3-speechd="${SPEECH_DISPATCHER_VERSION}" \
      speech-dispatcher="${SPEECH_DISPATCHER_VERSION}" \
      tini="${TINI_VERSION}" \
      xdotool="${XDOTOOL_VERSION}" \
      xvfb="${XVFB_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

COPY --from=playwright-browser /ms-playwright/chromium-1234/ /ms-playwright/chromium-1234/
COPY --from=builder /usr/local/ /usr/local/
COPY --from=builder /tmp/build/at-spi.tar.gz /usr/src/hoosaidthat-third-party/at-spi.tar.gz
COPY --from=builder /tmp/build/orca.tar.gz /usr/src/hoosaidthat-third-party/orca.tar.gz
COPY --from=builder /tmp/build/at-spi/COPYING /usr/share/doc/at-spi2-core-upstream/COPYING
COPY --from=builder /tmp/build/orca/COPYING /usr/share/doc/orca/COPYING
COPY LICENSE /usr/share/doc/hoosaidthat/LICENSE

RUN ldconfig \
 && groupadd --gid 1001 pwuser \
 && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash pwuser \
 && install -d -o pwuser -g pwuser /opt/hoosaidthat /tmp/hoosaidthat \
 && PYTHONPATH=/usr/local/lib/python3/dist-packages:/usr/local/lib/python3.12/dist-packages \
      GI_TYPELIB_PATH=/usr/local/lib/x86_64-linux-gnu/girepository-1.0 \
      LD_LIBRARY_PATH=/usr/local/lib/x86_64-linux-gnu \
      python3 -c 'import gi; gi.require_version("Atspi", "2.0"); from gi.repository import Atspi; import dasbus, orca; assert Atspi.get_version() == (2, 58, 8); assert Atspi.Accessible.__hash__.__module__ == "gi.overrides.Atspi"'

COPY --chown=pwuser:pwuser images/orca/entrypoint.sh /opt/hoosaidthat/entrypoint.sh
COPY --chown=pwuser:pwuser images/orca/control_server.py /opt/hoosaidthat/control_server.py
COPY --chown=pwuser:pwuser images/orca/sd_capture.py /opt/hoosaidthat/sd_capture.py
COPY --chown=pwuser:pwuser images/orca/runtime-contract.json /opt/hoosaidthat/runtime-contract.json
COPY --chown=pwuser:pwuser images/orca/bootstrap.html /opt/hoosaidthat/bootstrap.html

RUN chmod 0755 \
      /opt/hoosaidthat/entrypoint.sh \
      /opt/hoosaidthat/control_server.py \
      /opt/hoosaidthat/sd_capture.py

ARG IMAGE_VERSION=dev

LABEL org.opencontainers.image.title="HooSaidThat Orca runtime" \
      org.opencontainers.image.description="Upstream GNOME Orca and Chromium runtime for @openhoo/hoosaidthat" \
      org.opencontainers.image.source="https://github.com/openhoo/hoosaidthat" \
      org.opencontainers.image.licenses="MIT AND LGPL-2.1-or-later" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      dev.hoosaidthat.protocol="1" \
      dev.hoosaidthat.screenreader="orca" \
      dev.hoosaidthat.platform="linux/amd64" \
      dev.hoosaidthat.windows="absent" \
      dev.hoosaidthat.fork="absent" \
      dev.hoosaidthat.capture="speech-dispatcher-output-module" \
      dev.hoosaidthat.orca-source="https://github.com/GNOME/orca" \
      dev.hoosaidthat.orca-commit="${ORCA_COMMIT}" \
      dev.hoosaidthat.corresponding-source="/usr/src/hoosaidthat-third-party" \
      dev.hoosaidthat.at-spi-version="${AT_SPI_VERSION}" \
      dev.hoosaidthat.speech-dispatcher-version="${SPEECH_DISPATCHER_VERSION}"

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC \
    GI_TYPELIB_PATH=/usr/local/lib/x86_64-linux-gnu/girepository-1.0 \
    LD_LIBRARY_PATH=/usr/local/lib/x86_64-linux-gnu \
    PYTHONPATH=/usr/local/lib/python3/dist-packages:/usr/local/lib/python3.12/dist-packages \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HST_CONTROL_PORT=3000 \
    HST_CDP_PORT=9222 \
    HST_DISPLAY_NUMBER=99 \
    HST_VIEWPORT_WIDTH=1280 \
    HST_VIEWPORT_HEIGHT=720 \
    HST_START_URL=file:///opt/hoosaidthat/bootstrap.html

USER pwuser
WORKDIR /tmp/hoosaidthat

EXPOSE 3000 9222
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=2s --start-period=20s --retries=3 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ['HST_CONTROL_PORT']+'/healthz', timeout=1).read()" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/hoosaidthat/entrypoint.sh"]
