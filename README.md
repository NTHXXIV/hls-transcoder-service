# Media Processor Service (GitHub Actions)

Xử lý video và transcript cho Stag platform — chạy trên GitHub Actions runner (miễn phí).

## Workflows

### 1. HLS Transcoding (`build-hls`)

Băm video MP4 sang HLS adaptive bitrate (480p / 720p / 1080p), upload lên Cloudflare R2.

**Trigger payload:**
```json
{
  "event_type": "build-hls",
  "client_payload": {
    "resource_id": "lesson-uuid",
    "source_url": "https://cdn.example.com/video.mp4",
    "variants": "480p,720p,1080p",
    "callback_url": "https://api.stag.vn/internal/media/hls/callback",
    "callback_client_id": "stagapps-prod",
    "target_r2_config": {
      "endpoint": "https://<id>.r2.cloudflarestorage.com",
      "access_key_id": "ENCRYPTED",
      "secret_access_key": "ENCRYPTED",
      "bucket": "stag-edu",
      "prefix": "lessons/<uuid>/hls/v2",
      "public_base_url": "https://edu-cdn.stag.vn"
    }
  }
}
```

**R2 output:** `{prefix}/master.m3u8`, `{prefix}/480p.m3u8`, `{prefix}/720p_00001.ts`, ...

**Callback statuses:** `processing` → `ready` | `failed`

---

### 2. Whisper Transcription (`build-transcription-whisper`)

Chạy Whisper ASR để tạo raw transcript từ video.
Processor chỉ xử lý và trả data inline — **không upload R2**. BE nhận callback và tự upload R2.

**Trigger payload:**
```json
{
  "event_type": "build-transcription-whisper",
  "client_payload": {
    "resource_id": "lesson-uuid",
    "source_url": "https://edu-cdn.stag.vn/lessons/<uuid>/video.mp4",
    "model_size": "medium",
    "title": "Tên bài học",
    "initial_prompt": "...",
    "callback_url": "https://api.stag.vn/internal/media/transcription/callback",
    "callback_client_id": "stagapps-prod"
  }
}
```

**Callback success body:**
```json
{
  "resourceId": "lesson-uuid",
  "status": "whisper_success",
  "fullText": "...",
  "segments": [{ "start": 0.0, "end": 4.2, "text": "..." }],
  "metadata": { "durationSeconds": 123, "model": "medium", "isCleaned": false }
}
```

**Callback statuses:** `whisper_processing` → `whisper_success` | `whisper_failed`

---

### 3. AI Clean (`build-transcription-clean`)

Dùng Groq / Gemini để sửa lỗi ASR, chuẩn hóa text.
Input: `raw_url` — R2 URL do BE upload trước khi dispatch.
Processor fetch `raw_url`, xử lý, trả data inline.

**Trigger payload:**
```json
{
  "event_type": "build-transcription-clean",
  "client_payload": {
    "resource_id": "lesson-uuid",
    "raw_url": "https://edu-cdn.stag.vn/lessons/<uuid>/transcripts/raw-input-xxx.json",
    "model_size": "medium",
    "callback_url": "https://api.stag.vn/internal/media/transcription/callback",
    "callback_client_id": "stagapps-prod"
  }
}
```

**Callback success body:**
```json
{
  "resourceId": "lesson-uuid",
  "status": "clean_success",
  "fullText": "...",
  "segments": [{ "start": 0.0, "end": 4.2, "text": "..." }],
  "metadata": { "durationSeconds": 123, "isCleaned": true }
}
```

**Callback statuses:** `clean_processing` → `clean_success` | `clean_failed`

---

### 4. Summarize (`build-transcription-summarize`)

Sinh summary + keywords từ clean transcript (1 AI call trên toàn bộ clean fullText).
Input: `clean_url` — R2 URL của clean transcript (set bởi BE sau bước clean).

**Trigger payload:**
```json
{
  "event_type": "build-transcription-summarize",
  "client_payload": {
    "resource_id": "lesson-uuid",
    "clean_url": "https://edu-cdn.stag.vn/lessons/<uuid>/transcripts/clean-xxx.json",
    "callback_url": "https://api.stag.vn/internal/media/transcription/callback",
    "callback_client_id": "stagapps-prod"
  }
}
```

**Callback success body:**
```json
{
  "resourceId": "lesson-uuid",
  "status": "summarize_success",
  "fullText": "...",
  "metadata": { "isCleaned": true, "summary": "...", "keywords": ["..."] }
}
```

**Callback statuses:** `summarize_processing` → `summarize_success` | `summarize_failed`

---

## Pipeline Transcript

```
BE dispatch(source_url) → [whisper] → callback(fullText, segments) → BE upload R2
                                                ↓
BE dispatch(raw_url) ──→ [clean]   → callback(fullText, segments) → BE upload R2
                                                ↓
BE dispatch(clean_url) → [summarize] → callback(fullText, metadata) → BE upload R2
```

Mỗi bước là job độc lập — admin có thể trigger riêng lẻ.
**Processor không cần R2 write access cho transcription** — chỉ cần đọc input URL (public) và gửi data inline về BE.

---

## R2 File Structure

```
lessons/{lessonId}/
  hls/v2/
    master.m3u8
    480p.m3u8
    720p_00001.ts
    ...
  transcripts/
    raw-input-{timestamp}.json     # BE upload trước khi dispatch clean
    raw-{timestamp}.json           # BE upload sau whisper_success
    clean-{timestamp}.json         # BE upload sau clean_success
    summarize-{timestamp}.json     # BE upload sau summarize_success
```

---

## Bảo mật

### R2 Credentials — HLS only

`target_r2_config` với encrypted credentials chỉ dùng cho HLS workflow.
Transcription workflow **không nhận** `target_r2_config` — BE tự upload R2 sau khi nhận callback.

```bash
# Tạo key pair cho HLS
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
```

- `TRANSCODER_PRIVATE_KEY` → GitHub Secret (nội dung `private.pem`) — chỉ dùng cho HLS
- Public key lưu ở backend để encrypt trước khi dispatch HLS

### Callback Secret

Multi-client secret theo `callback_client_id`:
- `callback_client_id: "stagapps-prod"` → GitHub Secret: `HLS_CALLBACK_SECRET_STAGAPPS_PROD`
- `callback_client_id: "stagapps-sandbox"` → GitHub Secret: `HLS_CALLBACK_SECRET_STAGAPPS_SANDBOX`

Header gửi kèm callback: `x-hls-callback-secret: <secret>`

---

## Callback Field Reference

**HLS callback body:**
```ts
{
  resourceId: string
  status: "processing" | "ready" | "failed"
  hlsManifestUrl?: string   // khi ready
  hlsVersion?: string
  durationSeconds?: number
  files?: string[]
  prefix?: string
  error?: string            // khi failed
}
```

**Transcription callback body:**
```ts
{
  resourceId: string        // lesson ID hoặc community video ID
  status: "whisper_processing" | "whisper_success" | "whisper_failed"
       | "clean_processing"   | "clean_success"   | "clean_failed"
       | "summarize_processing" | "summarize_success" | "summarize_failed"
  fullText?: string
  segments?: Array<{ start: number; end: number; text: string }>
  metadata?: {
    isCleaned: boolean
    durationSeconds?: number
    model?: string
    summary?: string        // chỉ có sau summarize_success
    keywords?: string[]     // chỉ có sau summarize_success
  }
  error?: string            // khi failed
}
```
