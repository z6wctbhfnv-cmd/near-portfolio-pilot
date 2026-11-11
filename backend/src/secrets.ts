/** Encrypts grant tokens at rest (AES-256-GCM). The token never leaves the backend in clear. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    // Any string works; it is stretched to 32 bytes. Use 32+ random bytes in production.
    this.key = createHash("sha256").update(`near-portfolio-pilot:v1:${masterKey}`).digest();
  }

  /**
   * Uses PILOT_MASTER_KEY when set; otherwise creates (once) a random key file next to the
   * database with mode 0600, so a dev setup works without manual steps.
   */
  static fromConfig(masterKey: string | undefined, keyFile: string): SecretBox {
    if (masterKey) return new SecretBox(masterKey);
    if (!existsSync(keyFile)) {
      mkdirSync(dirname(keyFile), { recursive: true });
      writeFileSync(keyFile, randomBytes(32).toString("base64url"), { mode: 0o600 });
    }
    chmodSync(keyFile, 0o600);
    return new SecretBox(readFileSync(keyFile, "utf8").trim());
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  open(sealed: string): string {
    const [v, iv, tag, body] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !body) throw new Error("bad sealed value");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  }
}
