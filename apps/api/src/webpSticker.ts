export function isAnimatedWebp(value: Uint8Array) {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (kind === "ANIM" || kind === "ANMF") return true;
    offset += 8 + size + (size & 1);
  }
  return false;
}

export function isWebmContainer(value: Uint8Array) {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}
