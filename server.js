'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { processJob, STYLES } = require('./lib/pipeline');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_FILES = 10;
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB, 10) || 500;
const KEEP_HOURS = parseInt(process.env.KEEP_HOURS, 10) || 24;

const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const RENDERS = path.join(DATA, 'renders');
const EXT_OK = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

const jobs = new Map(); // id -> job

// ---------- คิวงาน: ทำทีละงาน (FFmpeg กิน CPU หนัก) ----------
const queue = [];
let running = 0;
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 1;

function enqueue(job) {
  queue.push(job);
  pump();
}
function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    running++;
    runJob(job).finally(() => { running--; pump(); });
  }
}

async function runJob(job) {
  job.status = 'processing';
  const outFile = path.join(RENDERS, `${job.id}.mp4`);
  try {
    const { warnings } = await processJob({
      inputs: job.inputs,
      styleName: job.style,
      workDir: job.workDir,
      outFile,
      onProgress: (stage, percent) => { job.stage = stage; job.percent = percent; },
    });
    job.warnings = warnings;
    job.status = 'done';
    job.outputUrl = `${BASE_URL}/renders/${job.id}.mp4`;
  } catch (e) {
    console.error(`[job ${job.id}]`, e.message);
    job.status = 'error';
    job.error = 'ตัดต่อไม่สำเร็จ กรุณาตรวจสอบไฟล์วิดีโอแล้วลองใหม่';
  } finally {
    // ลบไฟล์ต้นฉบับและไฟล์ชั่วคราวทันที เก็บไว้แค่ผลลัพธ์
    await fs.rm(job.workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- Express ----------
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, req.workDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      req.fileSeq = (req.fileSeq || 0) + 1;
      // ตั้งชื่อเองทั้งหมด ไม่ใช้ชื่อไฟล์จากผู้ใช้ (กัน path traversal)
      cb(null, `in_${String(req.fileSeq).padStart(2, '0')}${EXT_OK.has(ext) ? ext : '.mp4'}`);
    },
  }),
  limits: { files: MAX_FILES, fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('NOT_VIDEO'));
  },
});

// สร้างโฟลเดอร์งานก่อน multer ทำงาน
async function prepareJob(req, res, next) {
  try {
    req.jobId = randomUUID();
    req.workDir = path.join(UPLOADS, req.jobId);
    await fs.mkdir(req.workDir, { recursive: true });
    next();
  } catch (e) { next(e); }
}

// POST /api/jobs  (multipart: files[] + style)
app.post('/api/jobs', prepareJob, upload.array('files', MAX_FILES), async (req, res) => {
  const fail = async (code, msg) => {
    await fs.rm(req.workDir, { recursive: true, force: true }).catch(() => {});
    return res.status(code).json({ error: msg });
  };
  const style = req.body && req.body.style;
  if (!style || !Object.prototype.hasOwnProperty.call(STYLES, style)) {
    return fail(400, 'สไตล์งานไม่ถูกต้อง');
  }
  if (!req.files || !req.files.length) return fail(400, 'ยังไม่ได้อัปโหลดคลิป');

  const job = {
    id: req.jobId,
    status: 'queued',
    stage: 'queued',
    percent: 0,
    style,
    workDir: req.workDir,
    inputs: req.files.map((f) => f.path),
    fileCount: req.files.length,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  enqueue(job);
  res.status(202).json({ id: job.id, status: job.status, statusUrl: `/api/jobs/${job.id}` });
});

// GET /api/jobs/:id  (ให้หน้าเว็บ poll ทุก 1-2 วินาที)
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'ไม่พบงานนี้' });
  const position = job.status === 'queued' ? queue.indexOf(job) + 1 : 0;
  res.json({
    id: job.id,
    status: job.status, // queued | processing | done | error
    stage: job.stage,   // clips | merge | subtitle | finalize | done
    percent: job.percent,
    queuePosition: position,
    style: job.style,
    fileCount: job.fileCount,
    outputUrl: job.outputUrl || null,
    warnings: job.warnings || [],
    error: job.error || null,
  });
});

// ไฟล์ผลลัพธ์ (?download=1 เพื่อบังคับดาวน์โหลด)
app.get('/renders/:file', (req, res) => {
  const m = /^([0-9a-f-]{36})\.mp4$/.exec(req.params.file);
  if (!m) return res.sendStatus(404);
  const file = path.join(RENDERS, req.params.file);
  const opts = req.query.download ? { headers: { 'Content-Disposition': 'attachment; filename="clip_9x16.mp4"' } } : {};
  res.sendFile(file, opts, (err) => { if (err && !res.headersSent) res.sendStatus(404); });
});

app.get('/healthz', (req, res) => res.json({ ok: true, queued: queue.length, running }));

// จัดการ error ของ multer
app.use((err, req, res, next) => {
  if (req.workDir && !jobs.has(req.jobId)) fs.rm(req.workDir, { recursive: true, force: true }).catch(() => {});
  if (err.message === 'NOT_VIDEO') return res.status(400).json({ error: 'รองรับเฉพาะไฟล์วิดีโอ' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `ไฟล์ใหญ่เกิน ${MAX_FILE_MB} MB` });
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: `อัปโหลดได้สูงสุด ${MAX_FILES} คลิป` });
  }
  console.error(err);
  res.status(500).json({ error: 'เซิร์ฟเวอร์ผิดพลาด' });
});

// ลบผลลัพธ์เก่าและงานค้างในหน่วยความจำ
async function cleanup() {
  const cutoff = Date.now() - KEEP_HOURS * 3600 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff && job.status !== 'processing' && job.status !== 'queued') {
      jobs.delete(id);
      fs.rm(path.join(RENDERS, `${id}.mp4`), { force: true }).catch(() => {});
    }
  }
}

(async () => {
  await fs.mkdir(UPLOADS, { recursive: true });
  await fs.mkdir(RENDERS, { recursive: true });
  await fs.rm(UPLOADS, { recursive: true, force: true }); // เคลียร์ไฟล์ค้างจากรอบก่อน
  await fs.mkdir(UPLOADS, { recursive: true });
  setInterval(cleanup, 15 * 60 * 1000).unref();
  app.listen(PORT, () => console.log(`AI Video backend listening on ${BASE_URL}`));
})();
