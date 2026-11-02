# Linux dev/test image for the native shell: Qt 6.8 + WebEngine + libmpv,
# plus a headless Weston so the app can run on a real Wayland compositor.
FROM debian:trixie
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build pkg-config \
      qt6-base-dev qt6-declarative-dev qt6-webengine-dev qt6-webchannel-dev \
      qml6-module-qtquick qml6-module-qtquick-window qml6-module-qtwebengine \
      qml6-module-qtwebchannel qml6-module-qtqml-workerscript qt6-wayland \
      libmpv-dev libgl-dev libegl-dev \
      weston mesa-utils libgl1-mesa-dri libegl-mesa0 \
      nodejs npm ca-certificates fonts-noto-core dbus \
    && rm -rf /var/lib/apt/lists/*
