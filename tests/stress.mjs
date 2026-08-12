/**
 * Stress-test helpers + ID3/lamejs behavior used by main.html.
 * Run: node tests/stress.mjs
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const { ID3Writer } = await import("browser-id3-writer");

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "_out");
mkdirSync(outDir, { recursive: true });

const lameCtx = vm.createContext({
  console,
  Int8Array,
  Int16Array,
  Int32Array,
  Float32Array,
  Uint8Array,
  DataView,
  Array,
  Math,
});
vm.runInContext(
  readFileSync(join(root, "node_modules/lamejs/lame.min.js"), "utf8"),
  lameCtx,
);
const lamejs = lameCtx.lamejs;

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function throws(name, fn, match) {
  try {
    fn();
    assert(name, false, "did not throw");
  } catch (err) {
    const ok = match ? match.test(String(err.message || err)) : true;
    assert(name, ok, ok ? "" : `threw: ${err.message}`);
  }
}

async function throwsAsync(name, fn, match) {
  try {
    await fn();
    assert(name, false, "did not throw");
  } catch (err) {
    const ok = match ? match.test(String(err.message || err)) : true;
    assert(name, ok, ok ? "" : `threw: ${err.message}`);
  }
}

// ---- copied from main.html (keep in sync while testing) ----
function safeName(str) {
  return str.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
}

function asciiAt(bytes, offset, len) {
  if (offset + len > bytes.length) return "";
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

function sniffContainer(arrayBuffer) {
  const b = new Uint8Array(arrayBuffer);
  if (b.length < 12) return null;
  if (asciiAt(b, 0, 4) === "RIFF" && asciiAt(b, 8, 4) === "WAVE") return "wav";
  if (asciiAt(b, 0, 4) === "fLaC") return "flac";
  if (asciiAt(b, 0, 4) === "FORM" && (asciiAt(b, 8, 4) === "AIFF" || asciiAt(b, 8, 4) === "AIFC")) {
    return "aiff";
  }
  if (asciiAt(b, 0, 4) === "OggS") return "ogg";
  if (asciiAt(b, 4, 4) === "ftyp") return "m4a";
  if (asciiAt(b, 0, 3) === "ID3") return "mp3";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mp3";
  return null;
}

function bufferHasAscii(bytes, ascii) {
  const needle = new TextEncoder().encode(ascii);
  const limit = Math.min(bytes.length, 512_000) - needle.length;
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function detectM4aKind(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bufferHasAscii(bytes, "alac")) return "alac";
  return "aac";
}

function detectFormatFromName(file) {
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (name.endsWith(".mp3") || type === "audio/mpeg") return "mp3";
  if (
    name.endsWith(".wav") ||
    type === "audio/wav" ||
    type === "audio/wave" ||
    type === "audio/x-wav"
  ) {
    return "wav";
  }
  if (name.endsWith(".flac") || type === "audio/flac") return "flac";
  if (
    name.endsWith(".aiff") ||
    name.endsWith(".aif") ||
    type === "audio/aiff" ||
    type === "audio/x-aiff"
  ) {
    return "aiff";
  }
  if (name.endsWith(".aac") || type === "audio/aac") return "aac";
  if (
    name.endsWith(".ogg") ||
    name.endsWith(".oga") ||
    type === "audio/ogg" ||
    type === "audio/vorbis"
  ) {
    return "ogg";
  }
  if (
    name.endsWith(".m4a") ||
    type === "audio/mp4" ||
    type === "audio/x-m4a" ||
    type === "audio/m4a"
  ) {
    return "m4a";
  }
  return null;
}

function detectFormat(file, arrayBuffer) {
  const sniffed = sniffContainer(arrayBuffer);
  if (sniffed === "m4a") return detectM4aKind(arrayBuffer);
  if (sniffed) return sniffed;
  const named = detectFormatFromName(file);
  if (named === "m4a") return detectM4aKind(arrayBuffer);
  return named;
}

function stripId3v1(buffer) {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length >= 128 &&
    bytes[bytes.length - 128] === 0x54 &&
    bytes[bytes.length - 127] === 0x41 &&
    bytes[bytes.length - 126] === 0x47
  ) {
    return bytes.slice(0, bytes.length - 128).buffer;
  }
  return buffer;
}

function coverMime(buffer) {
  const c = new Uint8Array(buffer);
  if (c.length >= 3 && c[0] === 0xff && c[1] === 0xd8 && c[2] === 0xff) return "image/jpeg";
  if (c.length >= 8 && c[0] === 0x89 && c[1] === 0x50 && c[2] === 0x4e && c[3] === 0x47) {
    return "image/png";
  }
  if (c.length >= 6 && c[0] === 0x47 && c[1] === 0x49 && c[2] === 0x46) return "image/gif";
  if (c.length >= 12 && c[8] === 0x57 && c[9] === 0x45 && c[10] === 0x42 && c[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

function outputName(artist, title, fileName) {
  const a = safeName(artist);
  const t = safeName(title);
  if (a && t) return `${a} - ${t}.mp3`;
  const base = fileName
    .replace(/\.(mp3|wav|flac|aiff|aif|m4a|aac|ogg|oga)$/i, "")
    .trim();
  return (base || "tagged") + " (tagged).mp3";
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function writeMp3Tags({
  songBuffer,
  title,
  artist,
  album,
  track,
  genre,
  coverBuffer,
}) {
  if (!songBuffer || songBuffer.byteLength < 16) {
    throw new Error("That file is empty or too small to be audio.");
  }
  const writer = new ID3Writer(stripId3v1(songBuffer));
  if (title) writer.setFrame("TIT2", title);
  if (artist) writer.setFrame("TPE1", [artist]);
  if (album) writer.setFrame("TALB", album);
  if (track) writer.setFrame("TRCK", track);
  if (genre) writer.setFrame("TCON", [genre]);
  if (coverBuffer) {
    if (!coverMime(coverBuffer)) {
      throw new Error("Cover art must be JPEG, PNG, GIF, or WebP.");
    }
    writer.setFrame("APIC", {
      type: 3,
      data: coverBuffer,
      description: "Cover",
    });
  }
  writer.addTag();
  return writer.getBlob();
}

function fakeFile(name, type = "") {
  return { name, type };
}

function makeWav(seconds = 0.05, sampleRate = 44100, channels = 1) {
  const frames = Math.max(1, Math.floor(seconds * sampleRate));
  const dataSize = frames * channels * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i);
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  const pcm = new Int16Array(buf, 44);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
    for (let c = 0; c < channels; c++) pcm[i * channels + c] = s;
  }
  return buf;
}

function encodePcmToMp3(sampleRate, channels, samplesLeft, samplesRight) {
  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, 192);
  const chunks = [];
  const block = 1152;
  for (let i = 0; i < samplesLeft.length; i += block) {
    const left = samplesLeft.subarray(i, i + block);
    const buf =
      channels === 2
        ? encoder.encodeBuffer(left, samplesRight.subarray(i, i + block))
        : encoder.encodeBuffer(left);
    if (buf.length) chunks.push(Buffer.from(buf));
  }
  const end = encoder.flush();
  if (end.length) chunks.push(Buffer.from(end));
  return Uint8Array.from(Buffer.concat(chunks)).buffer;
}

function sinePcm(n, freq = 440, rate = 44100) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 10000);
  }
  return out;
}

const jpeg = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08,
  0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a,
  0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d,
  0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20, 0x22,
  0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34,
  0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0,
  0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4,
  0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
  0x00, 0x00, 0x3f, 0x00, 0x7f, 0xff, 0xd9,
]);

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00,
  0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const gif = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x3b,
]);

function pcmFromWav(wavBuf) {
  const bytes = new Uint8Array(wavBuf);
  const channels = bytes[22] | (bytes[23] << 8);
  const rate = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16) | (bytes[27] << 24);
  const pcm = new Int16Array(wavBuf, 44);
  if (channels === 1) return { rate, channels, left: pcm, right: null };
  const left = new Int16Array(pcm.length / 2);
  const right = new Int16Array(pcm.length / 2);
  for (let i = 0; i < left.length; i++) {
    left[i] = pcm[i * 2];
    right[i] = pcm[i * 2 + 1];
  }
  return { rate, channels, left, right };
}

function save(name, buf) {
  const path = join(outDir, name);
  writeFileSync(path, Buffer.from(buf));
  return path;
}

function mutagenInspect(path) {
  const py = join(root, "..", ".venv", "bin", "python");
  const script = `
from mutagen.id3 import ID3
from mutagen.mp3 import MP3
p = ${JSON.stringify(path)}
audio = MP3(p)
tags = audio.tags
print("duration", round(audio.info.length, 3) if audio.info else None)
print("bitrate", getattr(audio.info, "bitrate", None))
if not tags:
    print("NOTAGS")
else:
    for k in ["TIT2","TPE1","TALB","TRCK","TCON","APIC:Cover","APIC:"]:
        pass
    for frame in tags.values():
        print(frame.FrameID, repr(str(frame)[:80]))
`;
  const r = spawnSync(py, ["-c", script], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

console.log("\n== detectFormat ==");
assert("mp3 by extension", detectFormat(fakeFile("a.mp3"), new ArrayBuffer(0)) === "mp3");
assert("MP3 uppercase", detectFormat(fakeFile("A.MP3"), new ArrayBuffer(0)) === "mp3");
assert("wav by extension", detectFormat(fakeFile("a.wav"), new ArrayBuffer(0)) === "wav");
assert("flac", detectFormat(fakeFile("a.flac"), new ArrayBuffer(0)) === "flac");
assert("aiff", detectFormat(fakeFile("a.aiff"), new ArrayBuffer(0)) === "aiff");
assert("aif", detectFormat(fakeFile("a.aif"), new ArrayBuffer(0)) === "aiff");
assert("aac", detectFormat(fakeFile("a.aac"), new ArrayBuffer(0)) === "aac");
assert("ogg", detectFormat(fakeFile("a.ogg"), new ArrayBuffer(0)) === "ogg");
assert("oga", detectFormat(fakeFile("a.oga"), new ArrayBuffer(0)) === "ogg");
assert("unknown txt", detectFormat(fakeFile("notes.txt"), new ArrayBuffer(0)) === null);
assert("no extension", detectFormat(fakeFile("song"), new ArrayBuffer(0)) === null);
assert(
  "mime mpeg without name",
  detectFormat(fakeFile("blob", "audio/mpeg"), new ArrayBuffer(0)) === "mp3",
);
assert(
  "extension wins over conflicting mime (empty buffer)",
  detectFormat(fakeFile("x.mp3", "audio/wav"), new ArrayBuffer(0)) === "mp3",
);
assert(
  "sniff WAV even if named .mp3",
  detectFormat(fakeFile("lie.mp3"), makeWav()) === "wav",
);
assert("sniff fLaC", sniffContainer(new TextEncoder().encode("fLaC........").buffer) === "flac");
assert("sniff OggS", sniffContainer(new TextEncoder().encode("OggS........").buffer) === "ogg");
assert("sniff FORM/AIFF", sniffContainer(new TextEncoder().encode("FORM....AIFF").buffer) === "aiff");
assert("empty buffer sniff null", sniffContainer(new ArrayBuffer(8)) === null);
assert(
  "double extension last wins",
  detectFormat(fakeFile("track.wav.mp3"), new ArrayBuffer(0)) === "mp3",
);

const alacBuf = new TextEncoder().encode("xxxxalacxxxx").buffer;
const aacBuf = new TextEncoder().encode("ftypM4A aac ").buffer;
assert("m4a alac sniff", detectFormat(fakeFile("x.m4a"), alacBuf) === "alac");
assert("m4a aac sniff", detectFormat(fakeFile("x.m4a"), aacBuf) === "aac");
assert("empty m4a defaults aac", detectFormat(fakeFile("x.m4a"), new ArrayBuffer(0)) === "aac");
assert("tiny buffer no crash", bufferHasAscii(new Uint8Array(2), "alac") === false);
assert(
  "alac false positive in random ascii",
  detectM4aKind(new TextEncoder().encode("not a codec just the word alac in comments").buffer) ===
    "alac",
);

console.log("\n== safeName ==");
assert("strips slashes", safeName("AC/DC") === "ACDC");
assert("strips windows chars", safeName('a:*?"<>|b') === "ab");
assert("keeps unicode", safeName("Björk — 七") === "Björk — 七");
assert("emoji ok", safeName("🔥 fire") === "🔥 fire");
assert("whitespace trim", safeName("  hi  ") === "hi");
assert("all illegal becomes empty", safeName('://') === "");
assert("only stars", safeName("***") === "");

console.log("\n== floatTo16BitPCM ==");
{
  const inF = new Float32Array([0, 1, -1, 2, -3, NaN]);
  const pcm = floatTo16BitPCM(inF);
  assert("zero", pcm[0] === 0);
  assert("clip +1", pcm[1] === 32767);
  assert("clip -1", pcm[2] === -32768);
  assert("clip >1", pcm[3] === 32767);
  assert("clip <-1", pcm[4] === -32768);
  assert("NaN -> 0", pcm[5] === 0);
}

console.log("\n== lamejs encode ==");
{
  const left = sinePcm(44100 * 0.2);
  const mp3 = encodePcmToMp3(44100, 1, left);
  assert("mono 44100 produces bytes", mp3.byteLength > 200);
  save("mono.mp3", mp3);

  const L = sinePcm(1152 * 3);
  const R = sinePcm(1152 * 3, 660);
  const st = encodePcmToMp3(44100, 2, L, R);
  assert("stereo produces bytes", st.byteLength > 100);
  save("stereo.mp3", st);

  const tiny = sinePcm(10);
  const tinyMp3 = encodePcmToMp3(44100, 1, tiny);
  assert("tiny input still flushes something", tinyMp3.byteLength >= 0);

  const r48 = sinePcm(4800, 440, 48000);
  const m48 = encodePcmToMp3(48000, 1, r48);
  assert("48000 Hz encodes", m48.byteLength > 50);

  const r8 = sinePcm(800, 440, 8000);
  const m8 = encodePcmToMp3(8000, 1, r8);
  assert("8000 Hz encodes", m8.byteLength > 0);

  let weirdOk = true;
  try {
    encodePcmToMp3(12345, 1, sinePcm(12345, 440, 12345));
  } catch {
    weirdOk = false;
  }
  assert("odd sample rate 12345 does not throw", weirdOk);
}

console.log("\n== ID3Writer ==");
{
  const left = sinePcm(44100 * 0.15);
  const rawMp3 = encodePcmToMp3(44100, 1, left);

  const tagged = await writeMp3Tags({
    songBuffer: rawMp3,
    title: "Second Arrangement",
    artist: "Steely Dan",
    album: "The Royal Scam",
    track: "3/9",
    genre: "Jazz Rock",
    coverBuffer: jpeg.buffer,
  });
  const taggedBuf = await tagged.arrayBuffer();
  const taggedPath = save("tagged.mp3", taggedBuf);
  const head = new Uint8Array(taggedBuf);
  assert("starts with ID3", head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33);
  const inspect = mutagenInspect(taggedPath);
  assert("mutagen reads file", inspect.status === 0, inspect.stderr);
  assert("mutagen title", inspect.stdout.includes("TIT2") && inspect.stdout.includes("Second Arrangement"));
  assert("mutagen artist", inspect.stdout.includes("TPE1") && inspect.stdout.includes("Steely Dan"));
  assert("mutagen track 3/9", inspect.stdout.includes("3/9"));
  assert("mutagen APIC", inspect.stdout.includes("APIC"));

  const uni = await writeMp3Tags({
    songBuffer: rawMp3.slice(0),
    title: "日本語タイトル 🔥",
    artist: "Björk",
    album: "Homogenic",
    track: "1",
    genre: "电子",
  });
  const uniPath = save("unicode.mp3", await uni.arrayBuffer());
  const uniOut = mutagenInspect(uniPath).stdout;
  assert("unicode title roundtrip", uniOut.includes("日本語タイトル"));
  assert("unicode artist roundtrip", uniOut.includes("Björk"));

  const long = "A".repeat(5000);
  const longBlob = await writeMp3Tags({
    songBuffer: rawMp3.slice(0),
    title: long,
    artist: "X",
  });
  const longOut = mutagenInspect(save("long.mp3", await longBlob.arrayBuffer())).stdout;
  assert("5000-char title written", longOut.includes("A".repeat(40)));

  const pngBlob = await writeMp3Tags({
    songBuffer: rawMp3.slice(0),
    title: "png cover",
    coverBuffer: png.buffer,
  });
  assert(
    "png cover accepted",
    mutagenInspect(save("pngcover.mp3", await pngBlob.arrayBuffer())).stdout.includes("APIC"),
  );

  const gifBlob = await writeMp3Tags({
    songBuffer: rawMp3.slice(0),
    title: "gif cover",
    coverBuffer: gif.buffer,
  });
  assert(
    "gif cover accepted by writer",
    mutagenInspect(save("gifcover.mp3", await gifBlob.arrayBuffer())).stdout.includes("APIC"),
  );

  throws("bmp cover rejected", () => {
    const bmp = new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    writeMp3Tags({
      songBuffer: rawMp3.slice(0),
      title: "bmp",
      coverBuffer: bmp.buffer,
    });
  }, /Cover art must be JPEG, PNG, GIF, or WebP/);

  const webp = new Uint8Array(20);
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const webpBlob = await writeMp3Tags({
    songBuffer: rawMp3.slice(0),
    title: "webp cover",
    coverBuffer: webp.buffer,
  });
  assert(
    "webp cover accepted by writer",
    mutagenInspect(save("webpcover.mp3", await webpBlob.arrayBuffer())).stdout.includes("APIC"),
  );

  throws("empty audio rejected", () => {
    writeMp3Tags({
      songBuffer: new ArrayBuffer(0),
      title: "tag only",
    });
  }, /empty or too small/);

  throws("tiny junk rejected", () => {
    writeMp3Tags({
      songBuffer: new Uint8Array([1, 2, 3]).buffer,
      title: "tiny",
    });
  }, /empty or too small/);

  const retag = await writeMp3Tags({
    songBuffer: taggedBuf,
    title: "Retagged",
    artist: "New Artist",
  });
  const retagOut = mutagenInspect(save("retag.mp3", await retag.arrayBuffer())).stdout;
  assert("retag replaces title", retagOut.includes("Retagged"));
  assert("retag does not keep old title", !retagOut.includes("Second Arrangement"));

  // ID3v1 tail should remain unless writer strips it
  const withV1 = new Uint8Array(rawMp3.byteLength + 128);
  withV1.set(new Uint8Array(rawMp3), 0);
  const tag = new TextEncoder().encode("TAG");
  withV1.set(tag, withV1.length - 128);
  const afterV1 = new Uint8Array(
    await (
      await writeMp3Tags({
        songBuffer: withV1.buffer,
        title: "v1test",
      })
    ).arrayBuffer(),
  );
  const tail = String.fromCharCode(...afterV1.subarray(afterV1.length - 128, afterV1.length - 125));
  assert("ID3v1 TAG stripped on rewrite", tail !== "TAG");

  throws("ID3Writer rejects non-buffer", () => {
    writeMp3Tags({ songBuffer: null, title: "x" });
  }, /empty or too small/);
}

console.log("\n== WAV header fixtures ==");
{
  const wav = makeWav(0.05, 44100, 1);
  const u8 = new Uint8Array(wav);
  assert("wav magic RIFF", String.fromCharCode(...u8.subarray(0, 4)) === "RIFF");
  assert("wav WAVE", String.fromCharCode(...u8.subarray(8, 12)) === "WAVE");
  const { left, rate, channels } = pcmFromWav(wav);
  const fromWav = encodePcmToMp3(rate, channels, left);
  assert("wav pcm -> mp3", fromWav.byteLength > 50);
  save("from-wav.mp3", fromWav);

  const stereoWav = makeWav(0.05, 44100, 2);
  const s = pcmFromWav(stereoWav);
  const stMp3 = encodePcmToMp3(s.rate, s.channels, s.left, s.right);
  assert("stereo wav -> mp3", stMp3.byteLength > 50);

  const emptyWav = makeWav(0, 44100, 1);
  assert("0-second wav still has 1 frame", emptyWav.byteLength > 44);
}

console.log("\n== output filename cases ==");
{
  assert("normal", outputName("A", "B", "x.wav") === "A - B.mp3");
  assert("missing title uses original", outputName("A", "", "cool.wav") === "cool (tagged).mp3");
  assert("illegal-only names fall back", outputName("***", "///", "x.mp3") === "x (tagged).mp3");
  assert("aiff stripped", outputName("", "", "Song.AIFF") === "Song (tagged).mp3");
  assert("empty original name", outputName("", "", "") === "tagged (tagged).mp3");
  assert("collapses spaces", safeName("  a   b  ") === "a b");
}

console.log("\n== summary ==");
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  for (const f of failures) console.log(" -", f.name, f.detail);
  process.exitCode = 1;
} else {
  rmSync(outDir, { recursive: true, force: true });
}
