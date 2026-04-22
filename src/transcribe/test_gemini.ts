import { cleanTranscript } from './cleaner.js';

async function test() {
  console.log("🚀 Testing Gemini API...");
  
  if (!process.env.GEMINI_API_KEY) {
    console.error("❌ Error: GEMINI_API_KEY environment variable is not set.");
    process.exit(1);
  }

  const mockSegments = [
    { start: 0, end: 5, text: "Chào mọi người, hôm nay chúng ta nói về bitcoin." },
    { start: 5, end: 10, text: "Xung quanh tiền ảo thì thường dính tới rượu tiền à ừm đúng không các bạn nhé." },
    { start: 10, end: 15, text: "Tuy nhiên hiện nay thì bitcoin là một trong những cái loại tài sản rất là ưu chuộng." }
  ];

  console.log("📝 Input text:", mockSegments.map(s => s.text).join(" "));
  
  try {
    const result = await cleanTranscript(mockSegments);
    
    console.log("\n✨ GEMINI RESULT:");
    console.log("-------------------");
    console.log("✅ Cleaned Full Text:", result.cleanedFullText);
    console.log("\n📋 Summary:", result.summary);
    console.log("\n🏷️ Keywords:", result.keywords);
    console.log("-------------------");
    
    if (result.cleanedFullText.toLowerCase().includes("rửa tiền")) {
      console.log("🎯 SUCCESS: Gemini fixed 'rượu tiền' to 'rửa tiền'!");
    }
  } catch (error) {
    console.error("❌ Test Failed:", error);
  }
}

test();
