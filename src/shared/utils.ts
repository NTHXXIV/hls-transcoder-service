import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (e) => {
      const res = path.resolve(dir, e.name);
      return e.isDirectory() ? listFilesRecursive(res) : [res];
    }),
  );
  return files.flat();
}

export function getContentType(p: string) {
  if (p.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (p.endsWith(".ts")) return "video/mp2t";
  if (p.endsWith(".json")) return "application/json";
  if (p.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

export async function extractAudio(inputPath: string, outputPath: string): Promise<void> {
  // Extract audio as mono 16khz wav (best for Whisper)
  const args = [
    "-y",
    "-i", inputPath,
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", "16000",
    "-ac", "1",
    outputPath
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg audio extract failed with code ${code}`)));
  });
}

export async function getVideoDuration(
  inputPath: string,
): Promise<number | null> {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputPath,
  ];
  return new Promise<number | null>((resolve) => {
    const child = spawn("ffprobe", args);
    let output = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`ffprobe exited with code ${code} for ${inputPath}`);
        return resolve(null);
      }
      const duration = parseFloat(output.trim());
      if (isNaN(duration) || duration <= 0) {
        console.warn(`ffprobe returned invalid duration: ${output}`);
        return resolve(null);
      }
      // Round to 2 decimal places
      resolve(Math.round(duration * 100) / 100);
    });
    child.on("error", (err) => {
      console.warn(`ffprobe error: ${err.message}`);
      resolve(null);
    });
  });
}
