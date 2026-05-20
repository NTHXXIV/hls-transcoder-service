import { promises as fs } from "node:fs";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createR2Client } from "../src/shared/r2.js";

const R2_ENDPOINT          = process.env.R2_ENDPOINT ?? "";
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET            = process.env.R2_BUCKET ?? "";
const BASE                 = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
const STAGAPPS             = "/Users/nth/stagapps/apps/stag";

const files = [
  { slug: "nha-sang-lap-efishery-bi-ket-an-9-nam-tu-nha-dau-tu-nho-le", file: "may-cho-ca-an-efishery.jpg" },
  { slug: "vinfast-tai-co-cau", file: "519f7a4a7753f60daf42.jpg" },
  { slug: "vinfast-tai-co-cau", file: "117724992980a8def191.jpg" },
];

const orphans = [
  `${STAGAPPS}/public/blog/bai-viet/vinfast-tai-co-cau/3bd5453d4824c97a9035.jpg`,
];

const client = createR2Client(R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);

for (const { slug, file } of files) {
  const localPath = `${STAGAPPS}/public/blog/bai-viet/${slug}/${file}`;
  const r2Key     = `blog/bai-viet/${slug}/${file}`;
  const r2Url     = `${BASE}/${r2Key}`;

  const body = await fs.readFile(localPath);
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: r2Key, Body: body,
    ContentType: "image/jpeg",
    CacheControl: "public, max-age=31536000, immutable",
  }));

  const mdPath = `${STAGAPPS}/content/blog/bai-viet/${slug}/index.md`;
  const md = await fs.readFile(mdPath, "utf-8");
  await fs.writeFile(mdPath, md.replaceAll(`./${file}`, r2Url), "utf-8");
  await fs.unlink(localPath);
  console.log(`✅ ${r2Url}`);
}

for (const p of orphans) {
  await fs.unlink(p);
  console.log(`🗑  deleted orphan: ${p}`);
}

// Clean up empty dirs
for (const slug of ["nha-sang-lap-efishery-bi-ket-an-9-nam-tu-nha-dau-tu-nho-le", "vinfast-tai-co-cau"]) {
  const dir = `${STAGAPPS}/public/blog/bai-viet/${slug}`;
  const remaining = await fs.readdir(dir);
  if (remaining.length === 0) { await fs.rmdir(dir); console.log(`🗑  removed dir: ${slug}`); }
}
