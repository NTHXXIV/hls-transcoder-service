/**
 * Usage:
 *   npx tsx scripts/generate-blog.ts [options]
 *
 * Options:
 *   --csv  <PATH>         Path to CSV file (required)
 *   --code <VIDEO_CODE>   Target specific video (default: first valid row)
 *   --row  <INDEX>        Target by row index
 *   --all                 Process all valid rows sequentially
 *
 * Flow:
 *   1. Parse CSV → pick row(s), skip if no transcript / hard-skip / series
 *   2. Compare hash vs state.json → skip / thumbnail-only / full reprocess
 *   3. Groq → clean transcript
 *   4. Download thumbnail from Drive (if available)
 *   5. Groq/OpenAI → generate blog (with YouTube embed if published)
 *   6. Write to stagapps:
 *        content/blog/bai-viet/<slug>/index.md
 *        public/blog/bai-viet/<slug>/thumbnail.jpg  (if downloaded)
 *   7. Update state.json
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import Groq from "groq-sdk";
import { cleanTranscript, type TranscriptSegment } from "../src/transcribe/cleaner.js";

const BLOG_PROMPT_PATH = path.resolve("./prompts/blog-writer.md");
const STAGAPPS_ROOT    = path.resolve("/Users/nth/stagapps/apps/stag");
const STATE_PATH       = path.join(STAGAPPS_ROOT, "content/blog-state.json");
const CONTENT_BAI_VIET = path.join(STAGAPPS_ROOT, "content/blog/bai-viet");
const PUBLIC_BAI_VIET  = path.join(STAGAPPS_ROOT, "public/blog/bai-viet");

// Rows to hard-skip entirely (wrong content, already published elsewhere, etc.)
const HARD_SKIP_CODES = new Set(["C524"]);

// ─── Vietnamese slugify ───────────────────────────────────────────────────────

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
  // Replace separators with space
  s = s.replace(/[|:]/g, " ");
  // Replace Vietnamese chars
  s = s.replace(/[^\u0000-\u007E]/g, c => VI_MAP[c] ?? "");
  // Replace non-alphanumeric with hyphen
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Cap length at word boundary
  if (s.length > maxLen) {
    s = s.slice(0, maxLen).replace(/-[^-]*$/, "");
  }
  return s;
}

async function uniqueSlug(base: string): Promise<string> {
  const dir = CONTENT_BAI_VIET;
  let slug = base;
  let n = 2;
  while (true) {
    try {
      await fs.access(path.join(dir, slug));
      slug = `${base}-${n++}`;
    } catch {
      return slug;
    }
  }
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCSV(content: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ""; }
      else if (ch === '\n') { row.push(field); field = ""; rows.push(row); row = []; }
      else if (ch !== '\r') field += ch;
    }
  }
  if (field || row.length > 0) { row.push(field); rows.push(row); }

  if (rows.length === 0) return [];
  const headers = rows[0]!.map(h => h.trim());
  return rows.slice(1)
    .filter(r => r.some(f => f.trim()))
    .map(r => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = r[i]?.trim() ?? ""; });
      return obj;
    });
}

// Patterns for series/diary content → skip entirely
const NHAT_KY_PATTERNS = [
  /series\s+d\d+/i,
  /tuần\s+\d+/i,
  /week\s+\d+/i,
  /\b696\b/i,
];

type ContentType = "bai-viet" | "nhat-ky";

function getContentType(row: Record<string, string>): ContentType {
  const title = row["Video_title"] ?? "";
  return NHAT_KY_PATTERNS.some(p => p.test(title)) ? "nhat-ky" : "bai-viet";
}

function getValidRows(rows: Record<string, string>[]): Record<string, string>[] {
  return rows.filter(r =>
    r["Video_code"] &&
    r["Transcript"]?.trim() &&
    !HARD_SKIP_CODES.has(r["Video_code"]) &&
    getContentType(r) !== "nhat-ky"
  );
}

// ─── State tracking ───────────────────────────────────────────────────────────

interface StateEntry {
  slug: string;
  hash: string;           // hash of content (title + transcript + published_link)
  thumbnail_hash: string; // hash of thumbnail URL only
  processed_at: string;
}

async function loadState(): Promise<Record<string, StateEntry>> {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function saveState(state: Record<string, StateEntry>): Promise<void> {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

function hashContent(row: Record<string, string>): string {
  const key = [
    row["Video_title"] ?? "",
    row["Transcript"] ?? "",
    row["Published_link"] ?? "",
  ].join("|");
  return createHash("md5").update(key).digest("hex").slice(0, 10);
}

function hashThumbnail(row: Record<string, string>): string {
  return createHash("md5").update(row["Thumbnail"] ?? "").digest("hex").slice(0, 10);
}

// ─── Date parser ──────────────────────────────────────────────────────────────

function parseAirDate(raw: string): string {
  if (!raw) return new Date().toISOString().slice(0, 10);
  // Already full: 28/04/2026 or 2026-04-28
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parts = raw.split("/");
  if (parts.length >= 2) {
    const day   = parts[0]!.padStart(2, "0");
    const month = parts[1]!.padStart(2, "0");
    const year  = parts[2] ?? "2026";
    return `${year}-${month}-${day}`;
  }
  return new Date().toISOString().slice(0, 10);
}

// ─── YouTube embed helper ─────────────────────────────────────────────────────

function extractYouTubeId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1]! : null;
}

function youtubeEmbed(videoId: string): string {
  return `<iframe width="100%" style="aspect-ratio:16/9;border:0;border-radius:8px" src="https://www.youtube.com/embed/${videoId}" allowfullscreen></iframe>`;
}

// ─── Thumbnail download ───────────────────────────────────────────────────────

function extractDriveFileId(url: string): string | null {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1]! : null;
}

async function downloadThumbnail(driveUrl: string, destPath: string): Promise<boolean> {
  const fileId = extractDriveFileId(driveUrl);
  if (!fileId) return false;
  try {
    const downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    execSync(`curl -sL -o "${destPath}" "${downloadUrl}"`, { stdio: "pipe" });
    const stat = await fs.stat(destPath);
    if (stat.size < 1024) { await fs.unlink(destPath); return false; }
    return true;
  } catch {
    return false;
  }
}

// ─── Transcript Parser ────────────────────────────────────────────────────────

interface ParsedTranscript {
  segments: TranscriptSegment[];
  resources: string; // content before first timestamp (links, references, etc.)
}

function parseTranscript(transcript: string): ParsedTranscript {
  const firstTs = transcript.search(/\(\d+:\d{2}\)/);
  const resources = firstTs > 0 ? transcript.slice(0, firstTs).trim() : "";

  const body = firstTs >= 0 ? transcript.slice(firstTs) : transcript;
  const segments: TranscriptSegment[] = [];
  const re = /\((\d+):(\d{2})\)\s*([^(]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const start = parseInt(m[1]!) * 60 + parseInt(m[2]!);
    const text = m[3]!.trim();
    if (text) segments.push({ start, end: start, text });
  }
  for (let i = 0; i < segments.length - 1; i++) segments[i]!.end = segments[i + 1]!.start;
  if (segments.length > 0) segments[segments.length - 1]!.end = segments[segments.length - 1]!.start + 5;

  return { segments, resources };
}

// ─── Blog Generation ──────────────────────────────────────────────────────────

const groqKeys: string[] = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean) as string[];

// ─── Cooldown / retry abstraction ────────────────────────────────────────────

const cooldowns = new Map<string, number>();

function isCoolingDown(id: string): boolean {
  const t = cooldowns.get(id);
  return !!t && Date.now() < t;
}

function setCooldown(id: string, ms: number) {
  cooldowns.set(id, Date.now() + ms);
  console.warn(`  🧊 ${id} cooling down for ${ms / 1000}s`);
}

interface Attempt {
  id: string;           // unique ID for cooldown tracking
  label: string;        // for logging
  fn: () => Promise<string>;
  cooldownMs?: number;  // how long to cool down on 429 (default 2 min)
}

async function tryInOrder(attempts: Attempt[]): Promise<string> {
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
        const ms = isDailyQuota
          ? 4 * 60 * 60 * 1000              // 4 hours — daily quota won't reset sooner
          : (attempt.cooldownMs ?? 2 * 60 * 1000); // 2 min for RPM rate limit
        setCooldown(attempt.id, ms);
      }
    }
  }
  throw lastErr ?? new Error("All providers failed");
}

async function generateBlog(
  row: Record<string, string>,
  cleanedTranscript: string,
  resources: string,
  slug: string,
  hasThumbnail: boolean,
): Promise<string> {
  const promptTemplate = await fs.readFile(BLOG_PROMPT_PATH, "utf-8");
  const promptBody = promptTemplate.replace(/^---[\s\S]*?---\n/, "").trim();

  const title   = row["Video_title"]!;
  const airDate = parseAirDate(row["Ngày air"]?.trim() || row["Ngày source raw được gửi"]?.trim() || "");
  const ytUrl   = row["Published_link"]?.trim() ?? "";
  const ytId    = ytUrl ? extractYouTubeId(ytUrl) : null;

  const resourcesSection = resources
    ? `**resources** (links, tài liệu tham khảo — quyết định chèn vào vị trí phù hợp: inline, cuối section, hoặc cuối bài):\n${resources}\n`
    : "";

  const prompt = `${promptBody}

---

## Input cho bài này

**title** (copy nguyên văn vào frontmatter, KHÔNG rút gọn hay đặt lại): ${title}
**date**: ${airDate}
**thumbnail**: ${hasThumbnail ? "./thumbnail.jpg" : "không có — bỏ qua field thumbnail"}
**youtube embed**: ${ytId ? `chèn iframe sau đoạn mở, trước heading đầu tiên:\n${youtubeEmbed(ytId)}` : "không có"}
${resourcesSection}
**transcript** (đã được làm sạch):
${cleanedTranscript}

---

Viết file index.md:`;

  const geminiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ].filter(Boolean) as string[];
  const { GoogleGenerativeAI } = await import("@google/generative-ai");

  const makeGroqAttempt = (model: string, apiKey: string): Attempt => ({
    id: `groq:${model}:${apiKey.slice(-6)}`,
    label: `Groq ${model.split("/").pop()} (key …${apiKey.slice(-6)})`,
    fn: async () => {
      const client = new Groq({ apiKey });
      const completion = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      });
      return completion.choices[0]?.message?.content ?? "";
    },
  });

  const makeGeminiAttempt = (model: string, apiKey: string): Attempt => ({
    id: `gemini:${model}:${apiKey.slice(-6)}`,
    label: `Gemini ${model} (key …${apiKey.slice(-6)})`,
    cooldownMs: 5 * 60 * 1000,
    fn: async () => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const gemModel = genAI.getGenerativeModel({ model });
      const result = await gemModel.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 },
      });
      return result.response.text();
    },
  });

  const deepseekKey = process.env.DEEPSEEK_API_KEY;

  const attempts: Attempt[] = [
    // Priority 1: Groq 70b (best Groq quality)
    ...groqKeys.map(k => makeGroqAttempt("llama-3.3-70b-versatile", k)),
    // Priority 2: DeepSeek V3 (high quality, OpenAI-compatible)
    ...(deepseekKey ? [{
      id: `deepseek:deepseek-chat:${deepseekKey.slice(-6)}`,
      label: `DeepSeek V3 (key …${deepseekKey.slice(-6)})`,
      cooldownMs: 5 * 60 * 1000,
      fn: async () => {
        const res = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${deepseekKey}`,
          },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
          }),
        });
        const json = await res.json() as any;
        if (!res.ok) throw Object.assign(new Error(JSON.stringify(json)), { status: res.status });
        return json.choices[0]?.message?.content ?? "";
      },
    }] : []),
    // Priority 3: Gemini 2.5 Flash (high quality, better than weak Groq models)
    ...geminiKeys.map(k => makeGeminiAttempt("gemini-2.5-flash", k)),
    // Priority 3: Gemini 2.0 Flash
    ...geminiKeys.map(k => makeGeminiAttempt("gemini-2.0-flash", k)),
    // Priority 4: OpenAI fallback
    ...(process.env.OPENAI_API_KEY ? [{
      id: "openai:gpt-4o-mini",
      label: "OpenAI gpt-4o-mini",
      fn: async () => {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
          }),
        });
        const json = await res.json() as any;
        if (!res.ok) throw new Error(JSON.stringify(json));
        return json.choices[0]?.message?.content ?? "";
      },
    }] : []),
  ];

  console.log(`  📝 Generating blog (${attempts.length} provider-key combos available)...`);
  return tryInOrder(attempts);
}

// ─── Process single row ───────────────────────────────────────────────────────

async function processRow(
  row: Record<string, string>,
  state: Record<string, StateEntry>,
  thumbnailOnly = false,
): Promise<void> {
  const videoCode   = row["Video_code"]!;
  const title       = row["Video_title"]!;
  const contentType = getContentType(row);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`📹 [${videoCode}] [${contentType}] ${title}`);
  console.log(`${"─".repeat(60)}`);

  // Use existing slug from state (reprocess case) or generate new one
  const baseSlug = slugify(title);
  const slug = state[videoCode]?.slug ?? await uniqueSlug(baseSlug);
  console.log(`   🔗 Slug: ${slug}`);

  const contentDir = path.join(CONTENT_BAI_VIET, slug);
  const publicDir  = path.join(PUBLIC_BAI_VIET,  slug);
  await fs.mkdir(contentDir, { recursive: true });
  await fs.mkdir(publicDir,  { recursive: true });

  // 1. Download thumbnail
  let hasThumbnail = false;
  const thumbSrc = row["Thumbnail"]?.trim() ?? "";
  if (thumbSrc) {
    process.stdout.write(`\n📷 Downloading thumbnail...`);
    hasThumbnail = await downloadThumbnail(thumbSrc, path.join(publicDir, "thumbnail.jpg"));
    console.log(hasThumbnail ? " ✅" : " ❌ failed, skipping");
  } else {
    console.log(`\n📷 No thumbnail`);
  }

  if (thumbnailOnly) {
    // Only thumbnail changed — skip AI, just update thumbnail_hash
    state[videoCode]!.thumbnail_hash = hashThumbnail(row);
    state[videoCode]!.processed_at = new Date().toISOString();
    await saveState(state);
    console.log(`\n🎉 Done (thumbnail updated)`);
    return;
  }

  // 2. Clean transcript with Groq
  const { segments, resources } = parseTranscript(row["Transcript"]!);
  console.log(`\n🧹 Cleaning transcript (${segments.length} segments)...`);
  if (resources) console.log(`   📎 Resources found (${resources.length} chars)`);
  const { cleanedFullText } = await cleanTranscript(segments);
  console.log(`   ✅ Cleaned (${cleanedFullText.length} chars)`);

  // 3. Generate blog
  console.log(`\n✍️  Generating blog...`);
  let blog = await generateBlog(row, cleanedFullText, resources, slug, hasThumbnail);

  // Strip code fence wrapping if model wrapped the whole output (e.g. ```markdown ... ```)
  blog = blog.replace(/^```(?:markdown|yaml|md)?\n([\s\S]*?)```\s*$/m, "$1").trim();
  // Strip any leading text before frontmatter (e.g. "Dưới đây là bài blog...")
  const frontmatterStart = blog.indexOf("---");
  if (frontmatterStart > 0) blog = blog.slice(frontmatterStart);

  // 4. Write output
  await fs.writeFile(path.join(contentDir, "index.md"), blog, "utf-8");
  console.log(`   ✅ content/blog/bai-viet/${slug}/index.md`);
  if (hasThumbnail) console.log(`   ✅ public/blog/bai-viet/${slug}/thumbnail.jpg`);

  // Update state
  state[videoCode] = {
    slug,
    hash: hashContent(row),
    thumbnail_hash: hashThumbnail(row),
    processed_at: new Date().toISOString(),
  };
  await saveState(state);

  console.log(`\n🎉 Done`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const opts = {
    all:      args.includes("--all"),
    code:     getFlag("--code"),
    rowIndex: getFlag("--row") !== undefined ? parseInt(getFlag("--row")!) : undefined,
    csv:      getFlag("--csv"),
  };

  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY not set");
  if (!opts.csv) throw new Error("Missing --csv <path>");

  const state = await loadState();

  console.log(`\n📄 Parsing CSV...`);
  const content = await fs.readFile(path.resolve(opts.csv), "utf-8");
  const validRows = getValidRows(parseCSV(content));
  console.log(`   ${validRows.length} valid rows (skipping no-transcript & hard-skip codes)`);

  let rowsToProcess: Record<string, string>[];
  if (opts.all) {
    rowsToProcess = validRows;
  } else if (opts.code) {
    const found = validRows.find(r => r["Video_code"] === opts.code);
    if (!found) throw new Error(`Video_code "${opts.code}" not found (or filtered out)`);
    rowsToProcess = [found];
  } else {
    const idx = opts.rowIndex ?? 0;
    if (idx >= validRows.length) throw new Error(`Row ${idx} out of range`);
    rowsToProcess = [validRows[idx]!];
  }

  // Hash-based diff: 3 cases
  type RunItem = { row: Record<string, string>; thumbnailOnly: boolean };
  const toRun: RunItem[] = [];

  for (const row of rowsToProcess) {
    const code = row["Video_code"]!;
    const entry = state[code];
    const contentChanged = !entry || entry.hash !== hashContent(row);
    const thumbChanged   = !entry || entry.thumbnail_hash !== hashThumbnail(row);

    if (!contentChanged && !thumbChanged) {
      console.log(`\n⏩ Skip [${code}] unchanged`);
    } else if (!contentChanged && thumbChanged) {
      console.log(`\n🖼  [${code}] thumbnail changed — re-download only`);
      toRun.push({ row, thumbnailOnly: true });
    } else {
      console.log(entry ? `\n🔄 Reprocess [${code}] content changed` : `\n🆕 New [${code}]`);
      toRun.push({ row, thumbnailOnly: false });
    }
  }

  if (toRun.length === 0) {
    console.log(`\nNothing to process.`);
    return;
  }

  for (let i = 0; i < toRun.length; i++) {
    const { row, thumbnailOnly } = toRun[i]!;
    if (opts.all) console.log(`\n[${i + 1}/${toRun.length}]`);
    await processRow(row, state, thumbnailOnly);
  }
}

main().catch(err => {
  console.error("\n❌", err.message);
  process.exit(1);
});
