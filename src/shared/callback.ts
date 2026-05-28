export function toSecretKey(id: string) {
  return `HLS_CALLBACK_SECRET_${id.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}

export function resolveCallbackSecret(
  callbackClientId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!callbackClientId) {
    const single = env.HLS_CALLBACK_SECRET;
    if (!single) throw new Error("Missing HLS_CALLBACK_SECRET");
    return single;
  }

  const envKey = toSecretKey(callbackClientId);
  const secret = env[envKey];
  if (!secret) {
    throw new Error(`Missing callback secret env: ${envKey}`);
  }
  return secret;
}

export function validateCallbackUrl(
  callbackUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!callbackUrl) return;

  try {
    const cbUrl = new URL(callbackUrl);
    const allowedRaw = env.ALLOWED_CALLBACK_DOMAINS;
    if (!allowedRaw) {
      throw new Error("ALLOWED_CALLBACK_DOMAINS env variable is not set");
    }
    const allowedDomains = allowedRaw
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);

    if (!allowedDomains.some((d) => cbUrl.hostname.endsWith(d))) {
      throw new Error(
        `Unauthorized callback domain: ${cbUrl.hostname}. Allowed: ${allowedRaw}`,
      );
    }
  } catch (e: any) {
    throw new Error(`Security Error (Callback Validation): ${e.message}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a callback to the backend.
 *
 * Options:
 * - throwOnFail: if true, throws after all retries exhausted — use for final
 *   (success/failed) callbacks so GitHub Actions marks the job as failed and
 *   it can be re-run manually. Default false (intermediate status callbacks).
 * - maxRetries: number of retries for 5xx / network errors. Default 3.
 *
 * 4xx responses are never retried (wrong secret, bad payload = config/code bug).
 */
export async function sendCallback(
  callbackUrl: string | undefined,
  body: Record<string, unknown>,
  callbackClientId?: string,
  options: { throwOnFail?: boolean; maxRetries?: number } = {},
) {
  if (!callbackUrl) return;

  const { throwOnFail = false, maxRetries = 3 } = options;
  const callbackSecret = resolveCallbackSecret(callbackClientId);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 16_000); // 1s, 2s, 4s, 8s
      console.warn(`[callback] Retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1})...`);
      await sleep(delayMs);
    }

    try {
      const res = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hls-callback-secret": callbackSecret,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) return;

      const txt = await res.text().catch(() => "");

      // 4xx = client error, retrying won't help
      if (res.status >= 400 && res.status < 500) {
        const err = new Error(`Callback rejected ${res.status}: ${txt}`);
        if (throwOnFail) throw err;
        console.warn(`[callback] ${err.message} (not retrying 4xx)`);
        return;
      }

      // 5xx = server error, retry
      lastError = new Error(`Callback failed ${res.status}: ${txt}`);
      console.warn(`[callback] attempt ${attempt + 1}: ${lastError.message}`);
    } catch (err: any) {
      // Re-throw 4xx errors immediately (already decided above)
      if (err.message.startsWith("Callback rejected")) throw err;
      lastError = err;
      console.warn(`[callback] attempt ${attempt + 1}: network error: ${err.message}`);
    }
  }

  const finalError = new Error(
    `Callback failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
  );
  if (throwOnFail) throw finalError;
  console.warn(`[callback] ${finalError.message} — giving up`);
}
