// Source tags are a convenience, never a prerequisite for processing audio.
// Read slices of known metadata blocks; do not decode or load the audio itself.
const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_COVER_BYTES = 10_000_000;
const MAX_BLOCKS = 512;
const MAX_TEXT_BYTES = 64 * 1024;

const ID3_FIELDS = {
  TIT2: "title", TT2: "title", TPE1: "artist", TP1: "artist",
  TALB: "album", TAL: "album", TRCK: "track", TRK: "track",
  TCON: "genre", TCO: "genre",
};
const GENRES = (
  "Blues|Classic Rock|Country|Dance|Disco|Funk|Grunge|Hip-Hop|Jazz|Metal|New Age|Oldies|Other|Pop|R&B|Rap|Reggae|Rock|Techno|Industrial|Alternative|Ska|Death Metal|Pranks|Soundtrack|Euro-Techno|Ambient|Trip-Hop|Vocal|Jazz+Funk|Fusion|Trance|Classical|Instrumental|Acid|House|Game|Sound Clip|Gospel|Noise|AlternRock|Bass|Soul|Punk|Space|Meditative|Instrumental Pop|Instrumental Rock|Ethnic|Gothic|Darkwave|Techno-Industrial|Electronic|Pop-Folk|Eurodance|Dream|Southern Rock|Comedy|Cult|Gangsta|Top 40|Christian Rap|Pop/Funk|Jungle|Native American|Cabaret|New Wave|Psychadelic|Rave|Showtunes|Trailer|Lo-Fi|Tribal|Acid Punk|Acid Jazz|Polka|Retro|Musical|Rock & Roll|Hard Rock|Folk|Folk-Rock|National Folk|Swing|Fast Fusion|Bebob|Latin|Revival|Celtic|Bluegrass|Avantgarde|Gothic Rock|Progressive Rock|Psychedelic Rock|Symphonic Rock|Slow Rock|Big Band|Chorus|Easy Listening|Acoustic|Humour|Speech|Chanson|Opera|Chamber Music|Sonata|Symphony|Booty Bass|Primus|Porn Groove|Satire|Slow Jam|Club|Tango|Samba|Folklore|Ballad|Power Ballad|Rhythmic Soul|Freestyle|Duet|Punk Rock|Drum Solo|A capella|Euro-House|Dance Hall|Goa|Drum & Bass|Club-House|Hardcore|Terror|Indie|BritPop|Negerpunk|Polsk Punk|Beat|Christian Gangsta Rap|Heavy Metal|Black Metal|Crossover|Contemporary Christian|Christian Rock|Merengue|Salsa|Thrash Metal|Anime|JPop|Synthpop"
).split("|");

function ascii(bytes, start, length) {
  if (start < 0 || start + length > bytes.length) return "";
  let value = "";
  for (let i = start; i < start + length; i++) value += String.fromCharCode(bytes[i]);
  return value;
}

function uint(bytes, start, length = 4, littleEndian = false) {
  if (start < 0 || start + length > bytes.length) return -1;
  let value = 0;
  for (let i = 0; i < length; i++) {
    value = value * 256 + bytes[start + (littleEndian ? length - 1 - i : i)];
  }
  return value;
}

function syncSafe(bytes, start) {
  if (start + 4 > bytes.length) return -1;
  let value = 0;
  for (let i = start; i < start + 4; i++) {
    if (bytes[i] > 127) return -1;
    value = value * 128 + bytes[i];
  }
  return value;
}

function decode(bytes, encoding = "utf-8") {
  return new TextDecoder(encoding).decode(bytes.subarray(0, MAX_TEXT_BYTES))
    .replace(/\u0000+/g, "; ").replace(/[\u0001-\u001f\u007f]/g, "")
    .replace(/(?:;\s*)+$/, "").trim();
}

function id3Text(bytes) {
  const encoding = bytes[0];
  const encodings = ["windows-1252", "utf-16le", "utf-16be", "utf-8"];
  if (encoding > 3 || bytes.length < 2) return "";
  const codec = encoding === 1 && bytes[1] === 0xfe && bytes[2] === 0xff
    ? "utf-16be" : encodings[encoding];
  return decode(bytes.subarray(1), codec);
}

function put(metadata, key, value) {
  if (key && value && !metadata[key]) metadata[key] = value;
}

function genreName(value) {
  const numeric = value.match(/^\(?(\d+)\)?$/);
  if (numeric) return GENRES[Number(numeric[1])] || value;
  return value.replace(/^\((\d+)\)/, (_, number) => `${GENRES[Number(number)] || number}; `);
}

function deunsync(bytes) {
  const result = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    result[length++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0) i++;
  }
  return result.subarray(0, length);
}

function terminator(bytes, start, encoding) {
  const step = encoding === 1 || encoding === 2 ? 2 : 1;
  for (let i = start; i + step <= bytes.length; i += step) {
    if (bytes[i] === 0 && (step === 1 || bytes[i + 1] === 0)) return i + step;
  }
  return -1;
}

function coverFile(bytes) {
  if (!bytes.length || bytes.length > MAX_COVER_BYTES) return null;
  let format;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) format = ["jpeg", "jpg"];
  else if (uint(bytes, 0) === 0x89504e47 && uint(bytes, 4) === 0x0d0a1a0a) format = ["png", "png"];
  else if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) format = ["gif", "gif"];
  else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") format = ["webp", "webp"];
  return format ? new File([bytes], `Embedded cover.${format[1]}`, { type: `image/${format[0]}` }) : null;
}

function putCover(metadata, state, bytes, type) {
  // Prefer the front cover, but use another embedded picture if it is all we have.
  if (metadata.cover && (state.coverType === 3 || type !== 3)) return;
  const cover = coverFile(bytes);
  if (cover) {
    metadata.cover = cover;
    state.coverType = type;
  }
}

function readId3Picture(bytes, version, metadata, state) {
  if (bytes.length < 6 || bytes[0] > 3) return;
  const pictureTypeOffset = version === 2 ? 4 : terminator(bytes, 1, 0);
  if (pictureTypeOffset < 0 || pictureTypeOffset >= bytes.length) return;
  const dataOffset = terminator(bytes, pictureTypeOffset + 1, bytes[0]);
  if (dataOffset < 0) return;
  putCover(metadata, state, bytes.subarray(dataOffset), bytes[pictureTypeOffset]);
}

function readId3(bytes, metadata, state) {
  if (ascii(bytes, 0, 3) !== "ID3" || bytes.length < 10) return;
  const version = bytes[3];
  if (![2, 3, 4].includes(version) || (version === 2 && (bytes[5] & 0x40))) return;
  const tagSize = syncSafe(bytes, 6);
  if (tagSize < 0 || tagSize + 10 > bytes.length) return;
  const unsynchronized = Boolean(bytes[5] & 0x80);
  let body = bytes.subarray(10, 10 + tagSize);
  if (version < 4 && unsynchronized) body = deunsync(body);
  let offset = 0;
  if (version > 2 && (bytes[5] & 0x40)) {
    const extendedSize = version === 4 ? syncSafe(body, 0) : uint(body, 0);
    if (extendedSize < 6) return;
    offset = extendedSize + (version === 3 ? 4 : 0);
  }
  const headerSize = version === 2 ? 6 : 10;
  for (let count = 0; count < MAX_BLOCKS && offset + headerSize <= body.length; count++) {
    const id = ascii(body, offset, version === 2 ? 3 : 4);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const size = version === 2 ? uint(body, offset + 3, 3)
      : version === 4 ? syncSafe(body, offset + 4) : uint(body, offset + 4);
    if (size < 0 || offset + headerSize + size > body.length) break;
    const flags = version === 2 ? 0 : body[offset + 9];
    let data = body.subarray(offset + headerSize, offset + headerSize + size);
    offset += headerSize + size;
    // Compressed/encrypted frames are deliberately skipped, not guessed at.
    if ((version === 3 && (flags & 0xc0)) || (version === 4 && (flags & 0x0c))) continue;
    if (version === 4 && (unsynchronized || (flags & 0x02))) data = deunsync(data);
    if ((version === 3 && (flags & 0x20)) || (version === 4 && (flags & 0x40))) data = data.subarray(1);
    if (version === 4 && (flags & 0x01)) data = data.subarray(4);
    if (ID3_FIELDS[id]) {
      let value = id3Text(data);
      if (ID3_FIELDS[id] === "genre") value = genreName(value);
      put(metadata, ID3_FIELDS[id], value);
    } else if (id === "APIC" || id === "PIC") {
      readId3Picture(data, version, metadata, state);
    }
  }
}

function readId3v1(bytes, metadata) {
  if (bytes.length !== 128 || ascii(bytes, 0, 3) !== "TAG") return;
  for (const [key, start] of [["title", 3], ["artist", 33], ["album", 63]]) {
    put(metadata, key, decode(bytes.subarray(start, start + 30), "windows-1252"));
  }
  if (bytes[125] === 0 && bytes[126] > 0) put(metadata, "track", String(bytes[126]));
  put(metadata, "genre", GENRES[bytes[127]]);
}

function readVorbis(bytes, metadata) {
  const vendorLength = uint(bytes, 0, 4, true);
  if (vendorLength < 0 || vendorLength + 8 > bytes.length) return;
  let offset = 4 + vendorLength;
  const count = Math.min(uint(bytes, offset, 4, true), MAX_BLOCKS);
  offset += 4;
  const fields = { TITLE: "title", ARTIST: "artist", ALBUM: "album", TRACKNUMBER: "track", GENRE: "genre" };
  let total;
  for (let i = 0; i < count && offset + 4 <= bytes.length; i++) {
    const length = uint(bytes, offset, 4, true);
    offset += 4;
    if (length < 0 || offset + length > bytes.length) break;
    const entry = decode(bytes.subarray(offset, offset + length));
    offset += length;
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = entry.slice(0, separator).toUpperCase();
    const value = entry.slice(separator + 1).trim();
    put(metadata, fields[key], value);
    if (key === "TRACKTOTAL" || key === "TOTALTRACKS") total = value;
  }
  if (/^\d+$/.test(metadata.track || "") && /^\d+$/.test(total || "")) metadata.track += `/${total}`;
}

function readFlacPicture(bytes, metadata, state) {
  const type = uint(bytes, 0);
  const mimeLength = uint(bytes, 4);
  if (type < 0 || mimeLength < 0 || mimeLength + 12 > bytes.length) return;
  const descriptionLength = uint(bytes, 8 + mimeLength);
  if (descriptionLength < 0) return;
  const offset = 12 + mimeLength + descriptionLength + 16;
  const size = uint(bytes, offset);
  if (size < 0 || offset + 4 + size > bytes.length) return;
  putCover(metadata, state, bytes.subarray(offset + 4, offset + 4 + size), type);
}

async function readFlac(read, size, metadata, state) {
  let offset = 4;
  for (let count = 0; count < MAX_BLOCKS && offset + 4 <= size; count++) {
    const header = await read(offset, 4);
    if (header.length !== 4) return;
    const type = header[0] & 0x7f;
    const length = uint(header, 1, 3);
    offset += 4;
    if (offset + length > size) return;
    if ([0, 4, 6].includes(type)) {
      const bytes = await read(offset, length);
      if (type === 4) readVorbis(bytes, metadata);
      if (type === 6) readFlacPicture(bytes, metadata, state);
      if (type === 0 && bytes.length === 34) {
        const sampleRate = uint(bytes, 10, 3) >>> 4;
        const sampleCount = (bytes[13] & 0x0f) * 0x100000000 + uint(bytes, 14);
        if (sampleRate > 0 && sampleCount > 0) metadata.duration = sampleCount / sampleRate;
      }
    }
    offset += length;
    if (header[0] & 0x80) return;
  }
}

function readWaveInfo(bytes, metadata) {
  if (ascii(bytes, 0, 4) !== "INFO") return;
  const fields = { INAM: "title", IART: "artist", IPRD: "album", ITRK: "track", IPRT: "track", IGNR: "genre" };
  let offset = 4;
  for (let count = 0; count < MAX_BLOCKS && offset + 8 <= bytes.length; count++) {
    const id = ascii(bytes, offset, 4);
    const length = uint(bytes, offset + 4, 4, true);
    offset += 8;
    if (length < 0 || offset + length > bytes.length) return;
    const data = bytes.subarray(offset, offset + length);
    // RIFF INFO predates Unicode; accept UTF-8 from modern exporters first.
    let value = decode(data);
    if (value.includes("\ufffd")) value = decode(data, "windows-1252");
    put(metadata, fields[id], value);
    offset += length + length % 2;
  }
}

async function readWave(read, size, metadata, state) {
  let offset = 12;
  let sampleRate = 0;
  let blockAlign = 0;
  let dataSize = 0;
  for (let count = 0; count < MAX_BLOCKS && offset + 8 <= size; count++) {
    const header = await read(offset, 8);
    if (header.length !== 8) break;
    const id = ascii(header, 0, 4);
    const length = uint(header, 4, 4, true);
    offset += 8;
    if (length < 0 || offset + length > size) break;
    if (id === "LIST") readWaveInfo(await read(offset, length), metadata);
    else if (id.toUpperCase() === "ID3 ") readId3(await read(offset, length), metadata, state);
    else if (id === "fmt " && length >= 16) {
      const bytes = await read(offset, 16);
      if ([1, 3].includes(uint(bytes, 0, 2, true))) {
        sampleRate = uint(bytes, 4, 4, true);
        blockAlign = uint(bytes, 12, 2, true);
      }
    } else if (id === "data") dataSize += length;
    offset += length + length % 2;
  }
  if (sampleRate > 0 && blockAlign > 0 && dataSize > 0) metadata.duration = dataSize / blockAlign / sampleRate;
}

/**
 * Best-effort browser File/Blob metadata reader. Returns available string fields
 * title, artist, album, track, genre; optional cover (File) and duration (seconds).
 * Supports ID3v2.2/2.3/2.4 + ID3v1, native FLAC, and RIFF WAV INFO/ID3.
 * Unsupported formats, oversized tags, and corrupt blocks are quietly skipped.
 */
export async function readSourceMetadata(file) {
  const metadata = {};
  const state = {};
  let bytesRead = 0;
  const read = async (offset, length) => {
    if (length < 0 || offset < 0 || offset + length > file.size || bytesRead + length > MAX_READ_BYTES) return new Uint8Array();
    bytesRead += length;
    return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  };
  try {
    const header = await read(0, Math.min(12, file.size));
    if (ascii(header, 0, 3) === "ID3") {
      const size = syncSafe(header, 6);
      if (size >= 0) readId3(await read(0, size + 10), metadata, state);
    } else if (ascii(header, 0, 4) === "fLaC") {
      await readFlac(read, file.size, metadata, state);
    } else if (ascii(header, 0, 4) === "RIFF" && ascii(header, 8, 4) === "WAVE") {
      await readWave(read, Math.min(file.size, uint(header, 4, 4, true) + 8), metadata, state);
    }
    if (file.size >= 128) readId3v1(await read(file.size - 128, 128), metadata);
  } catch {
    // Malformed or unreadable source tags must never block file selection.
  }
  return metadata;
}
