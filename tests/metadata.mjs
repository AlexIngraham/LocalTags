// Run with: node --test tests/metadata.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { readSourceMetadata } from "../metadata.js";
import { ID3Writer } from "browser-id3-writer";

const ascii = (value) => Buffer.from(value, "latin1");
const be = (value, length = 4) => {
  const bytes = Buffer.alloc(length);
  bytes.writeUIntBE(value, 0, length);
  return bytes;
};
const le = (value, length = 4) => {
  const bytes = Buffer.alloc(length);
  bytes.writeUIntLE(value, 0, length);
  return bytes;
};
const sync = (value) => Buffer.from([value >>> 21 & 127, value >>> 14 & 127, value >>> 7 & 127, value & 127]);
const file = (bytes, name = "source.mp3") => new File([bytes], name);
const text = (value) => Buffer.concat([Buffer.from([3]), Buffer.from(value)]);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");

function frame(id, bytes, version = 3, flags = 0) {
  return Buffer.concat([ascii(id), version === 2 ? be(bytes.length, 3) : version === 4 ? sync(bytes.length) : be(bytes.length),
    ...(version === 2 ? [] : [Buffer.from([0, flags])]), bytes]);
}

function tag(frames, version = 3, flags = 0) {
  const body = Buffer.concat(frames);
  return Buffer.concat([ascii("ID3"), Buffer.from([version, 0, flags]), sync(body.length), body]);
}

function unsync(bytes) {
  return Buffer.from([...bytes].flatMap((value, index) => value === 0xff && (bytes[index + 1] === 0 || bytes[index + 1] >= 0xe0)
    ? [value, 0] : [value]));
}

const apic = (picture = png, type = 3) => Buffer.concat([Buffer.from([0]), ascii("image/png\0"), Buffer.from([type, 0]), picture]);
const flacBlock = (type, bytes, last = false) => Buffer.concat([Buffer.from([type | (last ? 128 : 0)]), be(bytes.length, 3), bytes]);
const waveChunk = (id, bytes) => Buffer.concat([ascii(id), le(bytes.length), bytes, ...(bytes.length % 2 ? [Buffer.from([0])] : [])]);
const wave = (chunks) => {
  const body = Buffer.concat([ascii("WAVE"), ...chunks]);
  return Buffer.concat([ascii("RIFF"), le(body.length), body]);
};

test("imports real browser-id3-writer tags, UTF-16 text, track/total and artwork", async () => {
  const writer = new ID3Writer(new Uint8Array(100).buffer);
  writer.setFrame("TIT2", "夜の歌 — Café");
  writer.setFrame("TPE1", ["Artist"]);
  writer.setFrame("TALB", "Album");
  writer.setFrame("TRCK", "3/10");
  writer.setFrame("TCON", ["Jazz"]);
  writer.setFrame("APIC", { type: 3, data: png, description: "Cover" });
  writer.addTag();
  const metadata = await readSourceMetadata(file(writer.getBlob()));
  assert.deepEqual({ ...metadata, cover: undefined }, {
    title: "夜の歌 — Café", artist: "Artist", album: "Album", track: "3/10", genre: "Jazz", cover: undefined,
  });
  assert.equal(metadata.cover.type, "image/png");
  assert.deepEqual(Buffer.from(await metadata.cover.arrayBuffer()), png);
});

test("reads ID3v2.4 synchsafe sizes and multiple UTF-8 values", async () => {
  const title = "A long title ".repeat(20);
  const metadata = await readSourceMetadata(file(tag([
    frame("TIT2", text(title), 4), frame("TPE1", text("First\0Second\0"), 4),
    frame("TRCK", text("4"), 4), frame("TCON", text("(17)"), 4),
  ], 4)));
  assert.deepEqual(metadata, { title: title.trim(), artist: "First; Second", track: "4", genre: "Rock" });
});

test("reads ID3v2.2 text and PIC cover frames", async () => {
  const picture = Buffer.concat([Buffer.from([0]), ascii("PNG"), Buffer.from([3, 0]), png]);
  const metadata = await readSourceMetadata(file(tag([
    frame("TT2", Buffer.concat([Buffer.from([0]), ascii("Legacy title")]), 2),
    frame("PIC", picture, 2),
  ], 2)));
  assert.equal(metadata.title, "Legacy title");
  assert.equal(metadata.cover.type, "image/png");
});

test("handles ID3v2.3 tag unsynchronization and extended headers", async () => {
  const title = Buffer.from([1, 0xff, 0xfe, 65, 0, 66, 0]);
  const extendedHeader = Buffer.concat([be(6), Buffer.alloc(6)]);
  const body = unsync(Buffer.concat([extendedHeader, frame("TIT2", title), frame("TALB", text("Album"))]));
  const source = Buffer.concat([ascii("ID3"), Buffer.from([3, 0, 0xc0]), sync(body.length), body]);
  assert.deepEqual(await readSourceMetadata(file(source)), { title: "AB", album: "Album" });
});

test("handles ID3v2.4 unsynchronization, grouping, length indicator and extended header", async () => {
  const title = Buffer.from([1, 0xff, 0xfe, 65, 0, 66, 0]);
  const payload = unsync(Buffer.concat([Buffer.from([9]), sync(title.length), title]));
  const source = tag([
    Buffer.concat([sync(6), Buffer.from([1, 0])]), frame("TIT2", payload, 4, 0x43),
    frame("TALB", text("Next frame"), 4),
  ], 4, 0x40);
  assert.deepEqual(await readSourceMetadata(file(source)), { title: "AB", album: "Next frame" });
});

test("skips encrypted/compressed ID3 frames and retains later readable tags", async () => {
  assert.deepEqual(await readSourceMetadata(file(tag([
    frame("TIT2", text("Encrypted"), 3, 0x40), frame("TALB", text("Compressed"), 3, 0x80),
    frame("TPE1", text("Readable")),
  ]))), { artist: "Readable" });
});

test("prefers a front cover and never imports linked or unrecognized images", async () => {
  const metadata = await readSourceMetadata(file(tag([
    frame("APIC", apic(Buffer.from("GIF89aFake image"), 4)),
    frame("APIC", apic(png, 3)),
    frame("APIC", apic(Buffer.from("GIF89aAnother image"), 3)),
  ])));
  assert.deepEqual(Buffer.from(await metadata.cover.arrayBuffer()), png);
  assert.deepEqual(await readSourceMetadata(file(tag([frame("APIC", apic(ascii("https://example.com/image.png")))]))), {});
});

test("falls back to ID3v1 without replacing newer fields", async () => {
  const legacy = Buffer.alloc(128);
  legacy.write("TAG"); legacy.write("Old title", 3); legacy.write("Legacy artist", 33); legacy.write("Legacy album", 63);
  legacy[126] = 7; legacy[127] = 8;
  const source = Buffer.concat([tag([frame("TIT2", text("Modern title"))]), Buffer.alloc(100), legacy]);
  assert.deepEqual(await readSourceMetadata(file(source)), {
    title: "Modern title", artist: "Legacy artist", album: "Legacy album", track: "7", genre: "Jazz",
  });
});

test("reads FLAC comments, track total, duration and picture", async () => {
  const streaminfo = Buffer.alloc(34);
  const packed = (44100n << 44n) | (1n << 41n) | (15n << 36n) | 88200n;
  streaminfo.writeBigUInt64BE(packed, 10);
  const comments = ["TITLE=FLAC title", "ARTIST=Artíst", "ALBUM=Album", "TRACKNUMBER=2", "TRACKTOTAL=12", "GENRE=Jazz"];
  const vorbis = Buffer.concat([le(0), le(comments.length), ...comments.flatMap((entry) => {
    const bytes = Buffer.from(entry); return [le(bytes.length), bytes];
  })]);
  const picture = Buffer.concat([be(3), be(9), ascii("image/png"), be(0), be(1), be(1), be(24), be(0), be(png.length), png]);
  const source = Buffer.concat([ascii("fLaC"), flacBlock(0, streaminfo), flacBlock(1, Buffer.alloc(10)), flacBlock(4, vorbis), flacBlock(6, picture, true)]);
  const metadata = await readSourceMetadata(file(source, "source.flac"));
  assert.deepEqual({ ...metadata, cover: undefined }, {
    title: "FLAC title", artist: "Artíst", album: "Album", track: "2/12", genre: "Jazz", duration: 2, cover: undefined,
  });
  assert.deepEqual(Buffer.from(await metadata.cover.arrayBuffer()), png);
});

test("reads WAV INFO after audio data and calculates PCM duration", async () => {
  const fmt = Buffer.concat([le(1, 2), le(1, 2), le(8000), le(16000), le(2, 2), le(16, 2)]);
  const source = wave([
    waveChunk("fmt ", fmt), waveChunk("data", Buffer.alloc(32000)),
    waveChunk("LIST", Buffer.concat([ascii("INFO"), waveChunk("INAM", Buffer.from("Title\0")), waveChunk("IART", Buffer.from("Café\0")), waveChunk("ITRK", ascii("3/8\0"))])),
  ]);
  assert.deepEqual(await readSourceMetadata(file(source, "source.wav")), { title: "Title", artist: "Café", track: "3/8", duration: 2 });
});

test("reads ID3 tags stored in a WAV chunk", async () => {
  const source = wave([waveChunk("id3 ", tag([frame("TIT2", text("Embedded ID3"))]))]);
  assert.deepEqual(await readSourceMetadata(file(source, "source.wav")), { title: "Embedded ID3" });
});

test("skips malformed tags, unavailable files, and unsupported source formats", async () => {
  for (const bytes of [Buffer.alloc(0), ascii("not an audio file"), tag([ascii("TIT2"), be(999999), Buffer.alloc(8)]),
    Buffer.concat([ascii("fLaC"), flacBlock(4, Buffer.from([255, 255, 255, 255]), true)])]) {
    assert.deepEqual(await readSourceMetadata(file(bytes)), {});
  }
  assert.deepEqual(await readSourceMetadata({ size: 200, slice() { throw Error("File unavailable"); } }), {});
});

test("does not allocate or read the declared body of oversized ID3 tags", async () => {
  const header = Buffer.concat([ascii("ID3"), Buffer.from([3, 0, 0]), sync(200 * 1024 * 1024), Buffer.alloc(2)]);
  let totalRead = 0;
  const source = {
    size: 1024 * 1024 * 1024,
    slice(start, end) {
      totalRead += end - start;
      assert.ok(end - start < 1024);
      return new Blob([start === 0 ? header : Buffer.alloc(end - start)]);
    },
  };
  assert.deepEqual(await readSourceMetadata(source), {});
  assert.equal(totalRead, 140);
});

test("seeks past large WAV audio chunks without reading their contents", async () => {
  const audioSize = 200 * 1024 * 1024;
  const info = waveChunk("LIST", Buffer.concat([ascii("INFO"), waveChunk("INAM", ascii("Large audio\0"))]));
  const header = Buffer.concat([ascii("RIFF"), le(12 + audioSize + info.length), ascii("WAVEdata"), le(audioSize)]);
  const infoOffset = header.length + audioSize;
  let totalRead = 0;
  const source = {
    size: infoOffset + info.length,
    slice(start, end) {
      totalRead += end - start;
      assert.ok(end - start < 1024);
      const bytes = Buffer.alloc(end - start);
      for (let i = start; i < end; i++) {
        if (i < header.length) bytes[i - start] = header[i];
        if (i >= infoOffset) bytes[i - start] = info[i - infoOffset];
      }
      return new Blob([bytes]);
    },
  };
  assert.deepEqual(await readSourceMetadata(source), { title: "Large audio" });
  assert.ok(totalRead < 256);
});

test("retains valid earlier tags when later frames are truncated", async () => {
  const source = tag([frame("TIT2", text("Keep this")), ascii("TALB"), be(10000), Buffer.alloc(2)]);
  assert.deepEqual(await readSourceMetadata(file(source)), { title: "Keep this" });
});
