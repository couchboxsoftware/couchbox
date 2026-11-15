// FFmpeg helpers: probing, frame grabs, one-time conversion, subtitle conversion.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let ffmpegPath = require('ffmpeg-static');
if (ffmpegPath) ffmpegPath = ffmpegPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);

const PLAY_CONTAINERS = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov']);
const PLAY_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'hevc']);
const PLAY_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_f32le']);

function run(args, onStderr) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 200000) err = err.slice(-100000);
      if (onStderr) onStderr(s);
    });
    p.on('error', () => resolve({ code: -1, err }));
    p.on('close', (code) => resolve({ code, err }));
  });
}

function hms(h, m, s) {
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
}

async function probe(file) {
  const { err } = await run(['-hide_banner', '-i', file]);
  const d = err.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const v = err.match(/Stream #\d+:\d+[^:]*: Video: (\w+)/);
  const res = err.match(/Stream #\d+:\d+[^:]*: Video: [^\n]*?, (\d{2,5})x(\d{2,5})/);
  const audio = [...err.matchAll(/Stream #\d+:\d+[^:]*: Audio: (\w+)/g)].map((m) => m[1]);
  const duration = d ? hms(d[1], d[2], d[3]) : 0;
  const videoCodec = v ? v[1] : null;
  // An unfinished download ("x.mkv.crdownload") is judged by the name it will have.
  const ext = path.extname(file.replace(/\.(crdownload|part|!qb|!ut|download|partial)$/i, '')).toLowerCase();
  const audioOk = audio.length === 0 || PLAY_AUDIO.has(audio[0]);
  const playable = PLAY_CONTAINERS.has(ext) && !!videoCodec && PLAY_VIDEO.has(videoCodec) && audioOk;
  const width = res ? parseInt(res[1], 10) : 0;
  const height = res ? parseInt(res[2], 10) : 0;
  return { duration, videoCodec, audioCodec: audio[0] || null, playable, width, height };
}

// Every stream in a file, for the converter: [{ type: 'video'|'audio'|'subtitle'|'attachment'|'data',
// codec, channels }], plus the length. Reads the header only, like probe().
async function streams(file) {
  const { err } = await run(['-hide_banner', '-i', file]);
  const d = err.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const list = [...err.matchAll(/Stream #\d+:\d+[^:]*: (Video|Audio|Subtitle|Attachment|Data): (\w+)([^\n]*)/g)].map((m) => {
    const rest = m[3];
    const ch = rest.match(/, (mono|stereo|(\d+) channels|(\d+)\.(\d+)(?:\(\w+\))?)\b/);
    let channels = 0;
    if (ch) channels = ch[1] === 'mono' ? 1 : ch[1] === 'stereo' ? 2 : ch[2] ? +ch[2] : +ch[3] + +ch[4];
    return { type: m[1].toLowerCase(), codec: m[2], channels, attachedPic: /attached pic/.test(rest) };
  });
  return { duration: d ? hms(d[1], d[2], d[3]) : 0, streams: list };
}

// What a file's header says, for the download checks: its length, picture height, and (for
// MKVs whose tracks carry statistics tags) how many bytes its tracks hold in total.
async function header(file) {
  const { err } = await run(['-hide_banner', '-i', file]);
  const d = err.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const res = err.match(/Stream #\d+:\d+[^:]*: Video: [^\n]*?, (\d{2,5})x(\d{2,5})/);
  const bytes = [...err.matchAll(/^\s*NUMBER_OF_BYTES(?:-\w+)?\s*:\s*(\d+)/gm)].reduce((n, m) => n + Number(m[1]), 0);
  return {
    duration: d ? hms(d[1], d[2], d[3]) : 0,
    height: res ? parseInt(res[2], 10) : 0,
    video: /Stream #\d+:\d+[^:]*: Video:/.test(err),
    bytes,
  };
}

async function grabFrame(file, atSeconds, outFile, width = 480) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const { code } = await run([
    '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, atSeconds)), '-i', file,
    '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-y', outFile,
  ]);
  return code === 0 && fs.existsSync(outFile);
}

// Runs one FFmpeg conversion (args from converter.js) at below-normal priority, so playback
// stays smooth. onProgress gets 0..1 from FFmpeg's "time=" lines.
function convertRun(args, duration, onProgress) {
  let proc;
  let killed = false;
  const promise = new Promise((resolve) => {
    proc = spawn(ffmpegPath, args, { windowsHide: true });
    try {
      require('os').setPriority(proc.pid, require('os').constants.priority.PRIORITY_BELOW_NORMAL);
    } catch (_) {}
    let tail = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      const m = s.match(/time=(\d+):(\d+):([\d.]+)/);
      if (m && duration) onProgress(Math.min(0.999, hms(m[1], m[2], m[3]) / duration));
    });
    proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    proc.on('close', (code) => resolve({ ok: code === 0 && !killed, killed, error: code === 0 ? '' : tail.trim().split('\n').slice(-2).join(' ') }));
  });
  return { promise, cancel: () => { killed = true; if (proc) proc.kill(); } };
}

// Decodes a few seconds from `at` (video and audio) and reports whether it went cleanly and
// actually produced pictures (asking for a point past the end of a cut-off file "succeeds" with
// nothing decoded).
// `strict` (for checking Couchbox's own conversions) also fails on any decoding error. Without it
// (for checking downloads), a few errors are fine: older files, like DivX AVIs, report some when
// playback starts part way in, and still play.
async function decodeCheck(file, at, strict = true) {
  const { code, err } = await run(['-hide_banner', ...(strict ? ['-xerror'] : []), '-ss', String(Math.max(0, at)), '-i', file, '-t', '4', '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-']);
  const frames = [...err.matchAll(/frame=\s*(\d+)/g)].map((m) => Number(m[1]));
  return code === 0 && frames.length > 0 && frames[frames.length - 1] > 0;
}

function readText(file) {
  const buf = fs.readFileSync(file);
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1');
  return text.replace(/^﻿/, '');
}

function subtitleToVtt(file) {
  const text = readText(file).replace(/\r\n?/g, '\n');
  if (path.extname(file).toLowerCase() === '.vtt') return text;
  const body = text
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/<\/?font[^>]*>/gi, '')
    .replace(/\{\\[^}]*\}/g, '');
  return 'WEBVTT\n\n' + body;
}

module.exports = { probe, streams, header, grabFrame, convertRun, decodeCheck, subtitleToVtt, ffmpegPath, PLAY_CONTAINERS, PLAY_VIDEO, PLAY_AUDIO };
