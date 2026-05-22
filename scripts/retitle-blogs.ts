/**
 * Usage:
 *   npx tsx scripts/retitle-blogs.ts [options]
 *
 * Options:
 *   --dry-run   Preview new titles/slugs without writing anything
 *   --code <CODE>  Process only one entry (by video code)
 *
 * Flow:
 *   For each entry in blog-state.json:
 *   1. Read existing index.md
 *   2. Ask Gemini to write a better title from the article content
 *   3. Derive new slug from new title
 *   4. If slug changed: rename directory, update state
 *   5. Update title in frontmatter
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const STAGAPPS_ROOT    = path.resolve("/Users/nth/stagapps/apps/stag");
const CONTENT_BAI_VIET = path.join(STAGAPPS_ROOT, "content/blog/bai-viet");
let STATE_PATH         = path.join(STAGAPPS_ROOT, "content/blog-state.json");

// ─── Vietnamese slugify (same as generate-blog.ts) ────────────────────────────

const VI_MAP: Record<string, string> = {
  à:"a",á:"a",ả:"a",ã:"a",ạ:"a",
  ă:"a",ắ:"a",ặ:"a",ằ:"a",ẳ:"a",ẵ:"a",
  â:"a",ấ:"a",ầ:"a",ẩ:"a",ẫ:"a",ậ:"a",
  è:"e",é:"e",ẻ:"e",ẽ:"e",ẹ:"e",
  ê:"e",ế:"e",ề:"e",ể:"e",ễ:"e",ệ:"e",
  ì:"i",í:"i",ỉ:"i",ĩ:"i",ị:"i",
  ò:"o",ó:"o",ỏ:"o",õ:"o",ọ:"o",
  ô:"o",ố:"o",ồ:"o",ổ:"o",ỗ:"o",ộ:"o",
  ơ:"o",ớ:"o",ờ:"o",ở:"o",ỡ:"o",ợ:"o",
  ù:"u",ú:"u",ủ:"u",ũ:"u",ụ:"u",
  ư:"u",ứ:"u",ừ:"u",ử:"u",ữ:"u",ự:"u",
  ỳ:"y",ý:"y",ỷ:"y",ỹ:"y",ỵ:"y",
  đ:"d",
};

function slugify(title: string, maxLen = 60): string {
  let s = title.toLowerCase();
  s = s.replace(/[|:]/g, " ");
  s = s.replace(/[^\u0000-\u007E]/g, c => VI_MAP[c] ?? "");
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/-[^-]*$/, "");
  }
  return s;
}

async function uniqueSlug(base: string, excludeDir?: string): Promise<string> {
  let slug = base;
  let n = 2;
  while (true) {
    const dir = path.join(CONTENT_BAI_VIET, slug);
    if (dir === excludeDir) return slug; // same dir = no collision
    try {
      await fs.access(dir);
      slug = `${base}-${n++}`;
    } catch {
      return slug;
    }
  }
}

// ─── Title extraction ─────────────────────────────────────────────────────────

function extractTitle(md: string): string | null {
  const m = md.match(/^title:\s*(?:'([^']*)'|"([^"]*)"|(.+?))\s*$/m);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").trim() || null;
}

function extractBody(md: string): string {
  // Strip frontmatter block
  const end = md.indexOf("---", 3);
  return end !== -1 ? md.slice(end + 3).trim() : md;
}

// ─── Cooldown / retry (same pattern as generate-blog.ts) ─────────────────────

const cooldowns = new Map<string, number>();

function isCoolingDown(id: string): boolean {
  const t = cooldowns.get(id);
  return !!t && Date.now() < t;
}

function setCooldown(id: string, ms: number) {
  cooldowns.set(id, Date.now() + ms);
  console.warn(`  🧊 ${id} cooling down for ${Math.round(ms / 1000)}s`);
}

async function tryInOrder(attempts: { id: string; label: string; fn: () => Promise<string> }[]): Promise<string> {
  let lastErr: any;
  for (const attempt of attempts) {
    if (isCoolingDown(attempt.id)) {
      console.log(`  ⏭ Skip ${attempt.label} (cooling down)`);
      continue;
    }
    try {
      return await attempt.fn();
    } catch (err: any) {
      console.warn(`  ⚠️ ${attempt.label} failed: ${err.message?.slice(0, 80)}`);
      lastErr = err;
      if (err.status === 429 || err.message?.includes("429")) {
        const msg = (err.message ?? "").toLowerCase();
        const isDailyQuota = msg.includes("daily") || msg.includes("quota") || msg.includes("exceeded");
        setCooldown(attempt.id, isDailyQuota ? 4 * 60 * 60 * 1000 : 2 * 60 * 1000);
      }
    }
  }
  throw lastErr ?? new Error("All keys failed");
}

// ─── Gemini title generation ───────────────────────────────────────────────────

const TITLE_PROMPT = `Bạn là editor cho blog phân tích tài chính tiếng Việt của Stag.

Đọc bài viết dưới đây và viết **chỉ một dòng title** phù hợp với dạng bài phân tích.

Quy tắc title:
- Công thức ưu tiên: [Tên công ty/Ticker] + [chủ đề chính] + [khung thời gian nếu có]
- Ví dụ tốt: "HPG Q1 2026: Lợi nhuận phục hồi nhờ giá thép tăng" | "Tại sao VNM liên tục mất thị phần?" | "DCA vào ETF: Chiến lược phù hợp khi nào?"
- KHÔNG dùng style tiêu đề video/clickbait ("Hé lộ...", "Bí mật...", "Đừng bỏ lỡ...", câu hỏi tu từ không có câu trả lời)
- Tối đa 65 ký tự
- Chỉ trả về title, không giải thích, không dấu nháy bao ngoài

Bài viết:
`;

async function generateTitle(
  articleBody: string,
  geminiKeys: string[],
  groqKeys: string[],
): Promise<string> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const Groq = (await import("groq-sdk")).default;

  const geminiAttempts = geminiKeys.map(apiKey => ({
    id: `gemini:${apiKey.slice(-6)}`,
    label: `Gemini (key …${apiKey.slice(-6)})`,
    fn: async () => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: TITLE_PROMPT + articleBody }] }],
        generationConfig: { temperature: 0.3 },
      });
      return result.response.text().trim().replace(/^['"]|['"]$/g, "");
    },
  }));

  const groqAttempts = groqKeys.map(apiKey => ({
    id: `groq:${apiKey.slice(-6)}`,
    label: `Groq (key …${apiKey.slice(-6)})`,
    fn: async () => {
      const groq = new Groq({ apiKey });
      const res = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        temperature: 0.3,
        messages: [{ role: "user", content: TITLE_PROMPT + articleBody }],
      });
      return (res.choices[0]?.message?.content ?? "").trim().replace(/^['"]|['"]$/g, "");
    },
  }));

  return tryInOrder([...geminiAttempts, ...groqAttempts]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const codeIdx = args.indexOf("--code");
  const targetCode = codeIdx !== -1 ? args[codeIdx + 1] : undefined;
  const stateIdx = args.indexOf("--state");
  const stateArg = stateIdx !== -1 ? args[stateIdx + 1] : undefined;
  if (stateArg) {
    STATE_PATH = path.isAbsolute(stateArg)
      ? stateArg
      : path.join(STAGAPPS_ROOT, "content", stateArg);
  }

  const geminiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ].filter(Boolean) as string[];

  const groqKeys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ].filter(Boolean) as string[];

  if (geminiKeys.length === 0 && groqKeys.length === 0) throw new Error("No API keys set");

  const state: Record<string, any> = JSON.parse(await fs.readFile(STATE_PATH, "utf-8"));

  const entries = Object.entries(state).filter(([code, entry]) => {
    if (targetCode) return code === targetCode;
    if (entry.retitled_at) { console.log(`⏩ Skip [${code}] already retitled`); return false; }
    return true;
  });

  console.log(`\n${dryRun ? "🔍 DRY RUN — " : ""}Retitling ${entries.length} posts...\n`);

  let changed = 0;
  let skipped = 0;
  let errors = 0;

  for (const [code, entry] of entries) {
    const oldSlug: string = entry.slug;
    const mdPath = path.join(CONTENT_BAI_VIET, oldSlug, "index.md");

    let md: string;
    try {
      md = await fs.readFile(mdPath, "utf-8");
    } catch {
      console.log(`⚠️  [${code}] File not found: ${oldSlug}`);
      skipped++;
      continue;
    }

    const currentTitle = extractTitle(md) ?? "(no title)";
    const body = extractBody(md);

    let newTitle: string;
    try {
      const raw = await generateTitle(body, geminiKeys, groqKeys);
      // Strip double quotes (cause YAML issues) and outer single quotes
      newTitle = raw.replace(/"/g, "").replace(/^'|'$/g, "").trim();
      if (!newTitle) throw new Error("Empty title after sanitize");
    } catch (err: any) {
      console.log(`❌  [${code}] Gemini failed: ${err.message?.slice(0, 60)}`);
      errors++;
      continue;
    }

    const newSlug = await uniqueSlug(slugify(newTitle), path.join(CONTENT_BAI_VIET, oldSlug));
    const slugChanged = newSlug !== oldSlug;

    console.log(`[${code}]`);
    console.log(`  Before: ${currentTitle}`);
    console.log(`  After:  ${newTitle}`);
    if (slugChanged) {
      console.log(`  Slug:   ${oldSlug} → ${newSlug}`);
    } else {
      console.log(`  Slug:   ${oldSlug} (unchanged)`);
    }

    if (dryRun) { console.log(); continue; }

    // Update title in frontmatter — replace entire title block including
    // any orphaned continuation lines from multiline titles
    const escapedTitle = newTitle.replace(/'/g, "\\'");
    let newMd = md.replace(
      /^(title:\s*).*$(\n(?![a-zA-Z_]+:).*$)*/m,
      `$1'${escapedTitle}'`,
    );

    if (slugChanged) {
      const oldDir = path.join(CONTENT_BAI_VIET, oldSlug);
      const newDir = path.join(CONTENT_BAI_VIET, newSlug);
      await fs.rename(oldDir, newDir);
      await fs.writeFile(path.join(newDir, "index.md"), newMd, "utf-8");
      state[code] = { ...entry, slug: newSlug, retitled_at: new Date().toISOString() };
    } else {
      await fs.writeFile(mdPath, newMd, "utf-8");
      state[code] = { ...entry, retitled_at: new Date().toISOString() };
    }

    changed++;
    console.log(`  ✅\n`);

    // Delay to avoid rate limit
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!dryRun) {
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  }

  console.log(`\nDone: ${changed} updated, ${skipped} skipped, ${errors} errors`);
}

main().catch(err => {
  console.error("\n❌", err.message);
  process.exit(1);
});
