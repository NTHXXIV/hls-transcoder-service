# Chiến lược Xây dựng Hệ thống AI Knowledge Base & Content Generation

Tài liệu này tổng hợp các giải pháp và lộ trình kỹ thuật để chuyển đổi dữ liệu Transcript từ R2 thành các sản phẩm nội dung cao cấp như Blog, Sách (PDF) thông qua AI.

---

## 1. Kiến trúc Dữ liệu (Knowledge Architecture)

Dữ liệu được quản lý theo cấu trúc phân cấp: **Courses -> Sections -> Lessons (Transcript Data)**.

### Transcript Pipeline (3 bước độc lập)

```
[whisper] → transcript-raw.json   (raw ASR segments, timestamps)
    ↓
[clean]   → transcript-clean.json (segments đã sửa lỗi, không có summary)
    ↓
[summarize] → transcript-clean.json (thêm summary + keywords từ full clean text)
```

Mỗi bước là GitHub Action job riêng, admin trigger độc lập. Default flow auto-chain.

**Transcript modes:**
- `lecture`: chạy cả 3 bước (video 1 người nói)
- `workshop`: chỉ chạy whisper (multi-speaker, hội thoại — AI clean sẽ làm mất rhythm)

**DB fields liên quan:**
- `transcriptSegments` — best available (clean nếu đã chạy, else raw)
- `transcriptIsCleaned` — flag phân biệt clean/raw
- `transcriptJsonUrl` — URL `transcript-raw.json`
- `transcriptCleanJsonUrl` — URL `transcript-clean.json` (null nếu chưa clean)
- `transcriptSummary`, `transcriptKeywords` — chỉ có sau bước summarize

### Vectorization (Vector hóa)
- **Phạm vi (Scope):** Thực hiện vector hóa ở cấp độ **Course**. Điều này giúp AI có cái nhìn tổng thể về toàn bộ lộ trình kiến thức, cho phép truy xuất thông tin chéo giữa các bài học (Lesson) khác nhau.
- **Tiền xử lý (Preprocessing):** Chỉ vector hóa lesson có `transcriptIsCleaned = true`. Dùng `transcript-clean.json` làm source (không dùng raw). Văn bản sạch giúp giảm nhiễu, tăng độ chính xác kết quả tìm kiếm.
- **Workshop content:** Vector hóa từ `transcript-raw.json` (không có clean version) — chấp nhận chất lượng thấp hơn.

### Metadata Strategy (Chiến lược Gán nhãn)
Mỗi đoạn văn bản (chunk) trong Vector DB cần được đính kèm các thông tin sau:
- `course_id`, `section_id`, `lesson_id`: Định vị chính xác nguồn gốc.
- `timestamp`: Phục vụ việc trích dẫn nguồn (ví dụ: "Xem tại 10:15 bài học X").
- `content_type`: Phân loại nội dung (Transcript/Summary/Key points).
- `is_cleaned`: Phân biệt raw vs clean segment khi search.

---

## 2. Quy trình Tạo Nội dung (Generation Workflow)

Áp dụng mô hình **Hybrid RAG (Retrieval-Augmented Generation)** theo 3 bước để vượt qua giới hạn về Context Window:

### Bước 1: Trích xuất Cấu trúc (Outline Extraction)
- **Input:** Tổng hợp `summary` và `keywords` từ tất cả các Lesson trong Course.
- **Task:** AI xây dựng mục lục hoặc dàn ý chi tiết cho bài Blog/Cuốn sách.
- **Mục tiêu:** Tạo ra khung logic xuyên suốt mà không cần đọc toàn bộ văn bản thô ngay lập tức.

### Bước 2: Truy xuất Chuyên sâu (Deep Retrieval)
- **Input:** Từng mục trong dàn ý đã tạo ở Bước 1.
- **Task:** Thực hiện tìm kiếm vector trong Course để lấy ra các đoạn hội thoại chi tiết nhất liên quan đến mục đó.
- **Ràng buộc:** Sử dụng System Prompt để ép AI chỉ sử dụng dữ liệu được cung cấp, không tự ý thêm kiến thức bên ngoài (Grounding).

### Bước 3: Biên tập & Tổng hợp (Synthesis)
- **Task:** Sử dụng các Model mạnh (GPT-4o, Claude 3.5) để viết lại nội dung theo văn phong chuyên nghiệp.
- **Output:** Định dạng Markdown, dễ dàng chuyển đổi sang PDF hoặc đăng lên Blog.

---

## 3. Các Gợi ý Tối ưu (Advanced Tips)

### Kiểm soát Ảo giác (Hallucination)
- **Source Citation:** Yêu cầu AI ghi chú mã Lesson ID vào cuối mỗi đoạn văn để dễ dàng kiểm chứng nội dung.
- **Glossary (Từ điển):** Trích xuất danh sách thuật ngữ chuyên môn từ Course. Khi viết, AI sẽ tham chiếu từ điển này để đảm bảo tính nhất quán.

### Viết Nội dung dài (Long-form)
- **Module-based Writing:** Viết theo từng chương (Chapter-by-chapter). Mỗi chương là một phiên làm việc riêng để đảm bảo độ sâu và chi tiết.
- **Context Carry-over:** Khi viết chương mới, hãy đưa tóm tắt của chương trước vào context để AI duy trì mạch văn tự nhiên.

### Trình bày Sách PDF
- **Rich Formatting:** Hướng dẫn AI sử dụng `Blockquote` cho các trích dẫn quan trọng, `Table` cho dữ liệu so sánh và `Bold` cho các từ khóa chính.
- **Auto-generation:** Tự động tạo Trang bìa, Mục lục và Trang bản quyền từ metadata của Course để hoàn thiện sản phẩm đầu ra.

---

## 4. Lộ trình Triển khai (Roadmap)

1. **Giai đoạn 1 (Transcript Architecture):** *(đang làm)*
   - Tách R2 key: `transcript-raw.json` và `transcript-clean.json`
   - Thêm DB fields: `transcriptIsCleaned`, `transcriptCleanJsonUrl`
   - Thêm GitHub Action workflow: `summarize` (bước 3 độc lập)
   - Summary + keywords sinh từ full clean text (1 AI call), không per-chunk
2. **Giai đoạn 2 (Data Backfill):** Chạy summarize cho các lesson đã có clean transcript
3. **Giai đoạn 3 (Indexing):** Worker tự động đồng bộ từ R2 sang Vector DB (Pinecone, Weaviate...) — chỉ index lesson có `transcriptIsCleaned = true`
4. **Giai đoạn 4 (AI Writer):** Ứng dụng "AI Writer" với giao diện chọn Course → Duyệt Outline → Tạo nội dung → Xuất bản.

---

## 5. Pipeline Blog Generation (Đã triển khai)

Script: `scripts/generate-blog.ts` — chạy thủ công khi có CSV mới.

### Input
- File CSV export từ Google Sheets (cột: `Video_code`, `Video_title`, `Transcript`, `Thumbnail`, `Published_link`, `Ngày air`)
- `Transcript` field: phần trước timestamp đầu tiên là `resources` (links, tài liệu tham khảo), phần còn lại là nội dung theo dạng `(mm:ss) text...`

### Flow
```
CSV → filter → diff check → [thumbnail: Drive → R2] → [new: clean + AI generate] → [existing: update fields] → stagapps
```

1. **Filter:** Bỏ qua row không có transcript, `HARD_SKIP_CODES` (C517, C524), series/diary (`696`, `Series D\d+`, `Tuần \d+`)

2. **State migration:** Lần đầu chạy sau update, tự động migrate state cũ sang format mới (không cần can thiệp thủ công)

3. **Diff check (per field, độc lập):**
   - `title_hash` đổi → update frontmatter title, không gọi AI
   - `youtube_hash` đổi → inject/replace iframe trong markdown, không gọi AI
   - `thumbnail_hash` đổi → re-upload thumbnail lên R2, update frontmatter
   - Bài mới (chưa có trong state) → full pipeline (thumbnail + clean + AI generate)

4. **Thumbnail:** Download từ Google Drive → upload lên Cloudflare R2 (`blog/bai-viet/<slug>/thumbnail.jpg`) → lưu URL tuyệt đối. Không lưu ảnh vào repo.

5. **Clean transcript:** Groq `llama-3.3-70b-versatile` (3 keys rotate) → DeepSeek V3 → Gemini Flash → OpenAI `gpt-4o-mini`. Output: `cleanedFullText` + `summary` + `keywords`.

6. **Generate blog:** **Gemini 2.5 Flash only** (3 keys rotate). Nếu hết quota → dừng, thông báo rõ, không fallback model kém hơn. Input gồm `cleanedFullText` + `outline` (summary + keywords từ bước clean) để Gemini có khung cấu trúc. Post-process sau generate: force ghi đúng `title` và `thumbnail` từ CSV/R2 vào frontmatter, không phụ thuộc model output.

7. **Output:**
   - `content/blog/bai-viet/<slug>/index.md` (markdown + frontmatter)
   - Thumbnail lưu trên R2, URL tuyệt đối trong frontmatter

### Ảnh resource trong nội dung bài
Hiện tại là luồng thủ công riêng — chưa tích hợp vào CSV pipeline. Ảnh resource được upload lên R2 và reference bằng URL tuyệt đối trong markdown. *(TODO: define cột `Resource_Images` trong CSV và thêm bước upload R2 trước khi gọi AI)*

### State
`content/blog-state.json` trong repo stagapps — commit cùng code.
```json
{
  "C500": {
    "slug": "sai-lam-tai-chinh-...",
    "title_hash": "d80f28dd54",
    "youtube_hash": "abc123",
    "thumbnail_hash": "afed4536c7",
    "processed_at": "2026-05-20T..."
  }
}
```

### Cách chạy
```bash
npx tsx --env-file=.env scripts/generate-blog.ts --csv "path/to/file.csv" --all
npx tsx --env-file=.env scripts/generate-blog.ts --csv "path/to/file.csv" --code C500
```

### Env cần thiết
```
GROQ_API_KEY
GROQ_API_KEY_2
GROQ_API_KEY_3
GEMINI_API_KEY
GEMINI_API_KEY_2
GEMINI_API_KEY_3
DEEPSEEK_API_KEY
OPENAI_API_KEY          # fallback cuối
R2_ENDPOINT             # https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
R2_PUBLIC_BASE_URL      # https://r2.stag.vn
```

---
*Tài liệu này được soạn thảo để hỗ trợ việc định hướng phát triển hệ thống AI Media Processor V2.*
