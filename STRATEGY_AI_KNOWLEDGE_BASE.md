# Chiến lược Xây dựng Hệ thống AI Knowledge Base & Content Generation

Tài liệu này tổng hợp các giải pháp và lộ trình kỹ thuật để chuyển đổi dữ liệu Transcript từ R2 thành các sản phẩm nội dung cao cấp như Blog, Sách (PDF) thông qua AI.

---

## 1. Kiến trúc Dữ liệu (Knowledge Architecture)

Dữ liệu được quản lý theo cấu trúc phân cấp: **Courses -> Sections -> Lessons (Transcript Data)**.

### Vectorization (Vector hóa)
- **Phạm vi (Scope):** Thực hiện vector hóa ở cấp độ **Course**. Điều này giúp AI có cái nhìn tổng thể về toàn bộ lộ trình kiến thức, cho phép truy xuất thông tin chéo giữa các bài học (Lesson) khác nhau.
- **Tiền xử lý (Preprocessing):** Chỉ vector hóa dữ liệu đã qua bước **Clean AI**. Việc sử dụng văn bản sạch giúp giảm nhiễu (loại bỏ từ đệm, lỗi chính tả, câu lủng củng), từ đó tăng độ chính xác của kết quả tìm kiếm vector.

### Metadata Strategy (Chiến lược Gán nhãn)
Mỗi đoạn văn bản (chunk) trong Vector DB cần được đính kèm các thông tin sau:
- `course_id`, `section_id`, `lesson_id`: Định vị chính xác nguồn gốc.
- `timestamp`: Phục vụ việc trích dẫn nguồn (ví dụ: "Xem tại 10:15 bài học X").
- `content_type`: Phân loại nội dung (Transcript/Summary/Key points).

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

1. **Giai đoạn 1 (Data Clean):** Hoàn thiện script Clean AI để đảm bảo mọi transcript trên R2 đều là bản "sạch".
2. **Giai đoạn 2 (Indexing):** Xây dựng Worker tự động đồng bộ từ R2 sang Vector DB (Pinecone, Weaviate...).
3. **Giai đoạn 3 (AI Writer):** Phát triển ứng dụng "AI Writer" với giao diện chọn Course -> Duyệt Outline -> Tạo nội dung -> Xuất bản.

---

## 5. Pipeline Blog Generation (Đã triển khai)

Script: `scripts/generate-blog.ts` — chạy thủ công khi có CSV mới.

### Input
- File CSV export từ Google Sheets (cột: `Video_code`, `Video_title`, `Transcript`, `Thumbnail`, `Published_link`, `Ngày air`)

### Flow
```
CSV → filter rows → hash check → Groq clean transcript → Groq/OpenAI generate blog → stagapps
```

1. **Filter:** Bỏ qua row không có transcript, `HARD_SKIP_CODES` (C524), và series/diary (`696`, `Series D\d+`, `Tuần \d+`)
2. **Hash check (3 cases):**
   - Không đổi → skip
   - Chỉ thumbnail URL đổi → re-download ảnh, không gọi AI
   - Nội dung đổi → full reprocess (Groq + AI)
3. **Clean transcript:** Groq rotate qua `llama-3.1-8b-instant` → `llama-3.3-70b-versatile` → `llama-4-scout`, hỗ trợ 2 API key (`GROQ_API_KEY`, `GROQ_API_KEY_2`)
4. **Generate blog:** Groq (cùng model list) → fallback OpenAI `gpt-4o-mini`
5. **Output:**
   - `content/blog/bai-viet/<slug>/index.md`
   - `public/blog/bai-viet/<slug>/thumbnail.jpg`

### State
`/Users/nth/stagapps/apps/stag/content/blog-state.json` — commit cùng stagapps.
```json
{
  "C500": { "slug": "...", "hash": "abc123", "thumbnail_hash": "def456", "processed_at": "..." }
}
```

### Cách chạy
```bash
npm run generate-blog "path/to/file.csv" --all
npm run generate-blog "path/to/file.csv" --code C500
```

### Env cần thiết
```
GROQ_API_KEY
GROQ_API_KEY_2      # optional, dùng khi key 1 hết quota
OPENAI_API_KEY      # optional, fallback blog generation
```

---
*Tài liệu này được soạn thảo để hỗ trợ việc định hướng phát triển hệ thống AI Media Processor V2.*
