import assert from "node:assert/strict";
import test from "node:test";
import { repacketizeOggOpusToCode3 } from "./oggOpus";

function oggCrc(page: Buffer) {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : page[i]!;
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    crc >>>= 0;
  }
  return crc >>> 0;
}

function makePage(headerType: number, granule: number, serial: number, sequence: number, packet: Buffer) {
  const segments: number[] = [];
  let remaining = packet.length;
  while (remaining >= 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining);
  const header = Buffer.alloc(27 + segments.length);
  header.write("OggS");
  header[5] = headerType;
  header.writeBigUInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = segments.length;
  segments.forEach((segment, index) => { header[27 + index] = segment; });
  const page = Buffer.concat([header, packet]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function makeOgg(audioPackets: Buffer[]) {
  const head = Buffer.alloc(19);
  head.write("OpusHead");
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(16000, 12);
  const vendor = Buffer.from("test");
  const tags = Buffer.alloc(16 + vendor.length);
  tags.write("OpusTags");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);
  return Buffer.concat([
    makePage(0x02, 0, 42, 0, head),
    makePage(0, 0, 42, 1, tags),
    ...audioPackets.map((packet, index) => makePage(index === audioPackets.length - 1 ? 0x04 : 0, 312 + (index + 1) * 960 - (index === audioPackets.length - 1 ? 120 : 0), 42, index + 2, packet))
  ]);
}

function readPackets(input: Buffer) {
  const packets: Buffer[] = [];
  const granules: bigint[] = [];
  let offset = 0;
  while (offset < input.length) {
    assert.equal(input.toString("ascii", offset, offset + 4), "OggS");
    granules.push(input.readBigUInt64LE(offset + 6));
    const segmentCount = input[offset + 26]!;
    let bodyOffset = offset + 27 + segmentCount;
    let packet = Buffer.alloc(0);
    for (let i = 0; i < segmentCount; i++) {
      const length = input[offset + 27 + i]!;
      packet = Buffer.concat([packet, input.subarray(bodyOffset, bodyOffset + length)]);
      bodyOffset += length;
      if (length < 255) {
        packets.push(packet);
        packet = Buffer.alloc(0);
      }
    }
    const page = input.subarray(offset, bodyOffset);
    assert.equal(page.readUInt32LE(22), oggCrc(page));
    offset = bodyOffset;
  }
  return { packets, granules };
}

test("repacketizes mono Opus code-0 frames into iOS-compatible code-3 packets", () => {
  const sourceFrames = Array.from({ length: 5 }, (_, index) => Buffer.from([0x48, index + 1, 0xaa]));
  const input = makeOgg(sourceFrames);
  const output = repacketizeOggOpusToCode3(input);
  const { packets, granules } = readPackets(output);

  assert.deepEqual(packets.slice(0, 2).map((packet) => packet.subarray(0, 8).toString()), ["OpusHead", "OpusTags"]);
  assert.equal(packets.length, 4);
  assert.deepEqual(packets.slice(2).map((packet) => packet[0]! & 0x03), [3, 3]);
  assert.deepEqual(packets.slice(2).map((packet) => packet[1]! & 0x3f), [3, 2]);
  assert.equal(granules.at(-1), 312n + 5n * 960n - 120n);
});

test("leaves non-OGG and already packetized streams unchanged", () => {
  const junk = Buffer.from("not an OGG stream");
  const code3 = makeOgg([Buffer.from([0x4b, 0x81, 0x7f])]);
  assert.equal(repacketizeOggOpusToCode3(junk), junk);
  assert.equal(repacketizeOggOpusToCode3(code3), code3);
});

test("rejects invalid frame grouping limits", () => {
  assert.throws(() => repacketizeOggOpusToCode3(Buffer.alloc(0), 0), /between 1 and 48/);
});
