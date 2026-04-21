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

export async function sendCallback(
  callbackUrl: string | undefined,
  body: Record<string, unknown>,
  callbackClientId?: string,
) {
  if (!callbackUrl) return;
  try {
    const callbackSecret = resolveCallbackSecret(callbackClientId);

    const res = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hls-callback-secret": callbackSecret,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`Callback failed ${res.status}: ${txt}`);
    }
  } catch (error) {
    console.warn(`Callback request failed:`, error);
  }
}
