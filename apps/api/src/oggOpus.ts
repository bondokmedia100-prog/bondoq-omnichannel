const oggCrcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let value = (i << 24) >>> 0;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 0x80000000 ? ((value << 1) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0;
    }
    table[i] = value;
  }
  return table;
})();

function oggCrc(page: Buffer) {
  let crc = 0;
  for (const byte of page) crc = (((crc << 8) >>> 0) ^ oggCrcTable[((crc >>> 24) & 0xff) ^ byte]!) >>> 0;
  return crc;
}

function readOggPackets(input: Buffer) {
  const packets: Buffer[] = [];
  let fragments: Buffer[] = [];
  let offset = 0;
  let serial: number | undefined;
  let finalGranule: bigint | undefined;

  while (offset < input.length) {
    if (offset + 27 > input.length || input.toString("ascii", offset, offset + 4) !== "OggS" || input[offset + 4] !== 0) return null;
    const pageSerial = input.readUInt32LE(offset + 14);
    if (serial !== undefined && serial !== pageSerial) return null;
    serial = pageSerial;
    finalGranule = input.readBigUInt64LE(offset + 6);

    const segmentCount = input[offset + 26]!;
    const tableStart = offset + 27;
    const bodyStart = tableStart + segmentCount;
    if (bodyStart > input.length) return null;
    let bodyOffset = bodyStart;
    for (let i = 0; i < segmentCount; i++) {
      const segmentLength = input[tableStart + i]!;
      if (bodyOffset + segmentLength > input.length) return null;
      fragments.push(input.subarray(bodyOffset, bodyOffset + segmentLength));
      bodyOffset += segmentLength;
      if (segmentLength < 255) {
        packets.push(Buffer.concat(fragments));
        fragments = [];
      }
    }
    offset = bodyOffset;
  }

  if (fragments.length || packets.length < 3 || packets[0]!.subarray(0, 8).toString("ascii") !== "OpusHead" || packets[1]!.subarray(0, 8).toString("ascii") !== "OpusTags" || packets[0]!.length < 12 || finalGranule === 0xffffffffffffffffn) return null;
  return { packets, serial: serial!, preSkip: packets[0]!.readUInt16LE(10), finalGranule: finalGranule! };
}

function encodeFrameLength(length: number) {
  if (length < 252) return [length];
  const first = 252 + (length % 4);
  return [first, Math.floor((length - first) / 4)];
}

function buildOggPage(headerType: number, granule: number | bigint, serial: number, sequence: number, packet: Buffer) {
  const segments: number[] = [];
  let remaining = packet.length;
  while (remaining >= 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining);

  const header = Buffer.alloc(27 + segments.length);
  header.write("OggS", 0, "ascii");
  header[5] = headerType;
  header.writeBigUInt64LE(typeof granule === "bigint" ? granule : BigInt(granule), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = segments.length;
  for (let i = 0; i < segments.length; i++) header[27 + i] = segments[i]!;

  const page = Buffer.concat([header, packet]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function frameSamples48k(toc: number) {
  const config = (toc >>> 3) & 0x1f;
  if (config < 12) return [480, 960, 1920, 2880][config % 4]!;
  if (config < 16) return config % 2 === 0 ? 480 : 960;
  return [120, 240, 480, 960][config % 4]!;
}

export function repacketizeOggOpusToCode3(input: Buffer, framesPerPacket = 3) {
  if (!Number.isInteger(framesPerPacket) || framesPerPacket < 1 || framesPerPacket > 48) {
    throw new Error("framesPerPacket must be an integer between 1 and 48");
  }
  if (input.length < 4 || input.toString("ascii", 0, 4) !== "OggS") return input;

  const parsed = readOggPackets(input);
  if (!parsed) return input;
  const sourceFrames = parsed.packets.slice(2);
  if (!sourceFrames.length || sourceFrames.some((packet) => packet.length < 1 || (packet[0]! & 0x03) !== 0)) return input;

  const frames = sourceFrames.map((packet) => ({
    configStereo: packet[0]! >>> 2,
    samples: frameSamples48k(packet[0]!),
    data: packet.subarray(1)
  }));
  const pages = [
    buildOggPage(0x02, 0, parsed.serial, 0, parsed.packets[0]!),
    buildOggPage(0, 0, parsed.serial, 1, parsed.packets[1]!)
  ];
  let sequence = 2;
  let samplesDone = 0;
  let index = 0;

  while (index < frames.length) {
    const configStereo = frames[index]!.configStereo;
    const group: typeof frames = [];
    let groupSamples = 0;
    while (
      index < frames.length &&
      group.length < framesPerPacket &&
      groupSamples + frames[index]!.samples <= 5760 &&
      frames[index]!.configStereo === configStereo
    ) {
      const frame = frames[index++]!;
      group.push(frame);
      groupSamples += frame.samples;
      samplesDone += frame.samples;
    }

    const toc = ((configStereo << 2) | 3) & 0xff;
    const lengths = group.slice(0, -1).flatMap((frame) => encodeFrameLength(frame.data.length));
    const packet = Buffer.concat([Buffer.from([toc, 0x80 | group.length, ...lengths]), ...group.map((frame) => frame.data)]);
    const isLast = index >= frames.length;
    const decodedGranule = BigInt(parsed.preSkip + samplesDone);
    if (isLast && (parsed.finalGranule < decodedGranule - BigInt(groupSamples) || parsed.finalGranule > decodedGranule)) return input;
    pages.push(buildOggPage(isLast ? 0x04 : 0, isLast ? parsed.finalGranule : decodedGranule, parsed.serial, sequence++, packet));
  }

  return Buffer.concat(pages);
}
