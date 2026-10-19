# No npm dependencies, so there is no install step — the build is file copies
# plus ffmpeg.
#
# Debian rather than Alpine, because the ffmpeg that matters here is
# Jellyfin's build: it adds GPU tone mapping (HDR → SDR) and GPU subtitle
# overlays that stock ffmpeg lacks, and ships the Intel media drivers. It is
# a glibc build, so it won't run on Alpine.
#
#   FFMPEG=jellyfin   Jellyfin's ffmpeg (default; amd64 and arm64)
#   FFMPEG=debian     Debian's ffmpeg: smaller, no GPU tone mapping
#   FFMPEG=none       no ffmpeg at all; streams the browser can't play go to VLC
#
# DejaVu is the font burned-in text subtitles are drawn in (ASS files bring
# their own from the MKV's attachments).
FROM node:20-bookworm-slim

ARG FFMPEG=jellyfin
ARG JELLYFIN_FFMPEG=jellyfin-ffmpeg7
RUN set -eux; \
    if [ "$FFMPEG" = "jellyfin" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
      mkdir -p /etc/apt/keyrings; \
      curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg; \
      echo "deb [signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main" \
        > /etc/apt/sources.list.d/jellyfin.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends "$JELLYFIN_FFMPEG" mesa-va-drivers fonts-dejavu-core fontconfig; \
      ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg; \
      ln -s /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe; \
      apt-get purge -y gnupg curl; apt-get autoremove -y; \
    elif [ "$FFMPEG" = "debian" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends ffmpeg mesa-va-drivers fonts-dejavu-core fontconfig; \
    fi; \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

# The node user needs the GPU render node's group to use VAAPI/QSV. The
# compose file adds it with group_add; nothing to do here.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
