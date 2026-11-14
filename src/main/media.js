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
  const audio = [...err.matchAll(/Stream #\d+:\d+[^:]*: Audio: (\w+)/g)].map((m) => m[1]);
  const duration = d ? hms(d[1], d[2], d[3]) : 0;
  const videoCodec = v ? v[1] : null;
  const ext = path.extname(file).toLowerCase();
  const audioOk = audio.length === 0 || PLAY_AUDIO.has(audio[0]);
  const playable = PLAY_CONTAINERS.has(ext) && !!videoCodec && PLAY_VIDEO.has(videoCodec) && audioOk;
  return { duration, videoCodec, audioCodec: audio[0] || null, playable };
}

async function grabFrame(file, atSeconds, outFile, width = 480) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const { code } = await run([
    '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, atSeconds)), '-i', file,
    '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-y', outFile,
  ]);
  return code === 0 && fs.existsSync(outFile);
}

// Converts a file into a browser-friendly MP4 (H.264 + AAC). Copies streams when it can.
function convert(file, outFile, info, onProgress) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = outFile + '.part.mp4';
  const args = ['-hide_banner', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-sn'];
  if (info.videoCodec === 'h264') args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p');
  if (info.audioCodec === 'aac') args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  args.push('-movflags', '+faststart', tmp);

  let proc;
  const promise = new Promise((resolve) => {
    proc = spawn(ffmpegPath, args, { windowsHide: true });
    proc.stderr.on('data', (d) => {
      const m = d.toString().match(/time=(\d+):(\d+):([\d.]+)/);
      if (m && info.duration) onProgress(Math.min(0.999, hms(m[1], m[2], m[3]) / info.duration));
    });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(tmp)) {
        fs.renameSync(tmp, outFile);
        resolve(true);
      } else {
        try { fs.unlinkSync(tmp); } catch (_) {}
        resolve(false);
      }
    });
  });
  return { promise, cancel: () => proc && proc.kill() };
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

module.exports = { probe, grabFrame, convert, subtitleToVtt, ffmpegPath };
