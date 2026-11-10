'use strict';
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const WHISPER = process.env.WHISPER_BIN || ''; // เช่น "whisper" (openai-whisper) ถ้าไม่ตั้งค่าจะข้ามซับไตเติล
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'small';
const SUB_FONT = process.env.SUBTITLE_FONT || 'Noto Sans Thai';
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(__dirname, '..', 'music');

// สไตล์งาน: ปรับความแรงของเอฟเฟกต์ซูม และเพลงประกอบ (ไฟล์อยู่ในโฟลเดอร์ music/)
const STYLES = {
  'คลิปปักตะกร้า': { zoom: 0.06, music: 'basket.mp3' },
  'รีวิวสินค้า': { zoom: 0.04, music: 'review.mp3' },
  'แกะกล่องสินค้า': { zoom: 0.05, music: 'unbox.mp3' },
  'ก่อน-หลังใช้งาน': { zoom: 0.03, music: 'beforeafter.mp3' },
};

// รันโปรแกรมแบบไม่ผ่าน shell (ต่างจาก system() ใน C ที่เสี่ยง command injection)
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 400000) err = err.slice(-200000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} exited with code ${code}: ${err.slice(-600)}`));
    });
  });
}

async function probe(file) {
  const { out } = await run(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'json', file,
  ]);
  const j = JSON.parse(out);
  const types = (j.streams || []).map((s) => s.codec_type);
  return {
    duration: parseFloat(j.format && j.format.duration) || 0,
    hasVideo: types.includes('video'),
    hasAudio: types.includes('audio'),
  };
}

// หาช่วงเสียงเงียบ -> คืนช่วงที่ "เก็บไว้" (null = ไม่ต้องตัด)
async function keepSegments(file, duration) {
  const { err } = await run(FFMPEG, [
    '-hide_banner', '-nostats', '-i', file,
    '-vn', '-af', 'silencedetect=noise=-35dB:d=0.6', '-f', 'null', '-',
  ]);
  const silences = [];
  let start = null;
  for (const line of err.split('\n')) {
    let m = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) start = Math.max(0, parseFloat(m[1]));
    m = line.match(/silence_end:\s*([\d.]+)/);
    if (m && start !== null) {
      silences.push([start, parseFloat(m[1])]);
      start = null;
    }
  }
  if (start !== null) silences.push([start, duration]);
  if (!silences.length) return null;

  const PAD = 0.15; // เว้นขอบเล็กน้อยไม่ให้คำพูดโดนตัดห้วน
  const keep = [];
  let cursor = 0;
  for (const [s, e] of silences) {
    if (s - cursor > 0.3) keep.push([Math.max(0, cursor - PAD), Math.min(duration, s + PAD)]);
    cursor = e;
  }
  if (duration - cursor > 0.3) keep.push([Math.max(0, cursor - PAD), duration]);

  // รวมช่วงที่ซ้อนกัน
  const merged = [];
  for (const seg of keep) {
    const last = merged[merged.length - 1];
    if (last && seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
    else merged.push([...seg]);
  }
  const kept = merged.reduce((a, [s, e]) => a + (e - s), 0);
  if (!merged.length || kept >= duration - 0.2) return null;
  return merged;
}

// ตัดเสียงเงียบ + ครอปเป็น 9:16 + ซูมเข้า-ออก ในรอบเดียว
async function renderClip(input, output, style) {
  const info = await probe(input);
  if (!info.hasVideo) throw new Error('ไฟล์นี้ไม่มีภาพวิดีโอ');
  const segs = info.hasAudio ? await keepSegments(input, info.duration) : null;
  const expr = segs ? segs.map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join('+') : null;

  const z = style.zoom;
  const vf = [
    'fps=30',
    expr ? `select='${expr}'` : null,
    expr ? 'setpts=N/(30*TB)' : null,
    'scale=1080:1920:force_original_aspect_ratio=increase',
    'crop=1080:1920',
    `scale=w='2*trunc(1080*(1+${z}*abs(sin(t*0.6)))/2)':h=-2:eval=frame`,
    'crop=1080:1920',
    'setsar=1',
    'format=yuv420p',
  ].filter(Boolean).join(',');

  const args = ['-y', '-hide_banner', '-i', input];
  let af;
  if (info.hasAudio) {
    af = [
      expr ? `aselect='${expr}'` : null,
      expr ? 'asetpts=N/SR/TB' : null,
      'aresample=44100',
      'aformat=channel_layouts=stereo',
    ].filter(Boolean).join(',');
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  }
  args.push('-filter_complex', `[0:v]${vf}[v]` + (info.hasAudio ? `;[0:a]${af}[a]` : ''));
  args.push('-map', '[v]', '-map', info.hasAudio ? '[a]' : '1:a', '-shortest');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', output,
  );
  await run(FFMPEG, args);
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * @param {object} o
 * @param {string[]} o.inputs  ไฟล์วิดีโอตามลำดับที่ลูกค้าอัปโหลด
 * @param {string} o.styleName ชื่อสไตล์ (ต้องอยู่ใน STYLES)
 * @param {string} o.workDir   โฟลเดอร์ทำงานชั่วคราว
 * @param {string} o.outFile   ไฟล์ผลลัพธ์
 * @param {(stage:string, percent:number)=>void} o.onProgress
 * @returns {Promise<{warnings:string[]}>}
 */
async function processJob({ inputs, styleName, workDir, outFile, onProgress }) {
  const style = STYLES[styleName];
  const warnings = [];
  const parts = [];

  // 1) ต่อคลิป: ตัดเสียงเงียบ + 9:16 + ซูม (0-60%)
  for (let i = 0; i < inputs.length; i++) {
    onProgress('clips', Math.round((i / inputs.length) * 60));
    const part = path.join(workDir, `part_${i}.mp4`);
    await renderClip(inputs[i], part, style);
    parts.push(part);
  }

  // 2) รวมคลิป (60-70%)
  onProgress('merge', 60);
  const merged = path.join(workDir, 'merged.mp4');
  if (parts.length === 1) {
    await fs.copyFile(parts[0], merged);
  } else {
    const list = parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    await fs.writeFile(path.join(workDir, 'list.txt'), list);
    await run(FFMPEG, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0',
      '-i', path.join(workDir, 'list.txt'), '-c', 'copy', merged]);
  }

  // 3) ซับไตเติลภาษาไทย (70-85%) - ข้ามถ้าไม่ได้ตั้งค่า WHISPER_BIN
  let srt = null;
  if (WHISPER) {
    onProgress('subtitle', 70);
    try {
      await run(WHISPER, [merged, '--language', 'th', '--model', WHISPER_MODEL,
        '--output_format', 'srt', '--output_dir', workDir]);
      const cand = path.join(workDir, 'merged.srt');
      if (await fileExists(cand)) srt = 'merged.srt';
    } catch (e) {
      warnings.push('สร้างซับไตเติลไม่สำเร็จ: ' + e.message.slice(0, 200));
    }
  } else {
    warnings.push('ข้ามซับไตเติล (ยังไม่ได้ตั้งค่า WHISPER_BIN)');
  }

  // 4) ใส่ซับ + เพลงประกอบ แล้วเข้ารหัสไฟล์สุดท้าย (85-100%)
  onProgress('finalize', 85);
  const musicPath = path.join(MUSIC_DIR, style.music);
  const hasMusic = await fileExists(musicPath);
  if (!hasMusic) warnings.push(`ข้ามเพลงประกอบ (ไม่พบ ${style.music})`);

  const args = ['-y', '-hide_banner', '-i', 'merged.mp4'];
  if (hasMusic) args.push('-stream_loop', '-1', '-i', musicPath);

  const vFilter = srt
    ? `[0:v]subtitles=${srt}:force_style='FontName=${SUB_FONT},FontSize=16,Alignment=2,MarginV=220,Outline=2,Bold=1'[v]`
    : '[0:v]null[v]';
  const aFilter = hasMusic
    ? '[1:a]volume=0.15[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]'
    : '[0:a]anull[a]';
  args.push('-filter_complex', `${vFilter};${aFilter}`, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', path.resolve(outFile));
  await run(FFMPEG, args, { cwd: workDir });

  onProgress('done', 100);
  return { warnings };
}

module.exports = { processJob, STYLES };
