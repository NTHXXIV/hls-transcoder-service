import { GoogleGenerativeAI } from "@google/generative-ai";

const key = process.env.GEMINI_API_KEY!;
const genAI = new GoogleGenerativeAI(key);

for (const modelId of [
  "gemini-2.5-flash",
  "gemini-2.5-flash-preview-04-17",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
]) {
  const model = genAI.getGenerativeModel({ model: modelId });
  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: "Say hi in one word" }] }],
    });
    console.log(`✅ ${modelId}: ${result.response.text().trim()}`);
  } catch (e: any) {
    const msg = e.message?.match(/\[.*?\]/)?.[0] ?? e.message?.slice(0, 60);
    console.log(`❌ ${modelId}: ${msg}`);
  }
}
