import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";

/**
 * Generate a holistic summary + keywords from the full clean transcript text.
 * Single AI call on the entire text — not per-chunk — so the summary reflects
 * the whole content rather than a concatenation of partial summaries.
 */

const SUMMARIZE_PROMPT = (fullText: string) => `
Bạn là một trợ lý AI chuyên nghiệp phân tích nội dung video tài chính Việt Nam.

Dưới đây là toàn bộ transcript của một video. Hãy:
1. TÓM TẮT: Viết 2-4 câu tóm tắt toàn bộ nội dung video (không tóm theo từng phần, mà nhìn tổng thể).
2. TỪ KHÓA: Trích xuất 5-10 từ khóa/cụm từ quan trọng nhất của toàn bộ video. Ưu tiên thuật ngữ chuyên ngành, tên công ty, mã cổ phiếu, khái niệm tài chính được đề cập nhiều.

YÊU CẦU:
- Trả về duy nhất 1 JSON block, không giải thích thêm.
- Keywords phải tồn tại trong transcript (không thêm từ ngoài ngữ cảnh).

Cấu trúc JSON:
{
  "summary": string,
  "keywords": [string]
}

TRANSCRIPT:
${fullText.slice(0, 15000)}
`;

function getGeminiKeys(): string[] {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ].filter(Boolean) as string[];
}

const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];

async function summarizeWithGemini(fullText: string): Promise<{ summary: string; keywords: string[] }> {
  const keys = getGeminiKeys();
  if (keys.length === 0) throw new Error("No Gemini API Key");

  for (const modelName of GEMINI_MODELS) {
    for (const apiKey of keys) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: SUMMARIZE_PROMPT(fullText) }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        });
        const text = result.response.text();
        try {
          return JSON.parse(text);
        } catch {
          const match = text.match(/\{[\s\S]*\}/);
          if (match) return JSON.parse(match[0]);
          throw new Error("Invalid JSON from Gemini");
        }
      } catch (err: any) {
        console.warn(`  ⚠️ Gemini ${modelName} summarize failed: ${err.message?.slice(0, 100)}`);
      }
    }
  }
  throw new Error("All Gemini models failed for summarize");
}

const GROQ_MODEL = "llama-3.3-70b-versatile";

async function summarizeWithGroq(fullText: string): Promise<{ summary: string; keywords: string[] }> {
  const keys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ].filter(Boolean) as string[];

  if (keys.length === 0) throw new Error("No Groq API Key");

  for (const apiKey of keys) {
    try {
      const groq = new Groq({ apiKey });
      const completion = await groq.chat.completions.create({
        messages: [{ role: "user", content: SUMMARIZE_PROMPT(fullText) }],
        model: GROQ_MODEL,
        response_format: { type: "json_object" },
      });
      const content = completion.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from Groq");
      return JSON.parse(content);
    } catch (err: any) {
      console.warn(`  ⚠️ Groq summarize failed: ${err.message?.slice(0, 100)}`);
    }
  }
  throw new Error("All Groq keys failed for summarize");
}

export async function summarizeTranscript(
  cleanFullText: string,
): Promise<{ summary: string; keywords: string[] }> {
  console.log(`📝 Generating summary from full clean transcript (${cleanFullText.length} chars)...`);

  let result: { summary: string; keywords: string[] } | null = null;

  // 1. Try Groq first (faster)
  try {
    result = await summarizeWithGroq(cleanFullText);
  } catch {
    console.warn("  ⚠️ Groq summarize failed, falling back to Gemini...");
  }

  // 2. Fallback to Gemini
  if (!result) {
    result = await summarizeWithGemini(cleanFullText);
  }

  // Ensure non-empty output
  const summary = result.summary?.trim() || "(Bản tóm tắt đang được tạo)";
  const keywords = Array.isArray(result.keywords) && result.keywords.length > 0
    ? result.keywords.map((k: string) => k.toLowerCase().trim()).filter(Boolean).slice(0, 10)
    : ["video"];

  console.log(`✅ Summary generated. Keywords: ${keywords.join(", ")}`);
  return { summary, keywords };
}
