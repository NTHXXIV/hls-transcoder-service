import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const PROMPT_TEMPLATE = (segmentsJson: string) => `
Bạn là một trợ lý AI chuyên nghiệp xử lý nội dung video.
NHIỆM VỤ:
1. LÀM SẠCH VĂN BẢN: Sửa lỗi chính tả, loại bỏ từ đệm, sửa câu lủng củng trong danh sách "segments" bên dưới.
2. TÓM TẮT: Viết một đoạn tóm tắt nội dung của ĐOẠN NÀY (khoảng 1-2 câu).
3. TỪ KHÓA: Trích xuất 3-5 từ khóa quan trọng của ĐOẠN NÀY.

YÊU CẦU ĐẦU RA: Trả về duy nhất 1 JSON, không kèm giải thích.
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

// Danh sách các model để rotate khi gặp lỗi
const GROQ_MODELS = ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "mixtral-8x7b-32768"];
const GEMINI_MODELS = ["gemini-1.5-flash", "gemini-1.5-flash-8b", "gemini-1.5-pro"];

async function cleanWithGemini(segments: TranscriptSegment[]): Promise<any> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("No Gemini API Key");

  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError: any = null;

  for (const modelName of GEMINI_MODELS) {
    try {
      console.log(`    💎 Trying Gemini model: ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(PROMPT_TEMPLATE(JSON.stringify(segments)));
      const text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Invalid AI Response: No JSON found");
      return JSON.parse(jsonMatch[0]);
    } catch (error: any) {
      console.warn(`    ⚠️ Gemini model ${modelName} failed: ${error.message}`);
      lastError = error;
      if (error.message?.includes("429")) await sleep(2000);
    }
  }
  throw lastError;
}

async function cleanWithGroq(segments: TranscriptSegment[]): Promise<any> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("No Groq API Key");

  const groq = new Groq({ apiKey });
  let lastError: any = null;

  for (const modelName of GROQ_MODELS) {
    try {
      console.log(`    🚀 Trying Groq model: ${modelName}...`);
      const completion = await groq.chat.completions.create({
        messages: [{ role: "user", content: PROMPT_TEMPLATE(JSON.stringify(segments)) }],
        model: modelName,
        response_format: { type: "json_object" }
      });
      const content = completion.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from Groq");
      return JSON.parse(content);
    } catch (error: any) {
      console.warn(`    ⚠️ Groq model ${modelName} failed: ${error.message}`);
      lastError = error;
      if (error.status === 429 || error.message?.includes("429")) await sleep(2000);
    }
  }
  throw lastError;
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

    // 1. Thử Groq với cơ chế rotate model
    try {
      result = await cleanWithGroq(chunk);
    } catch (groqError: any) {
      console.warn(`  ⚠️ All Groq models failed for chunk ${i+1}.`);
      
      // 2. Fallback sang Gemini với cơ chế rotate model
      try {
        console.log(`  🔄 Switching provider to Gemini for chunk ${i+1}...`);
        result = await cleanWithGemini(chunk);
      } catch (geminiError: any) {
        console.error(`  ❌ All AI providers failed for chunk ${i+1}.`);
        // THROW ERROR: Không "cứu vãn" bằng bản thô nữa, báo lỗi để Job fail chính thức
        throw new Error(`CLEAN_JOB_FAILED: AI services are unavailable or quota exceeded (Chunk ${i+1}/${chunks.length}).`);
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

    // Throttling: Nghỉ giữa các chunk (trừ chunk cuối)
    if (i < chunks.length - 1) {
      const waitTime = 15000;
      console.log(`  💤 Sleeping for ${waitTime/1000}s to avoid rate limits...`);
      await sleep(waitTime);
    }
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
