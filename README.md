# Media Processor Service (GitHub Actions)

Xử lý video và transcript cho Stag platform — chạy trên GitHub Actions runner (miễn phí).

## Workflows

### 1. HLS Transcoding (`build-hls`)

Băm video MP4 sang HLS adaptive bitrate (480p / 720p / 1080p), upload lên Cloudflare R2.

**Trigger:**
```bash
curl -X POST \
  -H "Authorization: token YOUR_GITHUB_PAT" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/NTHXXIV/media-processor-service/dispatches \
  -d '{
    "event_type": "build-hls",
    "client_payload": {
      "resource_id": "lesson-uuid",
      "source_url": "https://cdn.example.com/video.mp4",
      "variants": "480p,720p,1080p",
      "segment_seconds": 6,
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
  }'
```

**R2 output:** `{prefix}/master.m3u8`, `{prefix}/480p.m3u8`, `{prefix}/720p_00001.ts`, ...

**Callback statuses:** `processing` → `ready` | `failed`

---

### 2. Whisper Transcription (`build-transcription`, stage: whisper)

Chạy Whisper ASR để tạo raw transcript từ video.

**Trigger:** `event_type: "build-transcription"` — **không** có `stage` hoặc `stage != "clean"` và `stage != "summarize"`

```bash
curl -X POST \
  -H "Authorization: token YOUR_GITHUB_PAT" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/NTHXXIV/media-processor-service/dispatches \
  -d '{
    "event_type": "build-transcription",
    "client_payload": {
      "resource_id": "lesson-uuid",
      "source_url": "https://edu-cdn.stag.vn/lessons/<uuid>/video.mp4",
      "model_size": "medium",
      "callback_url": "https://api.stag.vn/internal/media/transcription/callback",
      "callback_client_id": "stagapps-prod",
      "target_r2_config": { ... }
    }
  }'
```

**R2 output:** `{prefix}/transcript-raw.json`

```json
{
  "segments": [{ "start": 0.0, "end": 4.2, "text": "..." }],
  "fullText": "...",
  "metadata": { "isCleaned": false, "model": "medium" }
}
```

**Callback statuses:** `whisper_processing` → `whisper_success` | `whisper_failed`

---

### 3. AI Clean (`build-transcription`, stage: clean)

Dùng Groq / Gemini để sửa lỗi ASR, chuẩn hóa text. Input là raw segments từ whisper.

**Trigger:** `event_type: "build-transcription"`, `stage: "clean"`

```bash
-d '{
  "event_type": "build-transcription",
  "client_payload": {
    "stage": "clean",
    "resource_id": "lesson-uuid",
    "raw_url": "https://edu-cdn.stag.vn/lessons/<uuid>/transcript-raw.json",
    "callback_url": "...",
    "callback_client_id": "stagapps-prod",
    "target_r2_config": { ... }
  }
}'
```

**R2 output:** `{prefix}/transcript-clean.json`

```json
{
  "segments": [{ "start": 0.0, "end": 4.2, "text": "..." }],
  "fullText": "...",
  "metadata": { "isCleaned": true }
}
```

**Callback statuses:** `clean_processing` → `clean_success` | `clean_failed`

---

### 4. Summarize (`build-transcription`, stage: summarize) — Planned

Sinh summary + keywords từ clean transcript (1 AI call trên toàn bộ clean fullText).
Không chạy per-chunk — đảm bảo summary là holistic, keywords chính xác theo full context.

**Trigger:** `stage: "summarize"`, input là `clean_url` trỏ vào `transcript-clean.json`

**R2 output:** Update `transcript-clean.json` (thêm `summary`, `keywords`)

**Callback status:** `summarize_success` | `summarize_failed`

---

## Pipeline Transcript

```
[whisper]  → transcript-raw.json  → whisper_success callback
    ↓
[clean]    → transcript-clean.json (segments only) → clean_success callback
    ↓
[summarize] → transcript-clean.json (+ summary + keywords) → summarize_success callback
```

Mỗi bước là job độc lập — admin có thể trigger riêng lẻ. Default flow tự động chain sau mỗi bước thành công.

### Transcript modes

| Mode | Steps chạy | Dùng khi |
|---|---|---|
| `lecture` | whisper → clean → summarize | Video 1 người nói liên tục |
| `workshop` | whisper only | Multi-speaker, hội thoại nhiều người |

Workshop không chạy clean/summarize vì AI clean sẽ làm mất rhythm hội thoại và segment pattern không phù hợp.

---

## R2 File Structure

```
lessons/{lessonId}/
  video.mp4                    # Source MP4
  hls/v2/
    master.m3u8
    480p.m3u8
    720p.m3u8
    480p_00001.ts
    ...
  transcript-raw.json          # Whisper ASR output (không bao giờ bị ghi đè bởi clean)
  transcript-clean.json        # AI-cleaned output (có summary + keywords sau bước summarize)
```

---

## Bảo mật

### R2 Credentials — RSA Encryption

`access_key_id` và `secret_access_key` được mã hóa bằng public key trước khi đưa vào `client_payload`:

```bash
# Tạo key pair
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
```

- `TRANSCODER_PRIVATE_KEY` → lưu vào GitHub Secrets (nội dung `private.pem`)
- Public key lưu ở backend để encrypt trước khi dispatch

### Callback Secret

Multi-client secret theo `callback_client_id`:
- `callback_client_id: "stagapps-prod"` → GitHub Secret: `HLS_CALLBACK_SECRET_STAGAPPS_PROD`
- `callback_client_id: "stagapps-sandbox"` → GitHub Secret: `HLS_CALLBACK_SECRET_STAGAPPS_SANDBOX`

---

## Callback Field Reference

Canonical field names (camelCase). `resource_id` / `lesson_id` được normalize về `resourceId`.

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
       | "clean_processing" | "clean_success" | "clean_failed"
       | "summarize_processing" | "summarize_success" | "summarize_failed"
  transcriptUrl?: string    // URL R2 JSON
  fullText?: string
  segments?: Array<{ start: number; end: number; text: string }>
  metadata?: {
    isCleaned: boolean
    summary?: string        // chỉ có sau summarize_success
    keywords?: string[]     // chỉ có sau summarize_success
    durationSeconds?: number
    model?: string
  }
}
```
