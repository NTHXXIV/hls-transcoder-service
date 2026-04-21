import { constants, privateDecrypt } from "node:crypto";

export function decrypt(encryptedValue: string, privateKey?: string): string {
  if (!privateKey) {
    console.warn("TRANSCODER_PRIVATE_KEY not set, using raw value.");
    return encryptedValue;
  }
  try {
    const buffer = Buffer.from(encryptedValue, "base64");
    return privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      buffer,
    ).toString("utf-8");
  } catch (e: any) {
    console.warn(`Decryption failed: ${e.message}. Using raw value.`);
    return encryptedValue;
  }
}
