// Stored ZIP entries: MP3s are already compressed. Blob parts avoid joining the
// entire album into an ArrayBuffer. CRC reads are bounded to 256 KiB at a time.
// Format: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

async function crc32(blob) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += 262144) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + 262144).arrayBuffer());
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function createZip(entries) {
  if (entries.length >= 65535) throw new Error("Too many tracks for one ZIP. Download the tracks individually.");
  const parts = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  const date = new Date();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >>> 1);
  const dosDate = ((Math.max(1980, Math.min(2107, date.getFullYear())) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  for (const { name, blob } of entries) {
    const filename = new TextEncoder().encode(name);
    const localSize = 30 + filename.length;
    if (filename.length > 65535 || blob.size >= 0xffffffff || offset + localSize + blob.size >= 0xffffffff) {
      throw new Error("This album exceeds the 4 GB ZIP limit. Download the tracks individually or export smaller batches.");
    }
    const crc = await crc32(blob);
    const local = new Uint8Array(localSize);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true); // UTF-8 filenames; method 0 (stored).
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, blob.size, true);
    view.setUint32(22, blob.size, true);
    view.setUint16(26, filename.length, true);
    local.set(filename, 30);
    const central = new Uint8Array(46 + filename.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    central.set(local.subarray(4, 30), 6);
    centralView.setUint32(42, offset, true);
    central.set(filename, 46);
    parts.push(local, blob);
    directory.push(central);
    offset += localSize + blob.size;
    directorySize += central.length;
  }
  if (offset + directorySize + 22 >= 0xffffffff) throw new Error("This album exceeds the 4 GB ZIP limit. Download the tracks individually.");
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}

export function uniqueFilename(name, used) {
  const base = name.replace(/\.mp3$/i, "");
  let candidate = `${base}.mp3`;
  for (let suffix = 2; used.has(candidate.toLowerCase()); suffix++) candidate = `${base} (${suffix}).mp3`;
  used.add(candidate.toLowerCase());
  return candidate;
}
