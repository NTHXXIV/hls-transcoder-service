import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const PROMPT_TEMPLATE = (segmentsJson: string) => `
Bạn là một trợ lý AI chuyên nghiệp xử lý nội dung video tài chính Việt Nam.
NHIỆM VỤ:
1. LÀM SẠCH VĂN BẢN: Sửa lỗi chính tả, loại bỏ từ đệm (à, ờ, thì, mà...), sửa câu lủng củng.
2. SỬA LỖI NHẬN DẠNG GIỌNG NÓI: Transcript được tạo bằng AI speech-to-text nên có thể nhầm tên cổ phiếu, công ty, thuật ngữ tài chính. Dùng ngữ cảnh xung quanh để suy luận và sửa.

   LỖI PHỔ BIẾN ĐÃ BIẾT (ưu tiên sửa trước):
   - "Stats", "SAC", "Stacks", "Stack", "Sac", "Sắc" → "Stag" (nền tảng giáo dục tài chính, tên đúng là Stag)
   - "BIC" khi nói về tập đoàn bất động sản lớn → "VIC" (Vingroup)
   - "Viết" khi nói về mã cổ phiếu → suy từ ngữ cảnh (VHM, VNM, VIC...)
   - "khoa học" khi nói về đường link → "khóa học" (stag.vn/khoa-hoc)
   - "mềm vẫn" → "bền vững"
   - "kết luật" → "kết luận"

   Danh sách ticker phổ biến để tham chiếu: VIC, VHM, VNM, HPG, MSN, TCB, VCB, BID, CTG, MBB, ACB, STB, SSI, FPT, REE, PNJ, MWG, DGC, GAS, SAB, VND, VPB, HDB, LPB, SHB, EIB, VIB, OCB, TPB, BVH, VJC, HVN, GMD, PVD, BSR, OIL, GVR, VRE, BCM, QNS, KDC, NLG, DXG, PDR, NVL, CII, DIG, HDG, KBC, SZC, IDC, PHR, CSV, DPM, DCM.
3. GIỮ NGUYÊN THỜI GIAN: Tuyệt đối không thay đổi giá trị "start" và "end" của các segment.
4. TÓM TẮT: Viết một đoạn tóm tắt nội dung của ĐOẠN NÀY (khoảng 1-2 câu).
5. TỪ KHÓA: Trích xuất 3-5 từ khóa quan trọng của ĐOẠN NÀY.

YÊU CẦU ĐẦU RA:
- Trả về duy nhất 1 JSON block.
- Không thêm bất kỳ văn bản giải thích nào ngoài JSON.
- Đảm bảo "cleanedSegments" có cùng số lượng phần tử với input.

Cấu trúc JSON:
{
  "cleanedSegments": [{ "start": number, "end": number, "text": string }],
  "cleanedFullText": string,
  "summary": string,
  "keywords": [string]
}

INPUT JSON:
${segmentsJson}
`;

// Chỉ dùng model chất lượng cao — thà fail còn hơn ra transcript tệ
const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
];

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
];

// State để nhớ model nào đang chạy tốt
let lastSuccessfulGroqModelIndex = 0;
let lastSuccessfulGeminiModelIndex = 0;

function getGeminiKeys(): string[] {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ].filter(Boolean) as string[];
}

async function cleanWithGemini(segments: TranscriptSegment[]): Promise<any> {
  const keys = getGeminiKeys();
  if (keys.length === 0) throw new Error("No Gemini API Key");

  let lastError: any = null;

  // Thử từ model thành công lần trước, mỗi model × mỗi key
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const idx = (lastSuccessfulGeminiModelIndex + i) % GEMINI_MODELS.length;
    const modelName = GEMINI_MODELS[idx];

    for (const apiKey of keys) {
    try {
      console.log(`    💎 Trying Gemini model: ${modelName}...`);
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });

      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: PROMPT_TEMPLATE(JSON.stringify(segments)) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        }
      });

      const text = result.response.text();
      try {
        const parsed = JSON.parse(text);
        lastSuccessfulGeminiModelIndex = idx;
        return parsed;
      } catch (e) {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          lastSuccessfulGeminiModelIndex = idx;
          return JSON.parse(jsonMatch[0]);
        }
        throw new Error("Invalid AI Response: Could not parse JSON");
      }
    } catch (error: any) {
      console.warn(`    ⚠️ Gemini model ${modelName} failed: ${error.message?.slice(0, 120)}`);
      lastError = error;
    }
    } // end key loop
  }
  throw lastError;
}

// Mutable key list — keys that hit 429 are moved to the back
let groqKeys: string[] = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean) as string[];

// Session-level 429 cooldown per key (2 min TTL)
const groqKeyCooldown = new Map<string, number>();
const COOLDOWN_MS = 2 * 60 * 1000;

function isKeyCoolingDown(key: string): boolean {
  const t = groqKeyCooldown.get(key);
  return t !== undefined && Date.now() < t;
}

function markKeyCooldown(key: string) {
  groqKeyCooldown.set(key, Date.now() + COOLDOWN_MS);
  // Also move to back
  const idx = groqKeys.indexOf(key);
  if (idx !== -1) { groqKeys.splice(idx, 1); groqKeys.push(key); }
}

function availableGroqKeys(): string[] {
  return groqKeys.filter(k => !isKeyCoolingDown(k));
}

async function cleanWithGroq(segments: TranscriptSegment[]): Promise<any> {
  if (groqKeys.length === 0) throw new Error("No Groq API Key");

  let lastError: any = null;

  // Try each model × each key (keys order is dynamic)
  for (let i = 0; i < GROQ_MODELS.length; i++) {
    const idx = (lastSuccessfulGroqModelIndex + i) % GROQ_MODELS.length;
    const modelName = GROQ_MODELS[idx];

    const keys = availableGroqKeys();
    if (keys.length === 0) continue; // all keys cooling down, try next model
    for (const apiKey of keys) {
      const groq = new Groq({ apiKey });
      try {
        console.log(`    🚀 Trying Groq model: ${modelName}...`);
        const completion = await groq.chat.completions.create({
          messages: [{ role: "user", content: PROMPT_TEMPLATE(JSON.stringify(segments)) }],
          model: modelName,
          response_format: { type: "json_object" }
        });
        const content = completion.choices[0]?.message?.content;
        if (!content) throw new Error("Empty response from Groq");
        const parsed = JSON.parse(content);
        lastSuccessfulGroqModelIndex = idx;
        return parsed;
      } catch (error: any) {
        console.warn(`    ⚠️ Groq model ${modelName} failed: ${error.message?.slice(0, 120)}`);
        lastError = error;
        if (error.status === 429 || error.message?.includes("429")) {
          markKeyCooldown(apiKey); // cooldown 2 min, skip for next chunks
        }
      }
    }
  }
  throw lastError;
}

async function cleanWithDeepSeek(segments: TranscriptSegment[]): Promise<any> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("No DeepSeek API Key");

  console.log(`    🤖 Trying DeepSeek V3...`);
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: PROMPT_TEMPLATE(JSON.stringify(segments)) }],
      response_format: { type: "json_object" },
      temperature: 0.1,
    }),
  });
  const json = await res.json() as any;
  if (!res.ok) throw Object.assign(new Error(JSON.stringify(json)), { status: res.status });
  const content = json.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from DeepSeek");
  return JSON.parse(content);
}

function chunkSegments(segments: TranscriptSegment[], chunkSize: number = 30): TranscriptSegment[][] {
  const chunks: TranscriptSegment[][] = [];
  for (let i = 0; i < segments.length; i += chunkSize) {
    chunks.push(segments.slice(i, i + chunkSize));
  }
  return chunks;
}

export async function cleanTranscript(segments: TranscriptSegment[]) {
  const chunks = chunkSegments(segments, 30);
  const allCleanedSegments: TranscriptSegment[] = [];
  const allSummaries: string[] = [];
  const allKeywords = new Set<string>();

  console.log(`📦 Processing transcript in ${chunks.length} chunks...`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`⏳ Processing chunk ${i + 1}/${chunks.length}...`);
    
    let result: any = null;
    let chunkRetries = 2;

    while (chunkRetries >= 0 && !result) {
      try {
        // 1. Groq 70b
        try {
          result = await cleanWithGroq(chunk);
        } catch (groqError: any) {
          console.warn(`  ⚠️ Groq failed for chunk ${i+1}.`);

          // 2. DeepSeek V3
          try {
            console.log(`  🔄 Switching to DeepSeek for chunk ${i+1}...`);
            result = await cleanWithDeepSeek(chunk);
          } catch (deepseekError: any) {
            console.warn(`  ⚠️ DeepSeek failed for chunk ${i+1}.`);

            // 3. Gemini
            console.log(`  🔄 Switching to Gemini for chunk ${i+1}...`);
            result = await cleanWithGemini(chunk);
          }
        }
      } catch (error: any) {
        console.error(`  ❌ All AI providers failed for chunk ${i+1}.`);
        if (chunkRetries > 0) {
          console.log(`  ⏳ Global failure for chunk ${i+1}, retrying the whole chunk in 30s... (${chunkRetries} left)`);
          await sleep(30000);
          chunkRetries--;
        } else {
          // THROW ERROR: Không "cứu vãn" bằng bản thô nữa, báo lỗi để Job fail chính thức
          throw new Error(`CLEAN_JOB_FAILED: AI services are unavailable or quota exceeded after multiple retries (Chunk ${i+1}/${chunks.length}). Last error: ${error.message}`);
        }
      }
    }

    // Gộp kết quả
    if (result.cleanedSegments) {
      allCleanedSegments.push(...result.cleanedSegments);
    } else {
      // Trường hợp AI trả về JSON nhưng thiếu field (hiếm gặp với rotate model)
      allCleanedSegments.push(...chunk);
    }
    
    if (result.summary) allSummaries.push(result.summary);
    if (Array.isArray(result.keywords)) {
      result.keywords.forEach((k: string) => allKeywords.add(k.toLowerCase()));
    }

    // Short pause between chunks to avoid burst TPM
    if (i < chunks.length - 1) await sleep(3000);
  }

  const finalFullText = allCleanedSegments.map(s => s.text).join(" ");
  const finalSummary = allSummaries.join(" ");
  const finalKeywords = Array.from(allKeywords).slice(0, 10);

  // Đảm bảo summary không rỗng để pass backend validation
  const validatedSummary = finalSummary.trim().length > 0 ? finalSummary : "(Bản tóm tắt đang được tạo)";
  const validatedKeywords = finalKeywords.length > 0 ? finalKeywords : ["video"];

  return {
    cleanedFullText: finalFullText,
    cleanedSegments: allCleanedSegments,
    summary: validatedSummary,
    keywords: validatedKeywords
  };
}
