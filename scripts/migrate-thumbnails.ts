/**
 * Migrate all thumbnails from public/blog/bai-viet/ → R2, update frontmatter.
 * Usage: npx tsx scripts/migrate-thumbnails.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createR2Client } from "../src/shared/r2.js";

const R2_ENDPOINT          = process.env.R2_ENDPOINT ?? "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET            = process.env.R2_BUCKET ?? "";
const R2_PUBLIC_BASE_URL   = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

const STAGAPPS      = "/Users/nth/stagapps/apps/stag";
const PUBLIC_DIR    = path.join(STAGAPPS, "public/blog/bai-viet");
const CONTENT_DIR   = path.join(STAGAPPS, "content/blog/bai-viet");

if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error("❌ Missing R2 env vars"); process.exit(1);
}

const client = createR2Client(R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);

const slugs = (await fs.readdir(PUBLIC_DIR)).filter(async (name) => {
  const stat = await fs.stat(path.join(PUBLIC_DIR, name));
  return stat.isDirectory();
});

// Filter to only dirs that have a thumbnail.jpg
const toProcess: string[] = [];
for (const slug of slugs) {
  const thumbPath = path.join(PUBLIC_DIR, slug, "thumbnail.jpg");
  try { await fs.access(thumbPath); toProcess.push(slug); } catch {}
}

console.log(`Found ${toProcess.length} thumbnails to migrate\n`);

let ok = 0, fail = 0;

for (const slug of toProcess) {
  const thumbPath = path.join(PUBLIC_DIR, slug, "thumbnail.jpg");
  const r2Key     = `blog/bai-viet/${slug}/thumbnail.jpg`;
  const r2Url     = `${R2_PUBLIC_BASE_URL}/${r2Key}`;
  const mdPath    = path.join(CONTENT_DIR, slug, "index.md");

  process.stdout.write(`  ${slug} ... `);

  try {
    // 1. Upload to R2
    const body = await fs.readFile(thumbPath);
    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: r2Key,
      Body: body,
      ContentType: "image/jpeg",
      CacheControl: "public, max-age=31536000, immutable",
    }));

    // 2. Update frontmatter in index.md
    const md = await fs.readFile(mdPath, "utf-8");
    const updated = md.replace(/^(thumbnail:\s*).*$/m, `$1'${r2Url}'`);
    if (updated === md) {
      console.log(`⚠️  no thumbnail field in frontmatter`);
    } else {
      await fs.writeFile(mdPath, updated, "utf-8");
      // 3. Delete local file
      await fs.unlink(thumbPath);
      // Remove dir if empty
      const remaining = await fs.readdir(path.join(PUBLIC_DIR, slug));
      if (remaining.length === 0) await fs.rmdir(path.join(PUBLIC_DIR, slug));
      console.log(`✅ ${r2Url}`);
      ok++;
    }
  } catch (err: any) {
    console.log(`❌ ${err.message}`);
    fail++;
  }
}

console.log(`\nDone: ${ok} migrated, ${fail} failed`);
