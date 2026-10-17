// Lumen: making the unplayable playable, with ffmpeg.
//
// Browsers refuse MKV, AC3/DTS audio, HEVC, image subtitles and a good deal
// else. This turns any of it into HLS the <video> element will take, doing as
// little work as possible for each file:
//
//   H.264 video      → copied untouched (a remux). Costs almost nothing.
//   HEVC / AV1 / 4K  → re-encoded to H.264, on the GPU when there is one.
//   HDR              → tone mapped to SDR on the GPU, so it isn't washed out.
//   AC3 / DTS / etc  → re-encoded to AAC stereo. Cheap.
//   PGS / VobSub     → burned into the picture (browsers can't draw them).
//   Text subtitles   → extracted to WebVTT and drawn by the browser.
//
// How it differs from a growing playlist
// --------------------------------------
// The playlist is a complete VOD playlist from the first request: every
// segment of the film is listed, with its length, before any of them exist.
// The player therefore knows the real duration and can seek anywhere. When
// it asks for a segment that hasn't been made, ffmpeg is restarted exactly
// there — so jumping to 1:30:00 costs one segment's worth of work, not an
// hour and a half of it.
//
// Rather than a read-rate throttle, the encoder is frozen (SIGSTOP) once it
// is far enough ahead of the player and thawed (SIGCONT) as soon as the
// player catches up. A paused film costs nothing; a playing one gets
// converted flat out whenever the buffer runs low.
//
// When ffmpeg can't do it at all — no ffmpeg, the server busy, a source it
// can't open — start() throws, and the player falls back to VLC.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as hw from './hwaccel.js';
import * as keyframes from './keyframes.js';

export const enabled = process.env.TRANSCODE !== 'false';

const MAX_SESSIONS = Number(process.env.TRANSCODE_MAX || 2);
const SEG = Math.max(1, Number(process.env.TRANSCODE_SEGMENT_SECS || 2));
const PROBE_TIMEOUT_MS = Number(process.env.TRANSCODE_PROBE_TIMEOUT_MS || 20000);
const START_TIMEOUT_MS = Number(process.env.TRANSCODE_START_TIMEOUT_MS || 60000);
// How long a single segment request may wait for ffmpeg to produce it.
const SEGMENT_WAIT_MS = Number(process.env.TRANSCODE_SEGMENT_WAIT_MS || 45000);
// The player beats every ten seconds; three missed beats and it's gone.
const HEARTBEAT_MS = Number(process.env.TRANSCODE_HEARTBEAT_MS || 35000);
const STALL_MS = Number(process.env.TRANSCODE_STALL_MS || 20000);
const MAX_RESTARTS = 6;
// Encode this far ahead of the player, then freeze until it catches up.
const AHEAD_SECS = Number(process.env.TRANSCODE_AHEAD_SECS || 90);
const AHEAD_SEGS = Math.max(4, Math.ceil(AHEAD_SECS / SEG));
// A request further ahead than this restarts ffmpeg rather than waiting for it.
const LOOKAHEAD_SEGS = Math.max(3, Math.ceil(12 / SEG));
// A remux runs many times faster than real time, so for a short jump ahead
// it's quicker to let it run on than to restart it somewhere new.
const COPY_LOOKAHEAD_SEGS = Math.max(LOOKAHEAD_SEGS, Math.ceil(45 / SEG));
// Segments kept behind the playhead, so a short rewind is instant.
// Everything converted in the last 20 minutes is kept, so scrubbing back to
// anywhere in it is instant (it's on disk already). Adjustable.
const KEEP_BEHIND_SEGS = Math.ceil(Number(process.env.TRANSCODE_KEEP_BEHIND_SECS || 1200) / SEG);
// A remux of a Matroska file is cut at the source's own keyframes (see
// keyframes.js), merged into segments at least this long. Longer than a
// conversion's, because a remux is nearly free to make and every segment is
// a round trip: on a phone over the internet, fewer and larger requests are
// what keeps the buffer full.
const REMUX_SEG = Math.max(SEG, Number(process.env.TRANSCODE_REMUX_SEGMENT_SECS || 4));
// The longest gap between keyframes worth building a playlist on. Beyond it
// the index is probably sparse rather than the keyframes, so the grid is used.
const MAX_GOP_SECS = 30;
const MAX_HEIGHT = Number(process.env.TRANSCODE_MAX_HEIGHT || 1080);
const QUALITY = Number(process.env.TRANSCODE_CRF || 23);

const HLS_ROOT = process.env.TRANSCODE_DIR
  || path.join(process.env.STATE_DIR || os.tmpdir(), 'hls');
const SUB_ROOT = path.join(HLS_ROOT, '_subs');

function defaultPreset() {
  if (process.env.TRANSCODE_PRESET) return process.env.TRANSCODE_PRESET;
  const cores = os.cpus()?.length || 2;
  if (cores <= 2) return 'ultrafast';
  if (cores <= 4) return 'superfast';
  if (cores <= 8) return 'veryfast';
  return 'faster';
}

const VIDEO_PASSTHROUGH = new Set(['h264', 'avc1']);
const AUDIO_PASSTHROUGH = new Set(['aac', 'mp3']);
const BROWSER_VIDEO = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av1']);
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const IMAGE_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

/** @type {Map<string, object>} */
const sessions = new Map();
const probeCache = new Map();
const PROBE_TTL_MS = 30 * 60_000;
let available = null;
// ffmpeg filters this build actually has. Tone mapping and GPU overlays exist
// only in some builds (Jellyfin's has all of them), so ask rather than assume.
let filters = new Set();

// ----------------------------------------------------------------- setup

export async function detect() {
  if (available !== null) return available;
  if (!enabled) { available = false; return false; }

  try {
    const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    const [code] = await once(child, 'close');
    available = code === 0;
  } catch {
    available = false;
  }

  if (available) {
    filters = await listFilters();
    await hw.detect();
    await fsp.rm(HLS_ROOT, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(SUB_ROOT, { recursive: true }).catch(() => {});
    setInterval(tick, 2000).unref();
  }
  return available;
}

async function listFilters() {
  try {
    const child = spawn('ffmpeg', ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    await once(child, 'close');
    const names = new Set();
    for (const line of out.split('\n')) {
      const match = /^\s*[.A-Z|]{2,4}\s+(\S+)\s/.exec(line);
      if (match) names.add(match[1]);
    }
    return names;
  } catch {
    return new Set();
  }
}

export function isAvailable() {
  return available === true;
}

export function acceleration() {
  return {
    ...hw.describe(),
    toneMapping: toneMapper(hw.active().name) || null,
  };
}

// Which tone mapper a given accelerator can use in this build, if any.
function toneMapper(accel) {
  if (accel === 'nvenc' && filters.has('tonemap_cuda')) return 'cuda';
  if (accel === 'vaapi' && filters.has('tonemap_vaapi')) return 'vaapi';
  if (filters.has('zscale') && filters.has('tonemap')) return 'cpu';
  return null;
}

export function busy() {
  return sessions.size >= MAX_SESSIONS;
}

export function count() {
  return sessions.size;
}

export function diagnose(sid) {
  const s = sessions.get(sid);
  if (!s) return null;
  return {
    sid,
    segments: segmentFiles(s.dir).length,
    segmentType: 'mpegts',
    alignment: s.bounds ? 'keyframes' : 'grid',
    startSegment: s.startSeg,
    lastRequested: s.lastReq,
    highestSegment: highestSeg(s),
    totalSegments: s.nseg,
    paused: s.paused,
    restarts: s.restarts,
    finished: s.finished,
    running: running(s),
    encoder: s.plan.videoCopy && s.burn == null ? 'copy' : s.accel.name,
    burn: s.burn,
    lastError: s.lastError ? String(s.lastError).slice(0, 400) : null,
    plan: {
      container: s.plan.container,
      videoCodec: s.plan.videoCodec,
      audioCodec: s.plan.audioCodec,
      videoCopy: s.plan.videoCopy && s.burn == null,
      hdr: s.plan.hdr,
    },
  };
}

// --------------------------------------------------------------- probing

export async function inspect(url) {
  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.details;
  const details = await probeNow(url);
  if (details) {
    if (probeCache.size > 200) probeCache.clear();
    probeCache.set(url, { at: Date.now(), details });
  }
  return details;
}

async function probeNow(url) {
  const args = [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams',
    '-user_agent', 'Mozilla/5.0', '-multiple_requests', '1',
    '-analyzeduration', '1M', '-probesize', '1M',
    url,
  ];
  const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });

  try {
    const [code] = await once(child, 'close');
    if (code !== 0 || !out) return null;
    const data = JSON.parse(out);
    const streams = data.streams || [];
    const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const audioStreams = streams.filter((s) => s.codec_type === 'audio');
    const audio = audioStreams[0];

    let fps = 25;
    if (video?.r_frame_rate) {
      const [n, d] = String(video.r_frame_rate).split('/').map(Number);
      if (d > 0 && n > 0) fps = Math.round(n / d);
    }
    const exact = Number(data.format?.duration) || 0;
    const tenBit = /10|12/.test(String(video?.pix_fmt || ''));

    return {
      duration: Math.floor(exact) || null,
      durationExact: exact || null,
      startTime: Number(data.format?.start_time) || 0,
      width: video?.width || null,
      height: video?.height || null,
      videoCodec: video?.codec_name || null,
      pixFmt: video?.pix_fmt || null,
      hdr: ['smpte2084', 'arib-std-b67'].includes(video?.color_transfer),
      audioChannels: audio?.channels || null,
      audioCodec: audio?.codec_name || null,
      fps,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      // 10-bit H.264 can't be copied: no browser decodes it.
      videoCopy: VIDEO_PASSTHROUGH.has(String(video?.codec_name)) && !tenBit,
      audioCopy: AUDIO_PASSTHROUGH.has(String(audio?.codec_name)),
      browserVideo: !video || (BROWSER_VIDEO.has(String(video.codec_name)) && !tenBit),
      browserAudio: !audio || BROWSER_AUDIO.has(String(audio.codec_name)),
      container: data.format?.format_name || null,
      directStreamsOnly: Boolean(video) && Boolean(audio)
        && BROWSER_VIDEO.has(String(video.codec_name)) && !tenBit
        && BROWSER_AUDIO.has(String(audio.codec_name)),
      direct: Boolean(video) && Boolean(audio)
        && BROWSER_VIDEO.has(String(video.codec_name)) && !tenBit
        && BROWSER_AUDIO.has(String(audio.codec_name))
        && universalContainer(data.format?.format_name, url),
      audioTracks: audioStreams.map((stream, order) => ({
        index: order,
        codec: stream.codec_name || null,
        channels: stream.channels || null,
        lang: stream.tags?.language || null,
        title: stream.tags?.title || null,
        label: audioLabel(stream, order),
        default: stream.disposition?.default === 1,
      })),
      // Subtitles inside the file. `stream` is ffmpeg's absolute index.
      subtitleTracks: streams
        .filter((s) => s.codec_type === 'subtitle'
          && (TEXT_SUBS.has(s.codec_name) || IMAGE_SUBS.has(s.codec_name)))
        .map((s) => ({
          stream: s.index,
          codec: s.codec_name,
          image: IMAGE_SUBS.has(s.codec_name),
          // How the browser shows it: text as WebVTT, Blu-ray PGS drawn by
          // the player itself. DVD/DVB bitmaps have no browser renderer.
          render: TEXT_SUBS.has(s.codec_name) ? 'text'
            : s.codec_name === 'hdmv_pgs_subtitle' ? 'pgs' : null,
          lang: s.tags?.language || null,
          forced: s.disposition?.forced === 1,
          default: s.disposition?.default === 1,
          label: subtitleLabel(s),
        })),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function universalContainer(formatName, url) {
  const format = String(formatName || '');
  if (!/mp4|mov|m4v|matroska|webm/.test(format)) return false;
  if (/matroska|webm/.test(format)) return /\.webm(\?|$)/i.test(String(url || ''));
  return true;
}

function audioLabel(stream, order) {
  const language = stream.tags?.language ? String(stream.tags.language).toUpperCase() : null;
  const layout = stream.channels === 6 ? '5.1'
    : stream.channels === 8 ? '7.1'
      : stream.channels === 2 ? 'Stereo'
        : stream.channels === 1 ? 'Mono' : null;
  const parts = [language, stream.tags?.title, layout,
    stream.codec_name ? String(stream.codec_name).toUpperCase() : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : `Track ${order + 1}`;
}

function subtitleLabel(stream) {
  const language = stream.tags?.language && stream.tags.language !== 'und'
    ? String(stream.tags.language).toUpperCase() : null;
  const parts = [
    language,
    stream.tags?.title,
    stream.disposition?.forced === 1 ? 'Forced' : null,
    null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} (in file)` : `Track ${stream.index} (in file)`;
}

// ---------------------------------------------------------------- ffmpeg

const INPUT_FLAGS = [
  '-hide_banner', '-loglevel', 'error', '-nostdin',
  // Debrid links drop connections, and a frozen encoder's connection goes
  // idle. These let both reconnect instead of ending the session.
  '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1',
  '-reconnect_delay_max', '5', '-rw_timeout', '15000000',
  '-thread_queue_size', '4096',
  '-analyzeduration', '2M', '-probesize', '2M',
  '-fflags', '+genpts+discardcorrupt',
  '-user_agent', 'Mozilla/5.0', '-multiple_requests', '1',
];

// Picture size after the height cap, keeping the aspect ratio and even sizes.
function targetSize(plan) {
  const srcH = plan.height || 1080;
  const srcW = plan.width || Math.round(srcH * 16 / 9);
  const h = MAX_HEIGHT > 0 ? Math.min(srcH, MAX_HEIGHT) : srcH;
  const w = Math.round((srcW * h) / srcH / 2) * 2;
  return { w, h: h - (h % 2) };
}

// Everything to do with the picture: [input args, output args].
function videoArgs(s) {
  const { plan, burn } = s;
  if (plan.videoCopy && burn == null) return [[], ['-map', '0:V:0', '-c:v', 'copy']];

  const { w, h } = targetSize(plan);
  const hdr = plan.hdr;
  const accel = s.accel;
  const tm = hdr ? toneMapper(accel.name) : null;
  const gop = Math.max(1, Math.round((plan.fps || 25) * SEG));
  const keyframes = [
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
  ];
  const encode = [...accel.encode(QUALITY, defaultPreset()), ...keyframes];
  let input = [];
  let chain;

  if (accel.name === 'nvenc' && (burn == null || (filters.has('overlay_cuda') && filters.has('hwupload_cuda')))) {
    // Decode, scale, tone map and overlay all on the GPU.
    input = ['-init_hw_device', 'cuda=cu:0', '-filter_hw_device', 'cu',
      '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'];
    const main = tm === 'cuda'
      ? `[0:V:0]scale_cuda=w=${w}:h=${h}:format=p010,tonemap_cuda=format=yuv420p:p=bt709:t=bt709:m=bt709:tonemap=bt2390:peak=100:desat=0`
      : `[0:V:0]scale_cuda=w=${w}:h=${h}:format=yuv420p`;
    chain = burn == null
      ? `${main}[vout]`
      : `${main}[main];[0:${burn}]scale=${w}:${h},format=yuva420p,hwupload_cuda[sub];[main][sub]overlay_cuda=eof_action=pass:repeatlast=0[vout]`;
  } else if (accel.name === 'vaapi') {
    const dev = '/dev/dri/renderD128';
    const tone = tm === 'vaapi' ? ',tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709' : '';
    // Stay 10-bit until after tone mapping, or the HDR is thrown away first.
    const fmt = tone ? 'p010' : 'nv12';
    if (burn == null) {
      input = ['-hwaccel', 'vaapi', '-hwaccel_device', dev, '-hwaccel_output_format', 'vaapi'];
      chain = `[0:V:0]scale_vaapi=w=${w}:h=${h}:format=${fmt}${tone}[vout]`;
    } else {
      input = ['-init_hw_device', `vaapi=va:${dev}`, '-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-filter_hw_device', 'va'];
      chain = `[0:V:0][0:${burn}]overlay=eof_action=pass:repeatlast=0,scale=${w}:${h}:flags=fast_bilinear,format=${fmt},hwupload${tone}[vout]`;
    }
  } else {
    // CPU decode and filters; the encoder may still be hardware (QSV,
    // VideoToolbox, AMF, V4L2) — those take ordinary frames.
    const pre = burn == null ? '[0:V:0]' : `[0:V:0][0:${burn}]overlay=eof_action=pass:repeatlast=0,`;
    // Scale first so the (expensive) CPU tone mapping sees fewer pixels.
    const tone = hdr && toneMapper('software') === 'cpu'
      ? ',zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv'
      : '';
    const fmt = accel.name === 'qsv' ? 'nv12' : 'yuv420p';
    const upload = accel.uploadFilter ? `,${accel.uploadFilter}` : '';
    chain = `${pre}scale=${w}:${h}:flags=fast_bilinear${tone},format=${fmt}${upload}[vout]`;
  }

  return [input, ['-filter_complex', chain, '-map', '[vout]', ...encode, '-threads', '0']];
}

function audioArgs(s) {
  const track = s.plan.audioTracks[s.audio] || s.plan.audioTracks[0];
  if (!track) return [];
  const map = ['-map', `0:a:${track.index}?`];
  if (track.codec === 'aac' && (track.channels || 2) <= 2) return [...map, '-c:a', 'copy'];
  return [...map, '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-af', 'aresample=async=1:first_pts=0'];
}

function copying(s) {
  return Boolean(s.plan.videoCopy && s.burn == null);
}

function buildArgs(s, seg, at = segStart(s, seg)) {
  const t = at;
  const [vin, vout] = videoArgs(s);
  if (s.bounds) return keyframeArgs(s, seg, at, vin, vout);
  return [
    ...INPUT_FLAGS,
    ...vin,
    // Live TV has no timeline to seek in: always start at "now".
    ...(t > 0 && !s.live ? ['-ss', String(t)] : []),
    '-i', s.url,
    ...vout,
    ...audioArgs(s),
    '-sn', '-dn',
    '-max_muxing_queue_size', '4096',
    // MPEG-TS normally shifts every timestamp 1.4 s later. With it at zero,
    // a segment's clock is exactly the film's clock, which is the clock the
    // subtitles are timed against.
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'hls',
    '-hls_time', String(SEG),
    // Live: a rolling window of the last minute or so, like any live HLS
    // stream, with old segments deleted as it goes.
    '-hls_list_size', s.live ? String(Math.ceil(60 / SEG)) : '0',
    '-hls_segment_type', 'mpegts',
    // temp_file: a segment only appears under its real name once complete.
    //
    // split_by_time on a remux: with the video copied, ffmpeg can otherwise
    // only cut where the source has a keyframe — often every 5-10 s — so its
    // segments were longer than the playlist said and fell further behind it
    // every segment. The player asked for minute 2 and got minute 5, then
    // waited forever for the gap ("Nothing has played"). Cutting on time
    // keeps segment N at N x SEG, where the playlist says it is.
    '-hls_flags', [
      'temp_file',
      copying(s) ? 'split_by_time' : 'independent_segments',
      ...(s.live ? ['delete_segments', 'omit_endlist'] : []),
    ].join('+'),
    '-start_number', String(seg),
    // Keep timestamps on the film's clock, so segment N plays at N*SEG.
    ...(s.live ? [] : ['-output_ts_offset', String(t)]),
    '-hls_segment_filename', path.join(s.dir, 'seg%d.ts'),
    path.join(s.dir, 'ffmpeg.m3u8'),
  ];
}

// A remux cut exactly at the source's keyframes. The segment muxer is told
// every cut point (relative to where this run starts), so segment N always
// begins on a keyframe at precisely the time the playlist gives it: Safari's
// clock, the picture and the subtitles all agree, and any segment can be
// decoded on its own after a seek. Each finished segment is listed in
// ffmpeg.csv, which is what marks it complete (the segment muxer has no
// temp_file).
function keyframeArgs(s, seg, at, vin, vout) {
  const cuts = s.bounds.slice(seg + 1).map((b) => (b - at).toFixed(3));
  return [
    ...INPUT_FLAGS,
    ...vin,
    ...(at > 0 ? ['-ss', at.toFixed(3)] : []),
    '-i', s.url,
    ...vout,
    ...audioArgs(s),
    '-sn', '-dn',
    '-max_muxing_queue_size', '4096',
    '-muxdelay', '0', '-muxpreload', '0',
    '-output_ts_offset', at.toFixed(3),
    '-f', 'segment',
    '-segment_format', 'mpegts',
    ...(cuts.length ? ['-segment_times', cuts.join(',')] : []),
    '-segment_time_delta', '0.02',
    '-segment_start_number', String(seg),
    '-segment_list', path.join(s.dir, 'ffmpeg.csv'),
    '-segment_list_type', 'csv',
    '-reset_timestamps', '0',
    path.join(s.dir, 'seg%d.ts'),
  ];
}

// Where segment n starts, in film seconds.
function segStart(s, n) {
  if (!s.bounds) return n * SEG;
  if (n < 0) return n * REMUX_SEG;
  return s.bounds[Math.min(n, s.bounds.length - 1)];
}

// The segment that contains film time t.
function segAt(s, t) {
  if (!s.bounds) return Math.floor(t / SEG);
  let lo = 0;
  let hi = s.bounds.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (s.bounds[mid] <= t + 1e-6) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Pick up segments the segment muxer has finished since the last look.
function refreshDone(s) {
  if (!s.bounds) return;
  let list;
  try { list = fs.readFileSync(path.join(s.dir, 'ffmpeg.csv'), 'utf8'); } catch { return; }
  for (const match of list.matchAll(/^seg(\d+)\.ts,/gm)) s.done.add(Number(match[1]));
}

// Segment n is on disk and complete.
function segReady(s, n) {
  if (s.bounds && !s.done.has(n)) return false;
  return fs.existsSync(path.join(s.dir, `seg${n}.ts`));
}

const NOISE = /non-monotonous|non monotonic|Packet corrupt|PES packet|Last message repeated|no frame!|non-existing (SPS|PPS)|Could not find ref|\[h264 @|\[hevc @|\[aac @|\[ac3 @/i;
const DEVICE_FAILURE = /Device creation failed|Cannot load|No device available|Failed to initialise VAAPI|CUDA_ERROR_NO_DEVICE|OpenEncodeSessionEx failed/i;

// -------------------------------------------------------------- sessions

function segmentFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => /^seg\d+\.ts$/.test(f)); } catch { return []; }
}

// The last segment in the unbroken run from where this ffmpeg started. Files
// from an earlier run further along don't count: they aren't progress.
function highestSeg(s) {
  // Live deletes old segments as it goes, so there's no unbroken run to
  // follow: the newest file is the answer.
  if (s.live) {
    let max = s.startSeg - 1;
    for (const f of segmentFiles(s.dir)) max = Math.max(max, Number(f.slice(3, -3)));
    return max;
  }
  refreshDone(s);
  let i = s.startSeg;
  while (segReady(s, i)) i += 1;
  return i - 1;
}

function running(s) {
  return Boolean(s.child) && s.child.exitCode === null && s.child.signalCode === null;
}

// Where a remux can actually start near time t: the keyframe at or before it.
// A copied stream can only begin on a keyframe, so ffmpeg asked to start at
// 40 s on a file with keyframes every 10 s really starts at 30 s. Knowing
// that up front lets the segments be numbered for where they truly are,
// rather than labelling 30 s as 40 s and leaving the player 10 s adrift.
// ffprobe finds it through the file's index, reading only a little.
async function keyframeAtOrBefore(url, t) {
  const child = spawn('ffprobe', [
    '-v', 'error', '-user_agent', 'Mozilla/5.0',
    '-read_intervals', `${t}%+#1`, '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-show_entries', 'frame=pts_time,best_effort_timestamp_time', '-of', 'csv=p=0', url,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  try {
    await once(child, 'close');
    const value = out.split(/[\n,]/).map(Number).find((n) => Number.isFinite(n) && n >= 0);
    return Number.isFinite(value) && value <= t + 0.5 ? value : t;
  } catch {
    return t;
  } finally {
    clearTimeout(timer);
  }
}

// Start (or restart) ffmpeg so that segment `seg` is produced next. For a
// remux this first moves the start back to the real keyframe.
async function launchAt(s, seg) {
  if (!copying(s) || seg === 0 || s.live || s.bounds) { launch(s, seg); return; }
  const token = (s.launchToken = (s.launchToken || 0) + 1);
  const start = s.plan.startTime || 0;
  const k = Math.max(0, (await keyframeAtOrBefore(s.url, start + seg * SEG)) - start);
  if (s.dead || token !== s.launchToken) return;
  const first = Math.min(seg, Math.floor(k / SEG + 1e-6));
  launch(s, first, k);
}

function launch(s, seg, at = segStart(s, seg)) {
  kill(s);
  refreshDone(s);
  for (const f of fs.readdirSync(s.dir)) {
    if (f.startsWith('ffmpeg') || f.endsWith('.tmp')) fs.rmSync(path.join(s.dir, f), { force: true });
  }
  // This run rewrites everything from seg on; until it has, none of it is
  // complete.
  if (s.bounds) for (const n of [...s.done]) if (n >= seg) s.done.delete(n);
  s.startSeg = seg;
  s.finished = false;
  s.paused = false;
  s.lastProgress = Date.now();

  const child = spawn('ffmpeg', buildArgs(s, seg, at), { stdio: ['ignore', 'ignore', 'pipe'] });
  s.child = child;
  const tag = s.sid.slice(0, 8);

  child.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message && !NOISE.test(message)) {
      s.lastError = message;
      console.error(`[lumen ${tag}] ${message.slice(0, 300)}`);
    }
  });
  child.on('error', (err) => { s.lastError = err.message; });
  child.on('close', (code) => {
    // Killed on purpose (a seek, a stop): the replacement is already running.
    if (s.dead || child !== s.child) return;
    if (code === 0) { s.finished = true; return; }

    // A GPU that can't take this file costs this session a CPU restart. A
    // GPU that has actually gone away costs every session one.
    const encoding = !(s.plan.videoCopy && s.burn == null);
    if (encoding && s.accel !== hw.SOFTWARE) {
      console.error(`[lumen ${tag}] ${s.accel.label} failed on this file — using the CPU for it`);
      if (DEVICE_FAILURE.test(s.lastError || '')) hw.demote(tag);
      s.accel = hw.SOFTWARE;
    }
    s.restarts += 1;
    if (s.restarts > MAX_RESTARTS) {
      console.error(`[lumen ${tag}] gave up after ${MAX_RESTARTS} restarts`);
      s.failed = true;
      stop(s.sid);
      return;
    }
    // Live: give the IPTV panel a moment to release the connection it just
    // lost — most plans allow only one or two, and an instant retry is
    // refused as a second viewer.
    if (s.live) {
      setTimeout(() => { if (!s.dead) launch(s, highestSeg(s) + 1); }, 2500);
      return;
    }
    launchAt(s, Math.max(s.lastReq, highestSeg(s) + 1));
  });
}

function kill(s) {
  const { child } = s;
  s.child = null;
  if (!child || child.exitCode !== null) return;
  try { if (s.paused) child.kill('SIGCONT'); } catch { /* gone */ }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
}

// Runs every two seconds: freeze encoders that are far enough ahead, thaw
// ones the player is catching up to, restart ones that have stalled, and
// delete segments well behind the playhead.
function tick() {
  for (const s of sessions.values()) {
    const top = highestSeg(s);
    if (top !== s.seenTop) { s.seenTop = top; s.lastProgress = Date.now(); }

    if (running(s)) {
      const ahead = s.live ? 0 : segStart(s, top) - segStart(s, s.lastReq);
      if (!s.paused && ahead >= AHEAD_SEGS * SEG) {
        try { s.child.kill('SIGSTOP'); s.paused = true; } catch { /* gone */ }
      } else if (s.paused && ahead < (AHEAD_SEGS * SEG) / 2) {
        thaw(s);
      } else if (!s.paused && Date.now() - s.lastProgress > STALL_MS) {
        // Running, not frozen, producing nothing: the source stopped answering.
        s.lastProgress = Date.now();
        try { s.child.kill('SIGKILL'); } catch { /* gone */ }
      }
    }

    const keepFrom = segStart(s, s.lastReq) - KEEP_BEHIND_SEGS * SEG;
    for (const f of segmentFiles(s.dir)) {
      const n = Number(f.slice(3, -3));
      if (segStart(s, n) < keepFrom) {
        fs.rmSync(path.join(s.dir, f), { force: true });
        s.done?.delete(n);
      }
    }
  }
}

function thaw(s) {
  if (!s.paused) return;
  s.paused = false;
  s.lastProgress = Date.now();
  try { s.child?.kill('SIGCONT'); } catch { /* gone */ }
}

/**
 * Start a session. Resolves once the first segment exists, so a file ffmpeg
 * can't handle fails here — where the player can still offer VLC — rather
 * than as a spinner that never ends.
 *
 * @param {string} url
 * @param {{ audio?: number, seek?: number, burn?: number|null, plan?: object }} opts
 */
export async function start(url, { audio = 0, seek = 0, burn = null, plan = null, aligned = false, encode = false } = {}) {
  if (!isAvailable()) throw new Error('ffmpeg is not in this build.');
  if (busy()) throw new Error('Too many conversions are already running.');

  // A remux of Matroska is cut at its keyframes, so ask for them alongside
  // the probe rather than after it.
  const early = plan ? (/matroska/.test(String(plan.container)) ? keyframeIndex(url) : null)
    : (/\.mkv(\?|$)/i.test(url) ? keyframeIndex(url) : null);
  let details = plan || await inspect(url);
  if (!details) throw new Error('The source could not be opened.');
  if (!details.hasVideo) throw new Error('There is no video in this file.');
  if (burn != null && !details.subtitleTracks.some((t) => t.stream === burn && t.image)) {
    throw new Error('Only image subtitles are burned in.');
  }

  const sid = crypto.randomBytes(12).toString('hex');
  const dir = path.join(HLS_ROOT, sid);
  await fsp.mkdir(dir, { recursive: true });

  const exact = details.durationExact || 0;
  let bounds = null;
  if (exact && details.videoCopy && burn == null && /matroska/.test(String(details.container))) {
    const found = await (early || keyframeIndex(url));
    if (found) {
      const start = details.startTime || 0;
      const b = keyframes.boundaries(found.map((t) => t - start), exact, REMUX_SEG);
      const gaps = b.map((t, i) => (b[i + 1] ?? exact) - t);
      if (b.length >= 2 && Math.max(...gaps) <= MAX_GOP_SECS) bounds = b;
    }
  }
  // Safari's own player (iPhone, iPad, Mac Safari) keeps time by the
  // playlist. A remux on the fixed grid can't match it — its segments start
  // wherever the source's keyframes are — so after a seek the picture and
  // the subtitles part company. Without a keyframe index, those players get
  // a conversion instead, which lands every segment exactly.
  if (aligned && exact && !bounds && details.videoCopy && burn == null) {
    details = { ...details, videoCopy: false };
  }
  // The player couldn't decode the remux: convert the picture instead.
  if (encode && details.videoCopy) {
    details = { ...details, videoCopy: false };
    bounds = null;
  }
  const s = {
    sid,
    dir,
    url,
    audio: Math.max(0, Math.min(Number(audio) || 0, Math.max(0, details.audioTracks.length - 1))),
    burn,
    plan: details,
    accel: hw.active(),
    nseg: bounds ? bounds.length : (exact ? Math.ceil(exact / SEG) : 0),
    // Segment start times when cut at the source's keyframes; null for the
    // fixed grid of SEG-second segments.
    bounds,
    done: new Set(),
    // No duration: a live channel (IPTV). Played as rolling live HLS — no
    // seeking, never paused or restarted somewhere else.
    live: !exact,
    durationExact: exact,
    child: null,
    startSeg: 0,
    lastReq: 0,
    seenTop: -1,
    lastProgress: Date.now(),
    paused: false,
    finished: false,
    failed: false,
    dead: false,
    restarts: 0,
    timers: {},
  };
  sessions.set(sid, s);
  heartbeat(sid);

  const first = s.nseg ? Math.min(segAt(s, Math.max(0, seek)), s.nseg - 1) : 0;
  // Where the player should begin. Without saying so in the playlist,
  // Safari fetched segment 0 first and only then seeked: ffmpeg was
  // restarted at 0 and then back at the resume point before anything showed.
  s.startAt = !s.live && seek > 0 ? Math.min(seek, Math.max(0, exact - 1)) : 0;
  s.lastReq = first;
  await launchAt(s, first);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (s.dead) {
      throw new Error(s.lastError
        ? `ffmpeg couldn't convert this file: ${String(s.lastError).slice(0, 160)}`
        : 'The conversion stopped before it started.');
    }
    refreshDone(s);
    if (segReady(s, first) || s.finished) {
      const copying = details.videoCopy && burn == null;
      return {
        sid,
        url: `/hls/${sid}/index.m3u8`,
        // The playlist covers the whole film, so positions are film time.
        offset: 0,
        duration: details.duration || null,
        audioTracks: details.audioTracks,
        audio: s.audio,
        subtitleTracks: details.subtitleTracks,
        burn,
        videoCopy: copying,
        videoCodec: details.videoCodec,
        audioCodec: details.audioCodec,
        hdr: details.hdr,
        live: s.live,
        alignment: bounds ? 'keyframes' : 'grid',
        encoder: copying ? 'copy' : s.accel.name,
        toneMapped: Boolean(details.hdr && !copying && toneMapperFor(s)),
      };
    }
    await new Promise((resolve) => { setTimeout(resolve, 150); });
  }

  stop(sid);
  throw new Error('ffmpeg produced nothing in time. The source may be unreachable or too slow.');
}

const keyframeCache = new Map();

function keyframeIndex(url) {
  const cached = keyframeCache.get(url);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.found;
  const found = keyframes.matroska(url);
  if (keyframeCache.size > 200) keyframeCache.clear();
  keyframeCache.set(url, { at: Date.now(), found });
  found.then((value) => { if (!value) keyframeCache.delete(url); });
  return found;
}

function toneMapperFor(s) {
  return s.accel.name === 'nvenc' || s.accel.name === 'vaapi'
    ? toneMapper(s.accel.name) : (toneMapper('software') === 'cpu' ? 'cpu' : null);
}

export function heartbeat(sid) {
  const s = sessions.get(sid);
  if (!s) return false;
  clearTimeout(s.timers.idle);
  s.timers.idle = setTimeout(() => stop(sid), HEARTBEAT_MS);
  return true;
}

export function get(sid) {
  return sessions.get(sid) || null;
}

export function stop(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  s.dead = true;
  clearTimeout(s.timers.idle);
  kill(s);
  sessions.delete(sid);
  fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {});
}

export function stopAll() {
  for (const sid of [...sessions.keys()]) stop(sid);
}

// The whole film as a VOD playlist, listed before any of it exists. Without a
// known duration (rare: a live source) it falls back to ffmpeg's own growing
// playlist.
export function readPlaylist(sid) {
  const s = sessions.get(sid);
  if (!s) return null;

  if (!s.nseg) {
    try {
      const raw = fs.readFileSync(path.join(s.dir, 'ffmpeg.m3u8'), 'utf8');
      return raw.replace(/^(seg\d+\.ts)$/gm, `/hls/${sid}/$1`);
    } catch {
      return null;
    }
  }

  const lengths = [];
  for (let i = 0; i < s.nseg; i += 1) {
    const end = i + 1 < s.nseg ? segStart(s, i + 1) : s.durationExact;
    lengths.push(Math.max(0.001, end - segStart(s, i)));
  }
  const target = s.bounds ? Math.ceil(Math.max(...lengths)) : SEG + 1;
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  // Only true when every segment starts on a keyframe: always for a
  // conversion and a keyframe-cut remux, never for a remux on the grid.
  if (!copying(s) || s.bounds) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  if (s.startAt > 0) lines.push(`#EXT-X-START:TIME-OFFSET=${s.startAt.toFixed(3)},PRECISE=YES`);
  lengths.forEach((len, i) => lines.push(`#EXTINF:${len.toFixed(3)},`, `/hls/${sid}/seg${i}.ts`));
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

/**
 * Path to segment `file`, producing it first if need be. Seeks land here: a
 * request outside what the running ffmpeg is about to make restarts it at
 * exactly that segment.
 *
 * @returns {Promise<{ path?: string, status?: number, error?: string }>}
 */
export async function segment(sid, file) {
  const s = sessions.get(sid);
  if (!s) return { status: 404, error: 'That conversion has ended.' };
  const match = /^seg(\d+)\.ts$/.exec(file);
  if (!match) return { status: 404, error: 'No such segment.' };
  const n = Number(match[1]);
  if (s.nseg && n >= s.nseg) return { status: 404, error: 'Past the end of the film.' };

  heartbeat(sid);
  s.lastReq = n;
  thaw(s);

  const target = path.join(s.dir, file);
  refreshDone(s);
  if (segReady(s, n)) return { path: target };

  const lookahead = (copying(s) ? COPY_LOOKAHEAD_SEGS : LOOKAHEAD_SEGS) * SEG;
  if (s.live) {
    // Live only ever moves forward; a stopped encoder picks up numbering
    // where it left off, at "now".
    if (!running(s)) launch(s, highestSeg(s) + 1);
  } else if (n < s.startSeg || segStart(s, n) > segStart(s, highestSeg(s)) + lookahead
    || (!running(s) && !s.finished)) {
    await launchAt(s, n);
  } else if (s.finished) {
    // ffmpeg reached the end but this one is missing (deleted, or a gap).
    await launchAt(s, n);
  }

  const deadline = Date.now() + SEGMENT_WAIT_MS;
  while (Date.now() < deadline) {
    if (s.dead) return { status: 410, error: 'The conversion failed.' };
    refreshDone(s);
    if (segReady(s, n)) return { path: target };
    if (s.finished && !segReady(s, n)) {
      return { status: 404, error: 'Past the end of the film.' };
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return { status: 504, error: 'The conversion is not keeping up.' };
}

/**
 * A hint from the player while the seek bar is being dragged: the viewer is
 * about to land around `seconds`. If that isn't converted already (or about
 * to be), start ffmpeg there now, so by the time they let go the first
 * segment is ready or nearly. Cheap to ignore when it's already covered.
 */
export function prepare(sid, seconds) {
  const s = sessions.get(sid);
  if (!s || !Number.isFinite(seconds)) return false;
  heartbeat(sid);
  const n = Math.max(0, segAt(s, seconds));
  if (s.nseg && n >= s.nseg) return false;
  refreshDone(s);
  if (segReady(s, n)) return true;
  const lookahead = (copying(s) ? COPY_LOOKAHEAD_SEGS : LOOKAHEAD_SEGS) * SEG;
  const covered = n >= s.startSeg && segStart(s, n) <= segStart(s, highestSeg(s)) + lookahead && running(s);
  if (!covered) {
    s.lastReq = n;
    thaw(s);
    launchAt(s, n);
  }
  return true;
}

// ------------------------------------------------------------- subtitles

const subJobs = new Map();

/**
 * A text subtitle inside the file, as WebVTT. Converted once and cached.
 * Matroska interleaves subtitles through the whole file, so the first time
 * means reading all of it — seconds on a fast link, longer on a slow one.
 *
 * @returns {Promise<string>} path to the .vtt file
 */
export async function subtitle(url, stream) {
  if (!isAvailable()) throw new Error('ffmpeg is not in this build.');
  const details = await inspect(url);
  const track = details?.subtitleTracks.find((t) => t.stream === stream);
  if (!track) throw new Error('No such subtitle track.');
  if (!track.render) throw new Error('This subtitle format can’t be shown in a browser.');
  const pgs = track.render === 'pgs';

  const key = crypto.createHash('sha1').update(`${url}#${stream}`).digest('hex');
  // PGS is copied out as-is (.sup) and drawn by the player; nothing is
  // decoded or encoded on the server.
  const out = path.join(SUB_ROOT, `${key}.${pgs ? 'sup' : 'vtt'}`);
  if (fs.existsSync(out)) return out;
  if (subJobs.has(key)) return subJobs.get(key);

  const job = (async () => {
    await fsp.mkdir(SUB_ROOT, { recursive: true });
    const tmp = `${out}.part`;
    const child = spawn('ffmpeg', [
      ...INPUT_FLAGS, '-y', '-i', url,
      '-map', `0:${stream}`, '-vn', '-an',
      ...(pgs ? ['-c:s', 'copy', '-f', 'sup'] : ['-c:s', 'webvtt', '-f', 'webvtt']),
      tmp,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
    const [code] = await once(child, 'close');
    clearTimeout(timer);
    if (code !== 0) throw new Error(`Subtitle extraction failed: ${err.trim().slice(-200)}`);
    await fsp.rename(tmp, out);
    return out;
  })();
  subJobs.set(key, job);
  try {
    return await job;
  } finally {
    subJobs.delete(key);
  }
}

// ------------------------------------------------- subtitles, progressively
//
// Reading a whole Matroska file for one subtitle track took as long as the
// download did, and the subtitles were blank until it finished. Instead the
// track is read in two passes that run together: from where the viewer is to
// the end, and from the start up to there. Cues are handed out as they are
// found, so the ones on screen now arrive within seconds; the player asks
// again until the job says it's complete. The finished track is cached like
// before, and later requests get it whole at once.

const liveSubs = new Map();
const LIVE_SUB_TTL_MS = 30 * 60_000;

function cueBlocks(text) {
  return String(text || '').replace(/\r/g, '').split(/\n{2,}/)
    .map((b) => b.trim()).filter((b) => b.includes('-->'));
}

function subPass(url, stream, out, { from = 0, until = null } = {}) {
  const child = spawn('ffmpeg', [
    ...INPUT_FLAGS, '-y',
    ...(from > 0 ? ['-ss', String(from)] : []),
    '-i', url,
    ...(until != null ? ['-t', String(until)] : []),
    '-map', `0:${stream}`, '-vn', '-an',
    ...(from > 0 ? ['-output_ts_offset', String(from)] : []),
    '-c:s', 'webvtt', '-flush_packets', '1', '-f', 'webvtt', out,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-400); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
  const done = once(child, 'close').then(([code]) => {
    clearTimeout(timer);
    if (code !== 0) throw new Error(`Subtitle extraction failed: ${err.trim().slice(-200)}`);
  });
  return { out, child, done };
}

function mergeCues(paths) {
  const seen = new Set();
  const cues = [];
  for (const file of paths) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const block of cueBlocks(text)) {
      if (seen.has(block)) continue;
      seen.add(block);
      cues.push(block);
    }
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

/**
 * A text subtitle track inside the file, as far as it has been read.
 *
 * @returns {Promise<{ text: string, complete: boolean }>}
 */
export async function subtitleSoFar(url, stream, from = 0, { seeked = false } = {}) {
  if (!isAvailable()) throw new Error('ffmpeg is not in this build.');
  const details = await inspect(url);
  const track = details?.subtitleTracks.find((t) => t.stream === stream);
  if (!track) throw new Error('No such subtitle track.');
  if (track.render !== 'text') throw new Error('Only text subtitles load progressively.');

  const key = crypto.createHash('sha1').update(`${url}#${stream}`).digest('hex');
  const final = path.join(SUB_ROOT, `${key}.vtt`);
  if (fs.existsSync(final)) return { text: fs.readFileSync(final, 'utf8'), complete: true };

  let job = liveSubs.get(key);
  if (!job) {
    await fsp.mkdir(SUB_ROOT, { recursive: true });
    const start = Math.max(0, Math.floor(Number(from) || 0) - 10);
    const passes = [{ ...subPass(url, stream, path.join(SUB_ROOT, `${key}.a.part`), { from: start }), from: start }];
    // Overlap a little, so a cue straddling the join isn't lost.
    if (start > 0) passes.push({ ...subPass(url, stream, path.join(SUB_ROOT, `${key}.b.part`), { until: start + 15 }), from: 0 });
    job = { key, url, stream, passes, extra: [], complete: false, error: null, at: Date.now() };
    liveSubs.set(key, job);
    Promise.all(passes.map((p) => p.done)).then(async () => {
      // Earlier pass first, so cues stay in time order.
      await fsp.writeFile(`${final}.part`, sortCues(mergeCues(passes.map((p) => p.out).reverse())));
      await fsp.rename(`${final}.part`, final);
      job.complete = true;
      for (const p of job.extra) { p.child.kill('SIGKILL'); fsp.rm(p.out, { force: true }).catch(() => {}); }
    }).catch((err) => { job.error = err; for (const p of passes) p.child.kill('SIGKILL'); })
      .finally(() => {
        setTimeout(() => {
          liveSubs.delete(key);
          for (const p of passes) fsp.rm(p.out, { force: true }).catch(() => {});
        }, job.complete ? 5000 : LIVE_SUB_TTL_MS).unref();
      });
  }
  if (job.complete && fs.existsSync(final)) return { text: fs.readFileSync(final, 'utf8'), complete: true };
  if (job.error) { liveSubs.delete(key); throw job.error; }
  if (seeked) seekPass(job, Math.max(0, Math.floor(Number(from) || 0) - 10));
  const all = [...job.passes, ...job.extra].sort((a, b) => a.from - b.from).map((p) => p.out);
  return { text: sortCues(mergeCues(all)), complete: false };
}

// The time a pass has read up to: the start of the last cue in its file.
function readTo(p) {
  let text = '';
  try { text = fs.readFileSync(p.out, 'utf8'); } catch { return p.from; }
  const last = cueBlocks(text).pop();
  const match = last && /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/m.exec(last);
  if (!match) return p.from;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// A seek to somewhere no pass has reached yet: read from there too, so the
// lines for where the viewer now is arrive in seconds rather than once the
// other passes get that far. At most three of these at a time.
function seekPass(job, from) {
  const covered = [...job.passes, ...job.extra].some((p) => from >= p.from && from <= readTo(p) + 30);
  if (covered) return;
  const n = (job.seq = (job.seq || 0) + 1);
  const pass = { ...subPass(job.url, job.stream, path.join(SUB_ROOT, `${job.key}.s${n}.part`), { from }), from };
  pass.done.catch(() => {});
  job.extra.push(pass);
  while (job.extra.length > 3) {
    const old = job.extra.shift();
    old.child.kill('SIGKILL');
    fsp.rm(old.out, { force: true }).catch(() => {});
  }
}

// Passes overlap and finish out of order; keep cues in time order.
function sortCues(vtt) {
  const time = (block) => {
    const match = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/m.exec(block.split('\n').find((l) => l.includes('-->')) || '');
    return match ? Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  };
  const blocks = cueBlocks(vtt).sort((a, b) => time(a) - time(b));
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}
