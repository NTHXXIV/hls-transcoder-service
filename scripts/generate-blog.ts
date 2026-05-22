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
 *   2. Diff check per field (title_hash, youtube_hash, thumbnail_hash) vs state.json
 *   3. For title/youtube/thumbnail changes: update without AI
 *   4. For new posts only: Groq → clean transcript → Gemini 2.5 Flash → generate blog
 *   5. Thumbnail: Drive → R2 (URL stored in frontmatter, not in repo)
 *   6. Write to stagapps:
 *        content/blog/bai-viet/<slug>/index.md
 *   7. Update state.json
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { cleanTranscript, type TranscriptSegment } from "../src/transcribe/cleaner.js";
import { createR2Client } from "../src/shared/r2.js";

const BLOG_PROMPT_PATH = path.resolve("./prompts/blog-writer.md");
const STAGAPPS_ROOT    = path.resolve("/Users/nth/stagapps/apps/stag");
const CONTENT_BAI_VIET = path.join(STAGAPPS_ROOT, "content/blog/bai-viet");

// Resolved at runtime from --state flag (default: blog-state.json)
let STATE_PATH = path.join(STAGAPPS_ROOT, "content/blog-state.json");

const R2_ENDPOINT        = process.env.R2_ENDPOINT ?? "";
const R2_ACCESS_KEY_ID   = process.env.R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET          = process.env.R2_BUCKET ?? "";
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

// Rows to hard-skip entirely (wrong content, already published elsewhere, etc.)
const HARD_SKIP_CODES = new Set(["C524", "C517"]);

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
  youtube_hash: string;
  thumbnail_hash: string;
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

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex").slice(0, 10);
}
function hashYoutube(row: Record<string, string>): string {
  return md5(row["Published_link"]?.trim() ?? "");
}
function hashThumbnail(row: Record<string, string>): string {
  return md5(row["Thumbnail"] ?? "");
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

// ─── Video embed helpers ──────────────────────────────────────────────────────

function extractYouTubeId(url: string): string | null {
  const m = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1]! : null;
}

function youtubeEmbed(videoId: string): string {
  return `<iframe width="100%" style="aspect-ratio:16/9;border:0;border-radius:8px" src="https://www.youtube.com/embed/${videoId}" allowfullscreen></iframe>`;
}

function extractTikTokId(url: string): string | null {
  const m = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  return m ? m[1]! : null;
}

function tiktokEmbed(_videoId: string, videoUrl: string): string {
  return `<a href="${videoUrl}" target="_blank" rel="noopener" class="tiktok-link">▶ Xem video trên TikTok</a>`;
}

type EmbedResult = { html: string; type: "youtube" | "tiktok" } | null;

function buildEmbed(publishedLink: string): EmbedResult {
  const ytId = extractYouTubeId(publishedLink);
  if (ytId) return { html: youtubeEmbed(ytId), type: "youtube" };
  const ttId = extractTikTokId(publishedLink);
  if (ttId) return { html: tiktokEmbed(ttId, publishedLink), type: "tiktok" };
  return null;
}

async function updateYouTube(mdPath: string, youtubeUrl: string): Promise<void> {
  const embed = buildEmbed(youtubeUrl);
  if (!embed) return;
  const iframe = embed.html;
  let md = await fs.readFile(mdPath, "utf-8");
  if (/<iframe/i.test(md)) {
    md = md.replace(/<iframe[\s\S]*?<\/iframe>/i, iframe);
  } else {
    // Inject before first ## heading
    const m = md.match(/^##\s/m);
    if (m?.index) {
      md = md.slice(0, m.index) + iframe + "\n\n" + md.slice(m.index);
    }
  }
  await fs.writeFile(mdPath, md, "utf-8");
}

// ─── Thumbnail: download from Drive → upload to R2 ───────────────────────────

function extractDriveFileId(url: string): string | null {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1]! : null;
}

async function downloadAndUploadThumbnail(driveUrl: string, slug: string): Promise<string | null> {
  const fileId = extractDriveFileId(driveUrl);
  if (!fileId) return null;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    console.warn("  ⚠️  R2 env vars not set — skipping thumbnail upload");
    return null;
  }
  const tmpPath = path.join(os.tmpdir(), `thumbnail-${slug}.jpg`);
  try {
    const downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    execSync(`curl -sL -o "${tmpPath}" "${downloadUrl}"`, { stdio: "pipe" });
    const stat = await fs.stat(tmpPath);
    if (stat.size < 1024) { await fs.unlink(tmpPath); return null; }

    const r2Key = `blog/bai-viet/${slug}/thumbnail.jpg`;
    const body = await fs.readFile(tmpPath);
    const client = createR2Client(R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);
    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: r2Key,
      Body: body,
      ContentType: "image/jpeg",
      CacheControl: "public, max-age=31536000, immutable",
    }));
    await fs.unlink(tmpPath);
    return `${R2_PUBLIC_BASE_URL}/${r2Key}`;
  } catch (err: any) {
    console.warn(`  ⚠️  Thumbnail upload failed: ${err.message}`);
    try { await fs.unlink(tmpPath); } catch {}
    return null;
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

// ─── Title extraction from model output ──────────────────────────────────────

function extractTitleFromBlog(blog: string): string | null {
  // Handles: title: 'foo', title: "foo", title: foo
  const m = blog.match(/^title:\s*(?:'([^']*)'|"([^"]*)"|(.+?))\s*$/m);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").trim() || null;
}

// ─── Blog Generation ──────────────────────────────────────────────────────────

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
  thumbnailUrl: string | null,
  outline?: { summary: string; keywords: string[] },
): Promise<string> {
  const promptTemplate = await fs.readFile(BLOG_PROMPT_PATH, "utf-8");
  const promptBody = promptTemplate.replace(/^---[\s\S]*?---\n/, "").trim();

  const airDate = parseAirDate(row["Ngày air"]?.trim() || row["Ngày source raw được gửi"]?.trim() || "");
  const pubUrl  = row["Published_link"]?.trim() ?? "";
  const embed   = pubUrl ? buildEmbed(pubUrl) : null;

  const resourcesSection = resources
    ? `**resources** (links, tài liệu tham khảo — quyết định chèn vào vị trí phù hợp: inline, cuối section, hoặc cuối bài):\n${resources}\n`
    : "";

  const outlineSection = outline?.summary
    ? `**outline gợi ý** (tóm tắt cấu trúc nội dung từ transcript — dùng làm khung, đảm bảo bài cover đủ các điểm này):
Tóm tắt: ${outline.summary}
Từ khóa chính: ${outline.keywords.join(", ")}
`
    : "";

  const prompt = `${promptBody}

---

## Input cho bài này

**date**: ${airDate}
**thumbnail**: ${thumbnailUrl ? thumbnailUrl : "không có — bỏ qua field thumbnail"}
**video embed**: ${embed ? `chèn sau đoạn mở, trước heading đầu tiên:\n${embed.html}` : "không có"}
${outlineSection}${resourcesSection}
**transcript** (đã được làm sạch):
${cleanedTranscript}

---

Viết file index.md:`;

  const geminiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ].filter(Boolean) as string[];

  if (geminiKeys.length === 0) {
    throw new Error("No Gemini API keys set. Set GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3 in .env");
  }

  const { GoogleGenerativeAI } = await import("@google/generative-ai");

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

  // CLI prompt: replace "Viết file index.md:" to avoid triggering agentic tool use
  const cliPrompt = prompt.replace(/Viết file index\.md:$/, "Trả về toàn bộ nội dung của file index.md (chỉ trả về text, không dùng tool hay ghi file):");

  const geminiCliAttempt: Attempt = {
    id: "gemini-cli",
    label: "Gemini CLI (Pro)",
    cooldownMs: 60 * 1000,
    fn: async () => {
      const { execSync } = await import("node:child_process");
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const tmpFile = path.join(tmpdir(), `gemini-prompt-${Date.now()}.txt`);
      try {
        writeFileSync(tmpFile, cliPrompt, "utf-8");
        const out = execSync(
          `cat "${tmpFile}" | gemini -p "" --output-format text --approval-mode plan`,
          { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 120_000 }
        );
        return out.trim();
      } finally {
        try { unlinkSync(tmpFile); } catch {}
      }
    },
  };

  const attempts: Attempt[] = [
    ...geminiKeys.map(k => makeGeminiAttempt("gemini-2.5-flash", k)),
    geminiCliAttempt,
  ];

  console.log(`  📝 Generating blog via Gemini 2.5 Flash (${geminiKeys.length} API key(s) + CLI fallback)...`);
  let result: string;
  try {
    result = await tryInOrder(attempts);
  } catch (err: any) {
    throw new Error(
      `All Gemini keys failed or quota exhausted. Wait until quota resets (daily UTC) and retry.\nLast error: ${err.message}`
    );
  }
  return result;
}

// ─── Process single row ───────────────────────────────────────────────────────

interface ChangeFlags {
  isNew: boolean;
  youtubeChanged: boolean;
  thumbnailChanged: boolean;
}

async function processRow(
  row: Record<string, string>,
  state: Record<string, StateEntry>,
  flags: ChangeFlags,
): Promise<void> {
  const videoCode = row["Video_code"]!;

  console.log(`\n${"─".repeat(60)}`);
  const tag = flags.isNew ? "🆕 NEW" : "🔧 UPDATE";
  console.log(`${tag} [${videoCode}]`);
  console.log(`${"─".repeat(60)}`);

  // ── Non-AI updates (existing posts only) ───────────────────────────────────
  if (!flags.isNew) {
    const slug = state[videoCode]!.slug;
    console.log(`   🔗 Slug: ${slug}`);
    const mdPath = path.join(CONTENT_BAI_VIET, slug, "index.md");

    if (flags.thumbnailChanged) {
      const thumbSrc = row["Thumbnail"]?.trim() ?? "";
      if (thumbSrc) {
        process.stdout.write(`\n📷 Uploading thumbnail...`);
        const thumbnailUrl = await downloadAndUploadThumbnail(thumbSrc, slug);
        console.log(thumbnailUrl ? ` ✅` : " ❌ failed");
        if (thumbnailUrl) {
          let md = await fs.readFile(mdPath, "utf-8");
          md = md.replace(/^(thumbnail:\s*).*$/m, `$1'${thumbnailUrl}'`);
          await fs.writeFile(mdPath, md, "utf-8");
        }
      }
    }

    if (flags.youtubeChanged) {
      const ytUrl = row["Published_link"]?.trim() ?? "";
      if (ytUrl) {
        await updateYouTube(mdPath, ytUrl);
        console.log(`\n▶️  YouTube embed updated`);
      }
    }

    state[videoCode] = {
      ...state[videoCode]!,
      youtube_hash: hashYoutube(row),
      thumbnail_hash: hashThumbnail(row),
      processed_at: new Date().toISOString(),
    };
    await saveState(state);
    console.log(`\n🎉 Done`);
    return;
  }

  // ── Full AI generation (new posts only) ────────────────────────────────────
  const { segments, resources } = parseTranscript(row["Transcript"]!);
  console.log(`\n🧹 Cleaning transcript (${segments.length} segments)...`);
  if (resources) console.log(`   📎 Resources found (${resources.length} chars)`);
  const { cleanedFullText, summary, keywords } = await cleanTranscript(segments);
  console.log(`   ✅ Cleaned (${cleanedFullText.length} chars)`);
  if (summary && keywords.length > 0) {
    console.log(`   📋 Outline: ${keywords.slice(0, 5).join(", ")}...`);
  }

  // Generate blog first (no thumbnail yet — slug not known until model writes title)
  console.log(`\n✍️  Generating blog...`);
  let blog = await generateBlog(row, cleanedFullText, resources, null, { summary, keywords });
  blog = blog.replace(/^```(?:markdown|yaml|md)?\n([\s\S]*?)```\s*$/m, "$1").trim();
  const fmStart = blog.indexOf("---");
  if (fmStart > 0) blog = blog.slice(fmStart);

  // Extract model-written title → derive slug
  const modelTitle = extractTitleFromBlog(blog);
  if (!modelTitle) throw new Error(`[${videoCode}] Model did not generate a title in frontmatter`);
  const slug = await uniqueSlug(slugify(modelTitle));
  console.log(`   🔗 Slug: ${slug} (từ title: "${modelTitle}")`);

  // Upload thumbnail now that we have a slug
  let thumbnailUrl: string | null = null;
  const thumbSrc = row["Thumbnail"]?.trim() ?? "";
  if (thumbSrc) {
    process.stdout.write(`\n📷 Uploading thumbnail...`);
    thumbnailUrl = await downloadAndUploadThumbnail(thumbSrc, slug);
    console.log(thumbnailUrl ? ` ✅` : " ❌ failed");
  }
  if (thumbnailUrl) {
    blog = blog.replace(/^(thumbnail:\s*).*$/m, `$1'${thumbnailUrl}'`);
  }

  // Note: don't mkdir until just before writing to avoid empty dirs on failure
  // causing slug collisions on retry (uniqueSlug sees existing dirs)
  const contentDir = path.join(CONTENT_BAI_VIET, slug);
  const mdPath = path.join(contentDir, "index.md");
  await fs.mkdir(contentDir, { recursive: true });
  await fs.writeFile(mdPath, blog, "utf-8");
  console.log(`   ✅ content/blog/bai-viet/${slug}/index.md`);

  state[videoCode] = {
    slug,
    youtube_hash: hashYoutube(row),
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
    state:    getFlag("--state"),
  };

  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  if (!opts.csv) throw new Error("Missing --csv <path>");

  if (opts.state) {
    STATE_PATH = path.isAbsolute(opts.state)
      ? opts.state
      : path.join(STAGAPPS_ROOT, "content", opts.state);
  }
  console.log(`\n📁 State file: ${path.relative(STAGAPPS_ROOT, STATE_PATH)}`);

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

  // ── Migrate old state format (hash / title_hash → youtube_hash) ─────────────
  let migrated = 0;
  const csvMap = Object.fromEntries(validRows.map(r => [r["Video_code"]!, r]));
  for (const [code, entry] of Object.entries(state)) {
    let dirty = false;
    if (!("youtube_hash" in entry)) {
      const row = csvMap[code];
      const mdPath = path.join(CONTENT_BAI_VIET, (entry as any).slug, "index.md");
      let hasIframe = false;
      try { hasIframe = /<iframe/i.test(await fs.readFile(mdPath, "utf-8")); } catch {}
      const ytUrl = row?.["Published_link"]?.trim() ?? "";
      // Force youtube update if link exists but not yet in markdown
      (entry as any).youtube_hash = (ytUrl && !hasIframe) ? "" : (row ? hashYoutube(row) : "");
      (entry as any).thumbnail_hash ??= "";
      delete (entry as any).hash;
      dirty = true;
    }
    // Clean up stale title_hash
    if ("title_hash" in entry) {
      delete (entry as any).title_hash;
      dirty = true;
    }
    if (dirty) migrated++;
  }
  if (migrated > 0) {
    await saveState(state);
    console.log(`   ⬆️  Migrated ${migrated} state entries to new format`);
  }

  // ── Diff: determine what changed per row ─────────────────────────────────
  type RunItem = { row: Record<string, string>; flags: ChangeFlags };
  const toRun: RunItem[] = [];

  for (const row of rowsToProcess) {
    const code  = row["Video_code"]!;
    const entry = state[code];

    if (!entry) {
      console.log(`\n🆕 New [${code}]`);
      toRun.push({ row, flags: { isNew: true, youtubeChanged: false, thumbnailChanged: true } });
      continue;
    }

    const flags: ChangeFlags = {
      isNew: false,
      youtubeChanged:   entry.youtube_hash   !== hashYoutube(row),
      thumbnailChanged: entry.thumbnail_hash !== hashThumbnail(row),
    };

    const changes = [
      flags.youtubeChanged   && "youtube",
      flags.thumbnailChanged && "thumbnail",
    ].filter(Boolean).join(", ");

    if (!changes) {
      console.log(`\n⏩ Skip [${code}] unchanged`);
    } else {
      console.log(`\n🔧 Update [${code}]: ${changes}`);
      toRun.push({ row, flags });
    }
  }

  const needsAI = toRun.filter(i => i.flags.isNew);
  const noAI    = toRun.filter(i => !i.flags.isNew);
  console.log(`\n📊 Summary: ${needsAI.length} need AI, ${noAI.length} no-AI updates, ${rowsToProcess.length - toRun.length} unchanged`);

  if (toRun.length === 0) {
    console.log(`\nNothing to process.`);
    return;
  }

  for (let i = 0; i < toRun.length; i++) {
    const { row, flags } = toRun[i]!;
    if (opts.all) console.log(`\n[${i + 1}/${toRun.length}]`);
    await processRow(row, state, flags);
  }
}

main().catch(err => {
  console.error("\n❌", err.message);
  process.exit(1);
});
