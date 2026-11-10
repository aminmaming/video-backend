# AI Video Backend (Node.js + FFmpeg)

แปลงจากโค้ด C เดิม: `upload_file` -> `POST /api/jobs`, `process_ai_editing` -> `lib/pipeline.js`,
`deliver_output` -> `GET /api/jobs/:id` + `GET /renders/:id.mp4`

## ติดตั้งและรัน
    sudo apt install ffmpeg fonts-noto-core   # หรือ brew install ffmpeg
    npm install
    node server.js                            # ต้องใช้ Node 18+

ตัวแปรสภาพแวดล้อมดูที่ `.env.example`

## สิ่งที่ทำจริง
- ตัดช่วงเสียงเงียบ (silencedetect) แล้วตัดภาพให้ตรงกับเสียง
- ครอปเต็มเฟรมเป็น 1080x1920 (9:16) และซูมเข้า-ออกเบาๆ ตามสไตล์งาน
- รวมทุกคลิปตามลำดับที่อัปโหลด
- ซับไตเติลภาษาไทยด้วย Whisper (ทำเมื่อตั้งค่า WHISPER_BIN เท่านั้น)
- เพลงประกอบ: วางไฟล์ในโฟลเดอร์ `music/` ชื่อ basket.mp3, review.mp3, unbox.mp3, beforeafter.mp3
  (ไม่มีไฟล์ก็ข้าม) ควรใช้เพลงที่มีลิขสิทธิ์ถูกต้องสำหรับโพสต์เชิงพาณิชย์

## API
`POST /api/jobs` (multipart) ฟิลด์ `files` (หลายไฟล์, สูงสุด 10) และ `style`
-> 202 `{ id, statusUrl }`

`GET /api/jobs/:id` -> `{ status: queued|processing|done|error, stage, percent, outputUrl, warnings, error }`

`GET /renders/:id.mp4` (เพิ่ม `?download=1` เพื่อบังคับดาวน์โหลด)

## เรียกจากหน้าเว็บ
    const fd = new FormData();
    files.forEach(f => fd.append('files', f.file));
    fd.append('style', 'คลิปปักตะกร้า');
    const { id } = await (await fetch(API + '/api/jobs', { method: 'POST', body: fd })).json();
    let job;
    do {
      await new Promise(r => setTimeout(r, 1500));
      job = await (await fetch(API + '/api/jobs/' + id)).json();
      // อัปเดตแถบ progress ด้วย job.percent
    } while (job.status === 'queued' || job.status === 'processing');
    // job.outputUrl ใช้เป็นลิงก์ดาวน์โหลดจริง

## ข้อควรรู้ก่อนขึ้นใช้งานจริง
- สถานะงานเก็บในหน่วยความจำ รีสตาร์ทเซิร์ฟเวอร์แล้วงานที่ค้างจะหาย
  (ถ้าต้องการถาวรให้ย้ายไป Redis/BullMQ หรือฐานข้อมูล)
- ยังไม่มีระบบล็อกอิน ใครรู้ id ของงานก็ดูผลได้ ควรเพิ่ม auth และ rate limit
- ควรวางหลัง reverse proxy (nginx/Caddy) แบบ HTTPS และตั้ง client_max_body_size ให้พอ
