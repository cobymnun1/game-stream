# BaseHack game-stream container
# Combines: LinuxServer SteamOS KasmVNC web desktop (browser, no install)
#           + Sunshine (Moonlight streaming) capturing the same X display.
# Result: ONE container where users can play either via a browser URL (3000/3001)
# or via Moonlight/our IWA (47984-48010). Steam is included by the base image.
#
# Built in CI (.github/workflows/build-container.yml) → ghcr.io — no local Docker needed.

# Pinned to a dated tag: the :latest manifest has no usable linux/amd64 entry,
# which breaks buildx ("no match for platform"). Dated tags publish proper amd64.
FROM lscr.io/linuxserver/steamos:2025-07-12-ls96

# --- Install Sunshine (LizardByte) ---
ARG SUNSHINE_VERSION=latest
RUN set -e; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates jq; \
    # resolve the latest Sunshine .deb for Ubuntu 24.04 (noble) from GitHub releases
    ASSET_URL="$(curl -sL https://api.github.com/repos/LizardByte/Sunshine/releases/latest \
      | jq -r '.assets[] | select(.name | test("ubuntu-24.04-amd64.deb$")) | .browser_download_url' | head -n1)"; \
    echo "Sunshine deb: $ASSET_URL"; \
    curl -L -o /tmp/sunshine.deb "$ASSET_URL"; \
    apt-get install -y --no-install-recommends /tmp/sunshine.deb || (apt-get -y -f install && apt-get install -y /tmp/sunshine.deb); \
    rm -f /tmp/sunshine.deb; \
    apt-get clean; rm -rf /var/lib/apt/lists/*

# --- Sunshine default config (origin allowed over WAN for Akash, x11 capture) ---
RUN mkdir -p /config/sunshine
COPY infra/docker/root/ /

# Sunshine ports (web desktop 3000/3001 already exposed by base)
EXPOSE 47984/tcp 47989/tcp 47990/tcp 48010/tcp \
       47998/udp 47999/udp 48000/udp 48002/udp
