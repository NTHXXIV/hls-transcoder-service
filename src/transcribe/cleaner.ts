import { GoogleGenerativeAI } from "@google/generative-ai";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export async function cleanTranscript(segments: TranscriptSegment[]): Promise<{ 
  cleanedFullText: string; 
  cleanedSegments: TranscriptSegment[];
  summary: string;
  keywords: string[];
}> {
  const apiKey = process.env.GEMINI_API_KEY;
  const rawFullText = segments.map(s => s.text).join(" ");

  if (!apiKey) {
    console.warn("⚠️ GEMINI_API_KEY not found. Skipping text cleaning.");
    return { 
      cleanedFullText: rawFullText, 
      cleanedSegments: segments,
      summary: "",
      keywords: []
    };
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      generationConfig: { responseMimeType: "application/json" } 
    });

    const prompt = `
Bạn là một trợ lý AI chuyên nghiệp xử lý nội dung video.
NHIỆM VỤ:
1. LÀM SẠCH VĂN BẢN: Sửa lỗi chính tả, loại bỏ từ đệm, sửa câu lủng củng trong danh sách "segments".
2. TÓM TẮT: Viết một đoạn tóm tắt nội dung chính (khoảng 2-3 câu).
3. TỪ KHÓA: Trích xuất 5-7 từ khóa quan trọng nhất.

INPUT JSON:
${JSON.stringify(segments)}

YÊU CẦU ĐẦU RA (JSON duy nhất):
{
  "cleanedSegments": [{ "start":..., "end":..., "text":... }],
  "cleanedFullText": "...",
  "summary": "Đoạn tóm tắt nội dung...",
  "keywords": ["từ khóa 1", "từ khóa 2", ...]
}
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const output = JSON.parse(response.text());

    return {
      cleanedFullText: output.cleanedFullText || rawFullText,
      cleanedSegments: output.cleanedSegments || segments,
      summary: output.summary || "",
      keywords: output.keywords || []
    };
  } catch (error) {
    console.error("❌ Error cleaning transcript with Gemini:", error);
    return { cleanedFullText: rawFullText, cleanedSegments: segments }; 
  }
}
