// Hardware-accelerated encoding, chosen the way a media server has to choose
// it: by trying it.
//
// This is modelled on how Plex and Jellyfin handle transcoding — detect what
// the machine can do, prefer the GPU, fall back to the CPU when it fails —
// but it is not Plex's transcoder, which is a proprietary fork of ffmpeg with
// its own decoders. What follows is ordinary ffmpeg driven the same way.
//
// The important lesson is in what this container reports: `ffmpeg -encoders`
// lists h264_nvenc, h264_qsv and h264_vaapi, and not one of them works,
// because there is no /dev/dri and no NVIDIA driver. The encoders are compiled
// in; the hardware is absent. Trusting that list would mean picking NVENC on a
// machine with no GPU and failing on every playback.
//
// So each candidate is put through a real one-frame encode at startup. It
// costs a few hundred milliseconds once and it is the only answer that can be
// trusted.
//
// Worth knowing: none of this matters for the common case. A release that is
// already H.264 has its video copied, and copying is free whatever silicon is
// present. Hardware encoding matters for HEVC, AV1 and 4K — the files that
// pin a CPU at 100% and still stutter.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';

const PROBE_TIMEOUT_MS = 10000;

// Best first. NVENC and QSV have dedicated encode silicon; VAAPI covers Intel
// and AMD on Linux; VideoToolbox is Apple; AMF is AMD on Windows; v4l2m2m is
// the Raspberry Pi and similar.
const CANDIDATES = [
  {
    name: 'nvenc',
    label: 'NVIDIA NVENC',
    encoder: 'h264_nvenc',
    // Decode on the GPU too, so frames never cross the bus.
    decode: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
    encode: (quality) => [
      '-c:v', 'h264_nvenc',
      '-preset', 'p4',
      '-tune', 'hq',
      '-rc', 'vbr',
      '-cq', String(quality),
      '-profile:v', 'high',
      '-forced-idr', '1',
    ],
    // Scaling happens on the GPU when the frames are already there.
    scaleFilter: (w) => `scale_cuda=${w}:-2`,
    probe: ['-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.1', '-c:v', 'h264_nvenc', '-f', 'null', '-'],
  },
  {
    name: 'qsv',
    label: 'Intel Quick Sync',
    encoder: 'h264_qsv',
    decode: ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'],
    encode: (quality) => [
      '-c:v', 'h264_qsv',
      '-preset', 'veryfast',
      '-global_quality', String(quality),
      '-profile:v', 'high',
    ],
    scaleFilter: (w) => `scale_qsv=${w}:-1`,
    requires: () => fs.existsSync('/dev/dri/renderD128'),
    probe: ['-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.1', '-c:v', 'h264_qsv', '-f', 'null', '-'],
  },
  {
    name: 'vaapi',
    label: 'VAAPI (Intel/AMD)',
    encoder: 'h264_vaapi',
    // VAAPI needs the device named up front, and frames uploaded to it.
    decode: ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128',
      '-hwaccel_output_format', 'vaapi'],
    encode: (quality) => [
      '-c:v', 'h264_vaapi',
      '-qp', String(quality),
      '-profile:v', 'high',
    ],
    scaleFilter: (w) => `scale_vaapi=${w}:-2`,
    // Frames decoded on the CPU have to be uploaded before a VAAPI encoder
    // will take them.
    uploadFilter: 'format=nv12|vaapi,hwupload',
    requires: () => fs.existsSync('/dev/dri/renderD128'),
    probe: ['-vaapi_device', '/dev/dri/renderD128', '-f', 'lavfi',
      '-i', 'color=black:s=320x240:d=0.1', '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi', '-f', 'null', '-'],
  },
  {
    name: 'videotoolbox',
    label: 'Apple VideoToolbox',
    encoder: 'h264_videotoolbox',
    decode: ['-hwaccel', 'videotoolbox'],
    encode: () => [
      '-c:v', 'h264_videotoolbox',
      '-b:v', process.env.TRANSCODE_BITRATE || '8M',
      '-profile:v', 'high',
    ],
    probe: ['-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.1',
      '-c:v', 'h264_videotoolbox', '-f', 'null', '-'],
  },
  {
    name: 'amf',
    label: 'AMD AMF',
    encoder: 'h264_amf',
    decode: [],
    encode: (quality) => [
      '-c:v', 'h264_amf',
      '-quality', 'speed',
      '-rc', 'cqp',
      '-qp_i', String(quality),
      '-qp_p', String(quality),
    ],
    probe: ['-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.1', '-c:v', 'h264_amf', '-f', 'null', '-'],
  },
  {
    name: 'v4l2m2m',
    label: 'V4L2 (Raspberry Pi and similar)',
    encoder: 'h264_v4l2m2m',
    decode: [],
    encode: () => [
      '-c:v', 'h264_v4l2m2m',
      '-b:v', process.env.TRANSCODE_BITRATE || '6M',
    ],
    requires: () => fs.existsSync('/dev/video11') || fs.existsSync('/dev/video10'),
    probe: ['-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.1', '-c:v', 'h264_v4l2m2m', '-f', 'null', '-'],
  },
];

// Always available, and the thing everything falls back to.
export const SOFTWARE = {
  name: 'software',
  label: 'CPU (libx264)',
  encoder: 'libx264',
  decode: [],
  encode: (quality, preset) => [
    '-c:v', 'libx264',
    '-preset', preset || 'veryfast',
    '-crf', String(quality),
    '-profile:v', 'high',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
  ],
  scaleFilter: (w) => `scale=${w}:-2`,
};

let chosen = null;

export function active() {
  return chosen || SOFTWARE;
}

// Run one real encode per candidate. A candidate that cannot produce a single
// frame here is not going to manage a film.
export async function detect() {
  const requested = (process.env.TRANSCODE_HWACCEL || 'auto').toLowerCase();

  if (requested === 'none' || requested === 'off' || requested === 'software') {
    chosen = SOFTWARE;
    return chosen;
  }

  const shortlist = requested === 'auto'
    ? CANDIDATES
    : CANDIDATES.filter((c) => c.name === requested);

  if (requested !== 'auto' && !shortlist.length) {
    console.error(`Unknown TRANSCODE_HWACCEL "${requested}" — using the CPU.`);
    chosen = SOFTWARE;
    return chosen;
  }

  for (const candidate of shortlist) {
    // A cheap check first, so a machine with no render node doesn't spend a
    // second learning that four times over.
    if (candidate.requires && !candidate.requires()) continue;
    if (await works(candidate)) {
      chosen = candidate;
      console.log(`Hardware encoding: ${candidate.label}`);
      return chosen;
    }
  }

  chosen = SOFTWARE;
  if (requested !== 'auto') {
    console.error(`TRANSCODE_HWACCEL=${requested} did not work here — using the CPU.`);
  } else {
    console.log('Hardware encoding: none available, using the CPU');
  }
  return chosen;
}

function works(candidate) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...candidate.probe], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(false);
    }, PROBE_TIMEOUT_MS);

    once(child, 'close').then(([code]) => {
      clearTimeout(timer);
      resolve(code === 0);
    }).catch(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// A GPU that fails mid-film — a driver reset, a device busy, a stream it
// can't handle — should cost one restart, not every playback from then on.
export function demote(reason) {
  if (chosen === SOFTWARE || !chosen) return false;
  console.error(`${chosen.label} failed (${reason}) — falling back to the CPU for the rest of this run.`);
  chosen = SOFTWARE;
  return true;
}

export function describe() {
  const current = active();
  return { name: current.name, label: current.label, encoder: current.encoder };
}
