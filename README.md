# Nuvio Bridge

A small self-hosted web app that signs into your Nuvio account and plays your
streams on whatever you are holding — iPhone, iPad, Android, Windows, macOS or
Linux.

It started as a way around Nuvio having no App Store build: the iOS client must
be compiled from source, which means a Mac, Xcode, and re-signing every seven
days on a free developer account. This container runs on a server you already
have, reads the addons, library and collections already on your Nuvio account,
and hands the stream you pick to a player. Nothing to sideload, nothing to
re-sign. Install it from the browser on any device.

On phones and tablets it is a **hand-off tool**: it finds the stream and passes
it to VLC, which does the playing. On a desktop, where no browser will follow a
link into VLC, it can also play in the page itself.

---

## Requirements

- Docker and Docker Compose (or Node.js 20+ to run it directly)
- An existing Nuvio account with addons installed
- VLC on any phone or tablet you want to watch on — it is the only thing that
  plays MKV, which most releases are
- At least one addon that returns direct HTTP links — see
  [Limitations](#limitations)

---

## Quick start

```bash
cp .env.example .env          # set PUBLIC_URL to the address your phone uses
docker compose up -d --build
```

Or skip the build and use the prebuilt image (amd64 and arm64, Jellyfin's
ffmpeg), published to GitHub Container Registry on every push to `main`:

```bash
docker compose pull && docker compose up -d
```

The image is `ghcr.io/kohnorw/nuvio-bridge:latest`. While the repository is
private, run `docker login ghcr.io` on the server first, with a GitHub token
that has `read:packages`.

Then on any device:

1. Open `http://<your-server>:8080`
2. Sign in with your Nuvio email and password
3. Pick a profile
4. Install it:
   - **iOS / iPadOS** — Share → Add to Home Screen
   - **Android / Chrome / Edge** — the install prompt, or ⋮ → Install app
   - **Desktop** — the install icon in the address bar

`PUBLIC_URL` must be the address your *devices* reach, not `localhost`. VLC for
iOS uses it to bounce back when playback ends, so a wrong value means playback
works but the return trip doesn't.

---

## Live TV

**Live TV** in the sidebar is the guide from NuvioPlusIPTV: the info panel
and preview at the top, the group list (Favorites, Recently watched, All
channels and each provider category, with counts), and a two-hour grid with
the now line.

Add a provider under **Settings → Live TV**: an Xtream Codes login (server,
username, password — its guide comes with it), an M3U playlist, or extra
XMLTV guides. Everything is stored on the server per Nuvio account and
encrypted, so every device you sign in on sees the same channels,
favourites and settings. Playlists and guides refresh on the server every
3 hours (`IPTV_REFRESH_HOURS`).

- **OK / click** on a channel previews it; again goes full screen.
- **Catch-up**: on a channel with an archive, a show that has aired plays
  from the archive (Xtream `/timeshift/` in the server's time zone, HLS
  first then TS, with the same fallbacks as the app). *Watch from start*
  restarts the show on now.
- Keys: arrows move, Left at "now" opens the groups, `M` the channel menu,
  `I` show info, `F` favourite, `G` groups, `/` search. Right-click or
  long-press opens the menu on touch.

## Players, per platform

There is no one mechanism that works everywhere, so the app picks per device
and you can override it in **Settings → Play with**. The choice is stored on
the device, not the account, because the right answer on a phone is the wrong
one on a desktop.

**The built-in player is the default on every device** — iPhone, iPad,
Android, Windows, macOS and Linux. It is one full-screen player with its own
controls: seek bar, skip, volume, fullscreen, picture-in-picture, and menus for
the audio track, subtitles and episodes. Lumen, the converter on the server,
makes any file playable in it.

VLC is opt-in. Choose **VLC** (or another app on Android) under
**Settings → Play with** and it becomes that device's default. The built-in
player also offers VLC on its fallback screen when a file can't be played.

What choosing **VLC** does on each platform:

| Platform | What `VLC` does | Why |
| --- | --- | --- |
| iOS / iPadOS | `vlc-x-callback://` into VLC | The only scheme Safari will follow, and the only way to play MKV on iOS. VLC returns to the app when it finishes. |
| Android (Chrome, Edge, Samsung) | `intent://` into VLC | The documented way to reach an Android app from a page. If VLC isn't installed, Chrome follows `browser_fallback_url` back here instead of dying silently. |
| Android (Firefox and friends) | `.m3u` download | Non-Chromium browsers ignore `intent://` completely — the tap does nothing at all. VLC registers itself for `.m3u`, so the file reaches it anyway. |
| Windows, macOS, Linux, ChromeOS | The player in the page | Nothing on a desktop registers a URL scheme VLC answers. |

The sidebar collapses to icons with the button beside the wordmark, and stays
that way on that device until you expand it again.

Every platform also offers the others. On Android there is **Ask which app**,
which lets Android show MX Player, Just Player, Kodi or whatever else is
installed. Everywhere there is **This browser**, and on desktop a **VLC (.m3u
file)** option — set VLC as the default app for `.m3u` once and a double-click
opens the stream.

If a hand-off silently does nothing — which is what a missing player looks like
from inside a web page — a bar appears offering the alternatives for that
device rather than leaving you at a dead tap.

### The stream list is filtered for the browser

Playing in the page means most results are useless as they stand: an MKV
container or an AC3 track is something no browser will touch. Rather than
listing twenty options and letting you discover that one at a time, the picker
shows the ones that will play and puts the rest behind **Show everything**.

The verdict comes from the release name, which nearly always carries the
container and the video codec — `.mp4` with `x264` is a yes, anything naming
`x265`, `HEVC`, `DTS`, `AC3` or `.mkv` is a no, and a name that says neither is
a maybe. The bar for showing something is deliberately high, because promising
a file will play and having it fail is worse than an extra press.

It is a guess, not a fact — nothing has opened the file. So the rest are never
actually unavailable, and with ffmpeg in the build they play too, by way of a
conversion. Rows that need one say so.

This only applies to the browser player. VLC plays everything, so filtering for
it would be hiding results for no reason.

### Restreaming, before conversion

A file that is already an MP4 of H.264 and AAC is something every browser
plays as it stands. Converting it would burn CPU and disk to produce what it
already was. All it actually needs is to arrive from an origin the browser
accepts — so it is **restreamed**: fetched by the server and passed straight
through, with range requests forwarded verbatim in both directions.

That last part is the point. The browser seeks a restreamed file natively,
instantly, anywhere in it — including parts nothing has read yet. A converted
file can only seek within what ffmpeg has produced so far, and going beyond
means restarting it somewhere else.

Restreaming also fixes three things that have nothing to do with codecs:

| | |
| --- | --- |
| Mixed content | The page is on HTTPS and the addon returned an HTTP link. Every browser blocks that. |
| Hotlinking | Some hosts check `Referer` or `Origin` and refuse anything not from their own page. |
| Expiry | A debrid link can be tied to the IP that resolved it — the server, not the person watching. |

The cost is that every byte crosses the container, but those are the same bytes
ffmpeg would have read anyway, minus the conversion. `MEDIA_PROXY=false` turns
it off and sends everything through ffmpeg instead.

Two things send a file the long way even when it looks playable. **MKV**, which
Chrome will play and Safari will not — the container has to be one every
browser reads, not one some browser tolerates. And **more than one audio
track**, since choosing between them means ffmpeg mapping the one you picked.

### When conversion is needed

Everything that isn't restreamed is converted — there is no third path where
the browser is handed a file and left to cope. That matters because **there is
no reliable signal to react to** if it can't:

An MKV with AC3 audio plays perfectly well in Chrome with no sound at all and
raises no error — the video decodes, the duration is right, and the audio track
is silently ignored. A file extension tells you nothing about what is inside.
Every browser draws the line somewhere different. Reacting to failure meant
waiting for one that never came; guessing in advance produced a different wrong
answer per browser.

So the decision is made from what ffprobe found inside the file, before
playback starts, rather than from a failure that may never arrive. For the
usual release — H.264 video with AC3 audio — converting is a rewrap:

| Inside the file | What happens | Cost |
| --- | --- | --- |
| H.264 video | Copied through untouched, just rewrapped | Nearly free |
| HEVC, AV1, VP9 | Re-encoded to H.264 | Heavy — a slow box may not keep up |
| AC3, E-AC3, DTS, TrueHD | Re-encoded to AAC stereo | Cheap |

It also solves two problems that used to need their own machinery: the server
fetches the stream, so a plain-HTTP link on an HTTPS page is no longer blocked,
and a host that refuses cross-origin requests no longer matters.

A build without ffmpeg falls back to handing the browser the raw file — MP4
plays, MKV mostly doesn't.

Most releases are H.264 video with AC3 audio, so the common case is a remux
that barely touches the CPU.

### Lumen, the converter

Conversion is done by **Lumen** (`src/transcode.js`). Output is HLS: numbered
MPEG-TS segments the browser fetches like any other files. Safari plays HLS
natively; other browsers get hls.js, loaded only when conversion is used.

**The whole film is seekable from the start.** The playlist is a complete VOD
playlist listing every segment of the film, with its length, before any of
them exist. The player knows the real duration, the scrubber covers the whole
film, and a seek lands wherever you point it. When the player asks for a
segment that hasn't been made, ffmpeg is restarted exactly there — so jumping
to 1:30:00 costs one segment's worth of work, not an hour and a half. This
needs the stream host to support range requests; debrid providers do.

**It converts ahead, then stops.** Rather than throttling ffmpeg's read rate,
Lumen converts flat out until it is `TRANSCODE_AHEAD_SECS` (90 s) ahead of the
viewer, then freezes the process (`SIGSTOP`) and thaws it (`SIGCONT`) as soon
as the viewer catches up. A paused film costs no CPU, no GPU and no disk; a
playing one always has a full buffer. Segments more than two minutes behind
the playhead are deleted as you watch.

**It picks the cheapest path per file:**

| Inside the file | What happens | Cost |
| --- | --- | --- |
| H.264 (8-bit) video | Copied untouched, rewrapped | Nearly free |
| HEVC, AV1, VP9, 10-bit H.264 | Re-encoded to H.264, on the GPU if there is one | Heavy on a CPU, light on a GPU |
| 4K | Scaled to `TRANSCODE_MAX_HEIGHT` (1080p) while re-encoding | Included above |
| HDR10 / HLG | Tone mapped to SDR, on the GPU where the build supports it | Included above |
| AC3, E-AC3, DTS, TrueHD | Re-encoded to AAC stereo | Cheap |
| PGS / VobSub subtitles, if chosen | Burned into the picture | Forces a re-encode |

**On a GPU the frames never touch the CPU.** With NVIDIA, decoding, scaling,
tone mapping and subtitle burn-in all run on the card (`scale_cuda`,
`tonemap_cuda`, `overlay_cuda`). With Intel/AMD, decode, scaling and tone
mapping run on the GPU (`scale_vaapi`, `tonemap_vaapi`); burned-in subtitles
are drawn on the CPU and uploaded.

**Failures fall back, never dead-end.** If the GPU can't take a particular
file — a GTX 10-series can't decode AV1, no NVIDIA card decodes 10-bit H.264
— that session restarts on the CPU. If the GPU has actually gone away, every
later session uses the CPU too. If ffmpeg can't produce anything at all,
starting fails, and the player falls back to VLC.

Other details that matter:

- **Probing once.** ffprobe reads part of a remote file before answering,
  which on a debrid link is seconds. It's cached per URL, so seeks and track
  switches don't pay it again.
- **Drift.** Copying video while re-encoding audio lets their clocks separate
  over a long film. `aresample=async=1` holds them together.
- **Keyframes.** Re-encodes put a keyframe at every segment boundary, so every
  segment starts cleanly and Safari accepts them. With `-c copy`, ffmpeg can
  only cut where the source has keyframes. Blu-ray remuxes have them every
  second or so and seek precisely; some web releases space them ten seconds
  apart, where a seek can land a few seconds early.

### Audio tracks and subtitles

Every audio track in the file is listed in the player. Switching restarts the
stream at the same position with the new track mapped.

The subtitle menu combines two sources:

- **Subtitles from your addons**, converted from SRT to WebVTT on the way
  through, as before.
- **Subtitles inside the file.** Text ones (SRT, ASS, MP4 text, WebVTT) are
  extracted to WebVTT once and cached, then drawn by the browser — switching
  between them never touches the video. MKV spreads subtitles through the
  whole file, so the first extraction reads all of it: seconds on a fast link,
  longer on a slow one. Image ones (Blu-ray PGS, DVD VobSub) can't be drawn by
  any browser, so choosing one restarts the stream with it burned into the
  picture.

| Variable | Default | What it does |
| --- | --- | --- |
| `TRANSCODE` | `true` | `false` refuses to convert even with ffmpeg installed. |
| `TRANSCODE_MAX` | `3` | How many conversions may run at once. When all are in use, new ones fall back to VLC. |
| `TRANSCODE_PRESET` | by core count | x264 preset, for re-encodes only. Unset picks from the core count. |
| `TRANSCODE_MAX_HEIGHT` | `1080` | Encode height ceiling. The biggest lever on speed. 0 encodes at source height. |
| `TRANSCODE_SEGMENT_SECS` | `2` | Segment length. Shorter starts faster and costs more requests. |
| `TRANSCODE_MAX_KBPS` | `20000` | Bitrate ceiling for conversions at Original quality. Lower levels (1080p 8 Mbps, 720p 4, 480p 1.5, 360p 0.7) have their own. |
| `SUBSYNC_WINDOWS` | `8` | Subtitle sync: how many stretches of the soundtrack are listened to. More is surer and reads more of the film. |
| `SUBSYNC_WINDOW_SECS` | `45` | Subtitle sync: length of each stretch, in seconds. |
| `SUBSYNC_MAX_OFFSET` | `90` | Subtitle sync: the largest timing correction it will look for, in seconds. |
| `TRANSCODE_REMUX_SEGMENT_SECS` | `4` | Shortest segment for a remux of an MKV, which is cut at the file's own keyframes. Fewer, larger requests keep iPhones buffered over the internet. |
| `TRANSCODE_AHEAD_SECS` | `90` | How far ahead of the viewer to convert before pausing ffmpeg. Raise it if a slow source causes buffering. |
| `TRANSCODE_CRF` | `23` | Quality for re-encodes (CRF/CQ/QP depending on the encoder). Lower is better and bigger. |
| `TRANSCODE_DIR` | `STATE_DIR/hls` | Where segments are written. Point it at a disk with room. |

The image uses **Jellyfin's ffmpeg build** by default, because it has the GPU
tone-mapping and subtitle-overlay filters that stock ffmpeg lacks. The `FFMPEG`
build argument chooses:

```bash
docker compose build                          # jellyfin (default)
docker compose build --build-arg FFMPEG=debian  # smaller; no GPU tone mapping
docker compose build --build-arg FFMPEG=none    # no conversion; VLC for anything the browser can't play
```

Lumen checks at startup which filters the installed ffmpeg has and only uses
those, so every flavour works — just with fewer tricks on the smaller ones.
Jellyfin renames its package with major versions; if the build can't find
`jellyfin-ffmpeg7`, pass the current name with
`--build-arg JELLYFIN_FFMPEG=jellyfin-ffmpeg8`.

### Encoding speed

Four things make the re-encode path faster, in the order they matter:

**Downscaling.** An encoder is paid by the pixel, so a 2160p source encoded at
2160p costs four times a 1080p one. `TRANSCODE_MAX_HEIGHT` caps the output at
1080p by default. Measured on a 4K HEVC source: **2.0× faster** from this
alone, 2.5× with the preset below. Set it to 0 to encode at source height.

**A preset chosen for the machine.** Left unset, `TRANSCODE_PRESET` is picked
from the core count — `ultrafast` on one or two cores, `superfast` on four,
`veryfast` up to eight, `faster` beyond. A fixed guess is either too slow to
keep up on a small box or leaving quality on the table on a large one.

**Audio passthrough.** A track that is already AAC stereo is copied rather than
re-encoded into the thing it already is. Multichannel AAC is still downmixed,
because browsers that decode 5.1 often route it to the wrong speakers.

**Hardware encoding**, below — though note it only applies when something is
actually being encoded.

One thing measured and *not* changed: swapping the scaler to `fast_bilinear`
made no difference at all. The cost is decode and encode, not scaling.

If a slow box still can't keep up, the real answer isn't a faster encoder —
it's not encoding. Set a quality preference that picks a 1080p H.264 release
over a 4K HEVC one, and the video is copied instead.

### Hardware acceleration

Detection works the way a media server's has to: **by trying it.** This
container's ffmpeg reports `h264_nvenc`, `h264_qsv` and `h264_vaapi` in
`-encoders`, and not one of them works, because there is no `/dev/dri` and no
NVIDIA driver. The encoders are compiled in; the hardware is absent. Trusting
that list would mean picking NVENC on a machine with no GPU and failing every
playback.

So each candidate gets a real one-frame encode at startup, in order of
preference — NVENC, Quick Sync, VAAPI, VideoToolbox, AMF, V4L2 — and the first
that succeeds is used. It costs about 150 ms once. The choice is logged at boot
and reported at `/healthz`.

If a GPU fails mid-film (driver reset, device busy, a stream it can't handle),
that costs one restart on the CPU rather than every playback from then on.

| Variable | Default | What it does |
| --- | --- | --- |
| `TRANSCODE_HWACCEL` | `auto` | `none` forces the CPU, or name one: `nvenc`, `qsv`, `vaapi`, `videotoolbox`, `amf`, `v4l2m2m`. |
| `TRANSCODE_NVENC_PRESET` | `p2` | NVIDIA speed/quality, `p1` (fastest) to `p7` (best). |

The container needs access to the hardware, which is two things: the device
passed in (see the commented `deploy:` and `devices:` blocks at the bottom of
`docker-compose.yml`) and the matching driver on the host.

**NVIDIA** (e.g. a GTX 1080): install the driver and the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
on the host, run `sudo nvidia-ctk runtime configure --runtime=docker && sudo
systemctl restart docker`, check `docker run --rm --gpus all ubuntu nvidia-smi`
shows the card, then uncomment the `deploy:` block. The image already sets
`NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`; without `video` the card is
visible but its encoder isn't. A GTX 1080 handles several 4K HDR → 1080p
conversions at once, with tone mapping and burn-in on the card. It can't
decode AV1 (those go to the CPU).

**Intel / AMD**: uncomment `devices:` and `group_add:`, setting the group to
the render node's group on the host (`stat -c %g /dev/dri/renderD128`), since
the container runs as an unprivileged user.

**This matters less than it sounds.** A release that is already H.264 has its
video copied, and copying is free whatever silicon is present. Hardware
encoding is for HEVC, AV1 and 4K — the files that pin a CPU at 100% and still
stutter. If your library is mostly x264, the GPU will sit idle, and that is the
correct outcome.

This is modelled on how Plex and Jellyfin approach transcoding — detect, prefer
the GPU, fall back to the CPU — but it is not Plex's transcoder, which is a
proprietary fork of ffmpeg with its own decoders and can't be reproduced.

### The player in the page

A `<video>` element, with its own controls, so fullscreen, Picture-in-Picture,
AirPlay on Safari and Cast on Chrome all work without anything being
reimplemented. It carries the same queue VLC would get, so binge works there
too, and subtitles from your addons are converted to WebVTT on the way through
because `<track>` will not read SubRip.

When a file defeats it the page says which of the two reasons it was — a codec
it can't decode, or a plain-HTTP stream blocked on an HTTPS page — and offers
the alternatives, including converting it (below).

**Audio tracks.** Dual-audio releases are common and a browser gives no way to
choose between them — only Safari implements `audioTracks` at all. So while
converting, the picker lists every track ffprobe found, labelled with its
language, title and channel layout, and choosing one tells ffmpeg to map it
instead. Switching carries on from where you were rather than restarting.
Playing directly, the picker appears only where the browser actually exposes
the tracks, rather than showing a menu that does nothing.

Keyboard: space or `k` to play and pause, `j`/`l` or the arrow keys to seek
(hold shift for 30 seconds), `f` fullscreen, `m` mute, `n`/`p` for the next and
previous episode, escape to leave.

The image has **no dependencies**, so the build is a few file copies and
nothing else — no `npm install`, no lock file to drift, no registry to be
unreachable. Expect 10–20 seconds once `node:20-alpine` is local, and a couple
of seconds for a rebuild after a code change.

### Without Docker

```bash
PUBLIC_URL=http://192.168.1.50:8080 STATE_DIR=./data npm start
```

Nothing to install first. `npm install` is only needed to run the linter.

`npm run dev` restarts on file changes. `npm run lint` runs ESLint.

---

### Desktop VLC (Windows, macOS, Linux)

On desktops, VLC is opened with a **`vlc://` link that carries the stream**:

    vlc://https://host/path/to/file.mkv

Desktop VLC doesn't handle `vlc://` links itself, so Nuvio ships a small
one-time **VLC launcher** that registers them (and `nuvio-vlc:`). Open
**/vlc-setup** on the computer you watch on:

- **Windows:** download and run `nuvio-vlc-windows.cmd`. It installs per user
  (HKCU, no admin).
- **macOS:** `curl -fsSL <PUBLIC_URL>/vlc-launcher/macos | sh` adds a hidden
  app to `~/Applications` and makes it the `vlc://` handler.
- **Linux:** `curl -fsSL <PUBLIC_URL>/vlc-launcher/linux | sh` adds a handler
  in `~/.local` (works with VLC as a package, Flatpak or Snap).

A file the browser can't play (MKV, HEVC, AC-3, DTS…) opens its `vlc://`
stream link in VLC instead of being converted by ffmpeg. The watch page also
offers **Copy VLC link**, **Open the whole queue in VLC** (the playlist URL
as a `vlc://` link), **Convert and play here**, and the `.m3u` download.
Files the browser can play keep playing in the page. The desktop **VLC**
player setting sends everything to a `vlc://` link.

**What the launcher accepts:** `vlc://` links pass only plain `http`/`https`
URLs to VLC, limited to characters that can't be read as a shell command,
PowerShell code or a VLC option. Links are percent-encoded to fit before
they're made. `nuvio-vlc:` links only accept this server's playlists. A
`vlc://` link skips the `.m3u`, so the audio-language and subtitle options it
would carry don't apply; the queue link keeps them. To remove the launcher,
use the remover on /vlc-setup, or add `?remove=1` to the installer URL.

## Configuration

All configuration is environment variables. Only `PUBLIC_URL` really needs
setting.

### Core

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_URL` | — | The address phones use to reach the container. VLC returns here after playback. |
| `PORT` | `8080` | Listen port. |
| `STATE_DIR` | `/data` | Where encrypted session and playlist records are written. |
| `SESSION_SECRET` | generated | AES-256-GCM key for stored tokens. Generate with `openssl rand -hex 32`. If unset, one is written into the data volume on first boot — set it explicitly if you want sessions to survive the volume being recreated. |
| `SESSION_IDLE_DAYS` | `60` | Idle device records are dropped after this. |
| `ALLOW_SIGNUP` | `false` | `true` offers account creation on the sign-in screen. |
| `MEDIA_PROXY` | `false` | `true` lets the in-page player route a blocked stream through the server. Fixes plain-HTTP streams on an HTTPS page and hosts that refuse hotlinks, at the cost of every byte of video crossing this container. Nothing uses it unless direct playback has already failed. |

### Backend

Nuvio's publishable key is built into `src/nuvio.js`, exactly as it is in the
official clients, so **none of these need setting** for the hosted backend.

| Variable | Default | What it does |
| --- | --- | --- |
| `NUVIO_BACKEND_URL` | `https://api.nuvio.tv` | Backend origin. |
| `NUVIO_ANON_KEY` | built in | Only to override the key for a different backend. |
| `NUVIO_SERVER` | — | Hostname of a self-hosted Nuvio server. The container reads the backend URL and key from `/.well-known/nuvio` at startup. |

### Playback and binge

| Variable | Default | What it does |
| --- | --- | --- |
| `BINGE_EPISODE_LIMIT` | `60` | Max episodes queued into a binge playlist. |
| `PLAYLIST_TTL_HOURS` | `24` | How long a playlist URL stays valid. |
| `STREAM_PROBE` | `head` | `head`, `off`, or `full`. See below. |
| `STREAM_PROBE_LIMIT` | `3` | Candidates checked per episode. |
| `STREAM_PROBE_TIMEOUT_MS` | `6000` | Per-probe timeout. |

> **Don't use `STREAM_PROBE=full` with debrid providers that issue single-use
> links.** `full` adds a one-byte range GET when HEAD is refused, and that
> request can consume the link before VLC ever plays it.

### Tuning

| Variable | Default | What it does |
| --- | --- | --- |
| `HOME_ROW_LIMIT` | `10` | Catalog rows fetched for the home screen. |
| `HTTP_TIMEOUT_MS` | `15000` | Timeout for addon and backend calls. |
| `CACHE_TTL_MS` | `300000` | Addon manifest cache lifetime. |

---

## How it works

### Sign-in and sessions


**Keep me signed in** at the login screen decides whether the cookie survives
the browser closing. Checked (the default) it lasts a year; unchecked there is
no expiry set at all, so closing the window ends the session — which is what a
borrowed machine wants.

Sessions are per device, so signing in on a phone, a laptop and a desktop gives
three independent ones. None disturbs the others and signing out of one leaves
the rest alone. A device that goes unused for `SESSION_IDLE_DAYS` (60 by
default) is pruned; the account itself outlives them.

Passwords are handed to the **browser's own password manager** rather than
stored here. A form submitted over fetch never navigates, and without a
navigation Chrome often doesn't notice a sign-in happened, so it is told
outright via the Credential Management API and fills the form back in on a
later visit. Nothing is submitted automatically — the fields are filled and you
press the button.

Two reasons you might see no save prompt: the API needs a **secure context**,
so over plain `http://` on a LAN address the browser disables password saving
entirely (its rule, not ours — the fix is HTTPS); and Firefox and Safari don't
implement it, falling back to their own heuristics, which the form's
`autocomplete` attributes are written for.

Nuvio's backend is Supabase. Sign-in goes through GoTrue
(`POST /auth/v1/token?grant_type=password`); addons come from a Postgres table;
library, collections and home-row settings come from RPCs like
`sync_pull_library`.

The store separates two things:

- **Devices** — one per signed-in browser, holding that browser's Supabase
  tokens, addressed by an opaque cookie id. A phone, a laptop and an iPad are
  three devices on one account, all valid at once; refreshing one doesn't
  disturb the others.
- **Accounts** — one per Nuvio user, holding what should follow you around:
  profile selection, theme, playback preferences.

Sign-out is scoped `?scope=local` and ends that device only.
`POST /api/logout` with `{"everywhere": true}` ends all of them.

Records are encrypted at rest with AES-256-GCM in `STATE_DIR`. Access tokens
refresh a minute before expiry and no token is ever sent to the browser. Failed
sign-ins are rate limited to ten per IP per fifteen minutes.

### Playback preferences

The gear icon on any title opens a Playback sheet, stored per user:

- **Auto-play best stream** — Play hands the top-ranked playable result
  straight to VLC instead of opening the picker.
- **Binge next episode** — VLC gets the whole season as an M3U playlist, so it
  has a real queue with working next/previous.
- **Preferred quality** — Any, 4K, 1080p or 720p. Falls back to the top-ranked
  stream when nothing matches.
- **Audio / Subtitle language** — floats matching release names up the list
  (a hint, never a filter), emits `#EXTVLCOPT:audio-language` /
  `sub-language` in ISO 639-2/B, and attaches a matching subtitle file with
  `input-slave` if a subtitle addon is installed.

Setting a language preference routes even a single movie through a one-entry
playlist, since `vlc-x-callback` has no parameters for track languages and the
M3U is the only channel that carries `#EXTVLCOPT`.

### Binge playlists

Starting an episode with binge on creates a record and hands VLC
`/playlist/<token>.m3u`. VLC fetches it and pages through the season itself —
no round trip out to Safari between episodes.

The playlist is the **whole season**, not just what's ahead: your episode
leads, the rest of the season follows, earlier episodes are appended at the
end. VLC always starts an M3U at track one and has no start-index parameter,
so leading with your episode is the only way to start where you asked; keeping
the earlier ones on the end means you can still reach them from VLC's playlist
view.

Streams are resolved when VLC fetches the playlist, not when it's created, so
nothing is spent on episodes never watched. Each candidate gets a HEAD check
and only a *definite* refusal moves on — 403, 405 and 501 mean the method was
refused, and a timeout means the check failed, not the link. If every candidate
looks dead the best one goes in anyway, since a doubtful link beats a missing
episode.

Records expire after `PLAYLIST_TTL_HOURS` and are encrypted at rest, because
resolved debrid URLs are worth protecting.

### What is not tracked

Playing something writes nothing to your account — no Continue Watching entry,
nothing marked watched, no progress touched on other devices. VLC's x-callback
interface takes a URL and returns control; that's the whole contract, so
anything written would be a guess.

The one exception is explicit: **Add to Library** on a title's page, which
calls `sync_push_library_items`. It saves the show, not the episode, and shows
up in the native app like any other library entry.

---

### Per-device playback (like Plex's Direct Play / Direct Stream)

Every play request carries what the device decodes — HEVC (8- and 10-bit),
AV1, HDR, AC-3 / E-AC-3, FLAC, Opus and its speaker count — read from
MediaSource (hls.js) or Safari's own player. The server reads the file against
that and does the least work that device needs:

| File                     | iPhone / iPad / Mac / Apple TV | Chrome / Edge with HEVC | Firefox, older devices |
|--------------------------|--------------------------------|-------------------------|------------------------|
| HEVC (incl. 10-bit HDR)  | copied (fMP4)                  | copied (fMP4)           | converted to H.264     |
| AC-3 / E-AC-3 5.1        | copied                         | 5.1 AAC or stereo       | stereo AAC             |
| H.264 + AAC              | copied                         | copied                  | copied                 |

Copied HEVC goes out as fragmented-MP4 HLS cut on the file's own keyframes, so
it starts in well under a second and costs the server almost nothing. Dolby
Vision profile 5 is still converted (it has no HDR10 layer).

### Burned-in subtitles

Subtitles are only offered burned in: the subtitle menu lists the file's tracks
and **Off**, and nothing is drawn by the player itself. Picking one restarts the stream at the same moment with the subtitles drawn into the
picture — they then show everywhere, including Safari's fullscreen player, TVs,
and DVD / DVB bitmap tracks no browser can draw. Pictures (PGS, VobSub, DVB)
are overlaid at the output size; text (SRT, ASS) is drawn by libass from the
track, read ahead of the encoder at download speed, so the first frame needs
only the next minute of it.

## Limitations

- **Surround** is kept only where the device has the speakers for it (the
  browser reports its channel count): there it goes out as it is (AC-3 / E-AC-3
  on Apple devices) or as 5.1 AAC. Elsewhere it is mixed down to stereo.
- **ASS subtitle styling** is reduced to plain text when the browser draws the
  subtitles. Picked from the subtitle menu, it is burned in with the full
  styling (with the file's own fonts); VLC renders it fully too.
- **Dolby Vision profile 5** (no HDR10 base layer, common in streaming rips)
  converts with wrong colours. Profiles 7 and 8 use their HDR10 layer and are
  fine.

**No player here opens a torrent; they open URLs.** Addons that return a bare
`infoHash` — Torrentio and friends in their default configuration — appear in
the stream list dimmed and labelled, because there is nothing to hand over.
Point those addons at a debrid service (Real-Debrid, TorBox, AllDebrid) so they
return HTTPS links. The native builds have the same constraint; they just hide
it behind a bundled player.

Non-addon sources inside a collection folder (Trakt lists, TMDB ids) are
skipped — those need provider credentials this bridge doesn't hold.

---

## Troubleshooting

**Binge skips episodes.** Open `/playlist/<token>/report` in a browser — the
token is in the playlist URL. It lists every episode the playlist was built
from, which addon supplied the stream, how many candidates there were, what the
probe said, and the reason for anything missing.

The remaining case that genuinely drops an episode is no addon returning an
HTTP link for it at all. A debrid addon fixes that.

**VLC opens but nothing returns to the app.** `PUBLIC_URL` is wrong or not
reachable from the phone. Only iOS returns at all — `vlc-x-callback` is the
only one of these mechanisms with a way back.

**Tapping Play on Android does nothing.** Firefox and the other non-Chromium
Android browsers ignore `intent://` silently. Settings → Play with → **VLC
(.m3u file)**, which works in every Android browser.

**The page says it can't play the file.** That is the in-page player meeting an
MKV, which no browser decodes. Use VLC — on desktop, the `.m3u` option.

**A page hangs for ~15 seconds.** A dead addon. Calls fan out in parallel and
failures are dropped rather than propagated, so it costs one timeout rather
than a broken page — but the timeout is `HTTP_TIMEOUT_MS`.

**Signing in on the phone signed me out on the laptop.** It shouldn't; devices
are stored separately and sign-out is scoped local. If it happens, something
else called GoTrue with global scope on that account.

`GET /healthz` returns `{ ok, accounts, devices, playlists }`.

---

## HTTP endpoints

Everything under `/api` except login/signup/session requires a device cookie.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/login`, `/api/signup`, `/api/logout` | Auth. Login and signup are rate limited. |
| `GET` | `/api/session` | Current device and account state. |
| `GET` | `/vlc-setup` | Setup page for the desktop VLC launcher. |
| `GET` | `/vlc-launcher/:os` | Launcher installer for `windows`, `macos` or `linux` (`?remove=1` for the remover, `?dl=1` to download). |
| `GET` | `/api/profiles` · `POST` `/api/profile` | Nuvio profile picker. |
| `POST` | `/api/theme`, `/api/prefs` | Per-account theme and playback settings. |
| `GET` | `/api/home`, `/api/catalogs`, `/api/catalog` | Home rows and paged catalogs. |
| `GET` | `/api/collections`, `/api/collection/:id/:folderId` | Collections and folder contents. |
| `GET` | `/api/library` · `POST` `/api/library` | Library read, add, remove. |
| `GET` | `/api/search`, `/api/meta/:type/:id`, `/api/streams/:type/:id` | Addon protocol. |
| `GET` | `/play`, `/play/auto/:type/:id` | Hand-off. `?target=` and `?os=` choose the player; without them the User-Agent decides. |
| `GET` | `/playlist/:token.m3u` | Binge playlist, resolved on fetch. `?dl=1` sends it as a download. |
| `GET` | `/watch` · `/api/ticket/:token` | The player in the page, and the queue behind it. |
| `GET` | `/api/subtitles/:type/:id` · `/sub.vtt` | Subtitle list, and the SubRip-to-WebVTT converter. Signed. |
| `GET` | `/api/transcode/subtitle` | A text subtitle from inside the file, extracted to WebVTT by Lumen. Signed. |
| `GET` | `/media` | Optional media proxy. Signed, and 404 unless `MEDIA_PROXY=true`. |
| `POST` | `/api/transcode/start` · `/heartbeat/:sid` · `/stop/:sid` | Conversion sessions. Signed, and 404 without ffmpeg. |
| `GET` | `/api/transcode/inspect` | What converting a file would cost, before offering it. |
| `GET` | `/hls/:sid/:file` | The playlist and its segments. The session id is the credential. |
| `GET` | `/playlist/:token/report` | Why an episode is missing. |
| `GET` | `/healthz` | Health check. |

---

## Project layout

```
src/nuvio.js      Supabase auth, profiles, addons table, library and sync RPCs
src/sessions.js   per-user session and account store, encrypted at rest
src/playlist.js   binge playlists — M3U records, resolved on demand
src/languages.js  language codes, subtitle matching, release-name hints
src/addons.js     Stremio addon protocol — manifests, catalogs, search, meta, streams
src/http.js       the web layer — routing, cookies, JSON bodies, static, gzip
src/transcode.js  ffmpeg — HLS sessions, remux or re-encode, for the browser
src/subsync.js   subtitle sync — lines addon subtitles up with the film's dialogue
src/keyframes.js  Matroska keyframe index (Cues), so a remux is cut where the file's keyframes are
public/vendor/    hls.js, for browsers without native HLS (Chrome, Firefox)
src/players.js    per-platform hand-off: vlc-x-callback://, intent://, .m3u
src/signing.js    HMAC signatures for the URLs the browser fetches through us
src/subtitles.js  SubRip to WebVTT, for the player in the page
src/proxy.js      optional range-forwarding media proxy (MEDIA_PROXY)
src/server.js     routes, session handling, token refresh, stream ranking, probing
public/           the UI (vanilla JS, no build step)
  platform.js     device detection and the player choice
  player.js       the in-page player: queue, subtitles, fallbacks
  sw.js           service worker — app shell only, never API or streams
```

Nuvio's `addons` table stores only a URL per addon, not a cached manifest, so
manifests are fetched on first use and cached for `CACHE_TTL_MS`.

### No dependencies

Express and cookie-parser are gone; `src/http.js` does routing, cookies, JSON
bodies and static files on node's own `http` server, keeping the same API the
routes were written against. It adds two things Express wasn't doing: gzip on
text responses — a home screen is a few hundred kilobytes of JSON that
compresses to a fraction of that — and ETags with `304` replies on static
assets.

### What the details page shows

Episode stills, air dates, runtimes and synopses come from the meta addon,
which was already returning them. Addons disagree on the field names —
`released` or `firstAired`, `overview` or `description`, `thumbnail` or
`still` — so `normalizeVideo` in `src/addons.js` settles on one set, and sorts
by season and episode because addons return videos in whatever order their
source happened to use.

Metadata is cached three ways: the addon response for `CACHE_TTL_MS` on the
server, a `private, max-age=300` header so the browser keeps it, and a promise
cache in the client so opening the same title twice makes one request.

---

## Addon protocol notes

The addon layer follows what the Nuvio clients do, which matters for addons
that stray from the simple case:

- **Extras are a path segment in a fixed order** — `search`, then `genre`, then
  `skip`, joined with `&`. Sending them as a query string, or reordered, makes
  some addons silently return the wrong page.
- **Both manifest dialects parse** — newer `extra: [{name, isRequired,
  options}]` and older `extraSupported` / `extraRequired` + `genres`.
- **Resource-level types and idPrefixes are respected**, so a Kitsu addon is
  never asked about `tt` ids. Beyond correctness this is a speed fix.
- **Catalogs with a required genre** get one supplied automatically; ones
  requiring some other extra are kept out of home rows but stay browsable.
- **Addons flagged `configurationRequired`** are dropped rather than queried.
- **Any type works** — anime, tv, channels, whatever an addon declares.
- **Row order** comes from `sync_pull_home_catalog_settings`, so disabled
  catalogs stay hidden and ordering matches the app.

---

## Notes

Self-hosted and single-purpose: it talks to your own Nuvio account and the
addons you installed there. It hosts no content and ships no addons.
