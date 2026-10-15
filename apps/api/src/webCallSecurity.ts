import { createHash, createHmac, randomBytes } from "node:crypto";

export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: "password";
};

export function createWebCallToken() {
  return randomBytes(32).toString("base64url");
}

export function isWebCallToken(value: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function hashWebCallToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createIceServers(input: {
  stunUrls: string[];
  turnUrls: string[];
  turnSharedSecret: string;
  subject: string;
  now?: number;
}): IceServerConfig[] {
  const servers: IceServerConfig[] = input.stunUrls.map((urls) => ({ urls }));
  if (input.turnUrls.length && input.turnSharedSecret) {
    const username = `${Math.floor((input.now ?? Date.now()) / 1000) + 3600}:${input.subject}`;
    const credential = createHmac("sha1", input.turnSharedSecret).update(username).digest("base64");
    servers.push({ urls: input.turnUrls, username, credential, credentialType: "password" });
  }
  return servers;
}
