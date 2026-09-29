import { readSourceMetadata } from "./metadata.js";
import { createBatchEditor } from "./batch.js";
import { validTrack } from "./edits.js";

const form = document.getElementById("edit-form");
const workspace = document.getElementById("workspace");
const workspaceDescription = document.getElementById("workspace-description");
const fileInput = document.getElementById("file");
const audioDrop = document.getElementById("audio-drop");
const dropTitle = document.getElementById("drop-title");
const fileSummary = document.getElementById("file-summary");
const fileNameEl = document.getElementById("file-name");
const fileSizeEl = document.getElementById("file-size");
const formatRouteEl = document.getElementById("format-route");
const formatNoteEl = document.getElementById("format-note");
const audioError = document.getElementById("audio-error");
const replaceAudioBtn = document.getElementById("replace-audio");
const removeAudioBtn = document.getElementById("remove-audio");
const fileDurationEl = document.getElementById("file-duration");
const metadataNote = document.getElementById("metadata-note");
const importMetadataInput = document.getElementById("import-metadata");
const fields = Object.fromEntries(["title", "artist", "album", "albumArtist", "track", "genre"].map((name) => [name, document.getElementById(name)]));
const trackError = document.getElementById("track-error");
const coverInput = document.getElementById("cover");
const coverDrop = document.getElementById("cover-drop");
const coverEmpty = document.getElementById("cover-empty");
const coverPreview = document.getElementById("cover-preview");
const coverInfo = document.getElementById("cover-info");
const coverNameEl = document.getElementById("cover-name");
const coverError = document.getElementById("cover-error");
const removeCoverBtn = document.getElementById("remove-cover");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const progressFill = document.getElementById("progress-fill");
const progressLabel = document.getElementById("progress-label");
const progressStage = document.getElementById("progress-stage");
const progressMeter = document.getElementById("progress-meter");
const downloadLink = document.getElementById("download-link");
const downloadNameEl = document.getElementById("download-name");
const downloadRecovery = document.getElementById("download-recovery");
const submitBtn = document.getElementById("submit-button");
const submitLabel = document.getElementById("submit-label");
const MP3_BITRATE = 192;
const MAX_AUDIO_BYTES = 200_000_000;
const MAX_COVER_BYTES = 10_000_000;
const addAudioBtn = document.getElementById("add-audio");
const albumFilesInput = fileInput.cloneNode();
albumFilesInput.id = "album-files";
albumFilesInput.name = "album-files";
albumFilesInput.tabIndex = -1;
albumFilesInput.setAttribute("aria-label", "Add audio files to album");
fileInput.before(albumFilesInput);
let batch = null;

let downloadUrl = null;
let coverPreviewUrl = null;
let audioCtx = null;
let selectedAudioFile = null;
let selectedAudioFormat = null;
let selectedCoverFile = null;
let isProcessing = false;
let isReadingAudio = false;
let isReadingMetadata = false;
let pendingCover = null;
let sourceDuration = null;
let coverOrigin = null;
let selectionToken = 0;
let sourceSelectionToken = 0;
// Explicit user edits survive asynchronous metadata reads for the current file.
const editedFields = new Set();
const retiredDownloadUrls = new Map();

class ProcessingError extends Error {}

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.classList.remove("ok", "err");
  if (kind) statusEl.classList.add(kind);
  statusEl.setAttribute("aria-live", kind === "err" ? "assertive" : "polite");
}

function setProgress(ratio) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  progressFill.style.width = pct + "%";
  progressLabel.textContent = pct + "%";
  progressEl.classList.remove("is-indeterminate");
  progressMeter.setAttribute("aria-valuenow", String(pct));
  if (batch?.active) batch.progress(pct);
}

async function setStage(label, determinate = false) {
  if (batch?.active) label = batch.stage(label);
  progressEl.hidden = false;
  progressStage.textContent = label;
  progressMeter.setAttribute("aria-label", label);
  progressMeter.removeAttribute("aria-valuenow");
  progressLabel.textContent = "";
  progressFill.style.removeProperty("width");
  progressEl.classList.toggle("is-indeterminate", !determinate);
  if (determinate) setProgress(0);
  setStatus(label);
  // Let the browser paint before synchronous decoding/tagging work starts.
  await new Promise((resolve) => setTimeout(resolve, 32));
}

function safeName(str) {
  return str.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
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
  if (isMp3FrameHeader(b, 0)) return "mp3";
  return null;
}

function isMp3FrameHeader(bytes, offset) {
  if (offset + 3 >= bytes.length) return false;
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const bitrate = (b2 >> 4) & 0x0f;
  const sampleRate = (b2 >> 2) & 0x03;
  return (
    bytes[offset] === 0xff &&
    (b1 & 0xe0) === 0xe0 &&
    version !== 0x01 &&
    layer !== 0x00 &&
    bitrate !== 0x00 &&
    bitrate !== 0x0f &&
    sampleRate !== 0x03
  );
}

function hasMp3AudioFrame(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let start = 0;

  if (bytes.length >= 10 && asciiAt(bytes, 0, 3) === "ID3") {
    const sizeBytes = bytes.subarray(6, 10);
    if ([...sizeBytes].every((value) => value < 128)) {
      start =
        10 +
        (sizeBytes[0] << 21) +
        (sizeBytes[1] << 14) +
        (sizeBytes[2] << 7) +
        sizeBytes[3];
    }
  }

  const limit = Math.min(bytes.length - 3, start + 1_000_000);
  for (let i = Math.min(start, bytes.length); i < limit; i += 1) {
    if (isMp3FrameHeader(bytes, i)) return true;
  }
  return false;
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

function needsMp3Conversion(format) {
  return format !== "mp3";
}

function formatLabel(format) {
  const labels = {
    mp3: "MP3",
    wav: "WAV",
    flac: "FLAC",
    aiff: "AIFF",
    alac: "ALAC",
    aac: "AAC",
    ogg: "OGG",
  };
  return labels[format] || format.toUpperCase();
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
  if (c.length >= 3 && c[0] === 0xff && c[1] === 0xd8 && c[2] === 0xff) {
    return "image/jpeg";
  }
  if (c.length >= 8 && c[0] === 0x89 && c[1] === 0x50 && c[2] === 0x4e && c[3] === 0x47) {
    return "image/png";
  }
  if (c.length >= 6 && c[0] === 0x47 && c[1] === 0x49 && c[2] === 0x46) {
    return "image/gif";
  }
  if (
    c.length >= 12 &&
    c[8] === 0x57 &&
    c[9] === 0x45 &&
    c[10] === 0x42 &&
    c[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function outputName(artist, title, fileName) {
  const a = [...safeName(artist)].slice(0, 60).join("");
  const t = [...safeName(title)].slice(0, 60).join("");
  if (a && t) return `${a} - ${t}.mp3`;
  if (t) return `${t}.mp3`;
  const base = [...safeName(fileName.replace(/\.[^.]+$/, ""))].slice(0, 100).join("");
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

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Chromium does not consistently decode PCM AIFF through AudioContext.
// Keep a small local fallback for the uncompressed variants this tool accepts.
function readExtended80(view, offset) {
  const exponentWord = view.getUint16(offset, false);
  const sign = exponentWord & 0x8000 ? -1 : 1;
  const exponent = exponentWord & 0x7fff;
  const highMantissa = view.getUint32(offset + 2, false);
  const lowMantissa = view.getUint32(offset + 6, false);

  if (exponent === 0 && highMantissa === 0 && lowMantissa === 0) return 0;
  if (exponent === 0x7fff) return Number.POSITIVE_INFINITY * sign;

  const mantissa =
    highMantissa * 2 ** -31 + lowMantissa * 2 ** -63;
  return sign * mantissa * 2 ** (exponent - 16383);
}

function decodePcmAiff(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  if (
    bytes.length < 12 ||
    asciiAt(bytes, 0, 4) !== "FORM" ||
    !["AIFF", "AIFC"].includes(asciiAt(bytes, 8, 4))
  ) {
    throw new ProcessingError(
      "This AIFF file is incomplete or corrupt. Re-export it and try again.",
    );
  }

  const isAifc = asciiAt(bytes, 8, 4) === "AIFC";
  const formSize = view.getUint32(4, false);
  const formEnd = 8 + formSize;
  if (formSize < 4 || formEnd > bytes.length) {
    throw new ProcessingError(
      "This AIFF file is truncated. Re-export it and try again.",
    );
  }

  let common = null;
  let sound = null;
  let chunkOffset = 12;

  while (chunkOffset + 8 <= formEnd) {
    const chunkId = asciiAt(bytes, chunkOffset, 4);
    const chunkSize = view.getUint32(chunkOffset + 4, false);
    const dataStart = chunkOffset + 8;
    const dataEnd = dataStart + chunkSize;
    const nextChunk = dataEnd + (chunkSize % 2);

    if (dataEnd > formEnd || nextChunk > formEnd) {
      throw new ProcessingError(
        "This AIFF file contains damaged audio data. Re-export it and try again.",
      );
    }

    if (chunkId === "COMM" && chunkSize >= 18) {
      if (common) {
        throw new ProcessingError(
          "This AIFF file has conflicting format data. Re-export it and try again.",
        );
      }
      common = { dataStart, dataEnd };
    } else if (chunkId === "SSND" && chunkSize >= 8) {
      if (sound) {
        throw new ProcessingError(
          "This AIFF file has conflicting sound data. Re-export it and try again.",
        );
      }
      sound = { dataStart, dataEnd };
    }

    chunkOffset = nextChunk;
  }

  if (chunkOffset !== formEnd) {
    throw new ProcessingError(
      "This AIFF file has a damaged chunk layout. Re-export it and try again.",
    );
  }

  if (!common || !sound) {
    throw new ProcessingError(
      "This AIFF file is missing required audio data. Re-export it and try again.",
    );
  }

  const channels = view.getUint16(common.dataStart, false);
  const reportedFrames = view.getUint32(common.dataStart + 2, false);
  const sampleBits = view.getUint16(common.dataStart + 6, false);
  const sampleRate = readExtended80(view, common.dataStart + 8);
  let littleEndian = false;

  if (isAifc) {
    if (common.dataEnd - common.dataStart < 22) {
      throw new ProcessingError(
        "This compressed AIFF file is incomplete. Re-export it as PCM AIFF and try again.",
      );
    }
    const compression = asciiAt(bytes, common.dataStart + 18, 4);
    if (compression === "sowt") littleEndian = true;
    else if (compression !== "NONE" && compression !== "twos") {
      throw new ProcessingError(
        "This AIFF compression is not supported in this browser. Re-export it as PCM AIFF and try again.",
      );
    }
  }

  if (!Number.isFinite(sampleRate) || sampleRate < 1000 || sampleRate > 384000) {
    throw new ProcessingError(
      "This AIFF file has an invalid sample rate. Re-export it and try again.",
    );
  }
  if (channels < 1 || channels > 32) {
    throw new ProcessingError(
      "This AIFF file has an invalid channel layout. Re-export it and try again.",
    );
  }
  if (![8, 16, 24, 32].includes(sampleBits)) {
    throw new ProcessingError(
      "This AIFF bit depth is not supported. Re-export it as 16-bit or 24-bit PCM AIFF and try again.",
    );
  }

  const bytesPerSample = sampleBits / 8;
  const soundOffset = view.getUint32(sound.dataStart, false);
  const audioStart = sound.dataStart + 8 + soundOffset;
  if (audioStart > sound.dataEnd) {
    throw new ProcessingError(
      "This AIFF file has an invalid audio offset. Re-export it and try again.",
    );
  }

  const availableFrames = Math.floor(
    (sound.dataEnd - audioStart) / (channels * bytesPerSample),
  );
  if (reportedFrames < 1) {
    throw new ProcessingError(
      "This AIFF file does not contain playable samples. Choose another file.",
    );
  }
  if (reportedFrames > availableFrames) {
    throw new ProcessingError(
      "This AIFF file ends before its audio data is complete. Re-export it and try again.",
    );
  }
  const frameCount = reportedFrames;

  const outputChannels = Math.min(2, channels);
  const channelData = Array.from(
    { length: outputChannels },
    () => new Float32Array(frameCount),
  );

  function readSample(offset) {
    if (sampleBits === 8) return view.getInt8(offset) / 128;
    if (sampleBits === 16) {
      return view.getInt16(offset, littleEndian) / 32768;
    }
    if (sampleBits === 24) {
      let value;
      if (littleEndian) {
        value =
          bytes[offset] |
          (bytes[offset + 1] << 8) |
          (bytes[offset + 2] << 16);
      } else {
        value =
          (bytes[offset] << 16) |
          (bytes[offset + 1] << 8) |
          bytes[offset + 2];
      }
      if (value & 0x800000) value -= 0x1000000;
      return value / 8388608;
    }
    return view.getInt32(offset, littleEndian) / 2147483648;
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = audioStart + frame * channels * bytesPerSample;
    for (let channel = 0; channel < outputChannels; channel += 1) {
      channelData[channel][frame] = readSample(
        frameOffset + channel * bytesPerSample,
      );
    }
  }

  return {
    sampleRate: Math.round(sampleRate),
    length: frameCount,
    numberOfChannels: outputChannels,
    getChannelData(channel) {
      return channelData[channel];
    },
  };
}

async function convertToMp3(arrayBuffer, format, onProgress) {
  if (!window.lamejs || !window.lamejs.Mp3Encoder) {
    throw new ProcessingError(
      "The MP3 encoder did not load. Check your connection, refresh the page, and try again.",
    );
  }

  if (!window.AudioContext && !window.webkitAudioContext) {
    throw new ProcessingError(
      "This browser cannot decode audio for conversion. Try the latest Chrome, Firefox, or Safari.",
    );
  }

  audioCtx =
    audioCtx ||
    new (window.AudioContext || window.webkitAudioContext)();

  await setStage("Decoding audio…");
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    if (format === "aiff") {
      audioBuffer = decodePcmAiff(arrayBuffer);
    } else {
      const label = formatLabel(format);
      throw new ProcessingError(
        `This ${label} file could not be decoded in your browser. Re-export the audio or try another browser, then try again.`,
      );
    }
  }

  if (!audioBuffer.sampleRate || audioBuffer.length < 1) {
    throw new ProcessingError(
      "This audio file does not contain playable samples. Choose another file.",
    );
  }

  const channels = Math.min(2, audioBuffer.numberOfChannels);
  await setStage("Creating MP3…", true);
  const sampleRate = audioBuffer.sampleRate;
  const left = floatTo16BitPCM(audioBuffer.getChannelData(0));
  const right =
    channels === 2
      ? floatTo16BitPCM(audioBuffer.getChannelData(1))
      : null;

  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, MP3_BITRATE);
  const mp3Chunks = [];
  const blockSize = 1152;
  const total = left.length;
  let lastYield = performance.now();

  for (let i = 0; i < total; i += blockSize) {
    const leftChunk = left.subarray(i, i + blockSize);
    let mp3buf;
    if (channels === 2) {
      mp3buf = encoder.encodeBuffer(
        leftChunk,
        right.subarray(i, i + blockSize),
      );
    } else {
      mp3buf = encoder.encodeBuffer(leftChunk);
    }
    if (mp3buf.length > 0) mp3Chunks.push(mp3buf);

    if (performance.now() - lastYield >= 32) {
      if (onProgress) onProgress(Math.min(1, (i + blockSize) / total));
      await yieldToUi();
      lastYield = performance.now();
    }
  }

  const end = encoder.flush();
  if (end.length > 0) mp3Chunks.push(end);
  if (onProgress) onProgress(1);

  const totalLength = mp3Chunks.reduce((n, c) => n + c.length, 0);
  if (totalLength < 32) {
    throw new ProcessingError(
      "The conversion did not produce a usable MP3. Choose another source file and try again.",
    );
  }
  const mp3 = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of mp3Chunks) {
    mp3.set(chunk, offset);
    offset += chunk.length;
  }
  return mp3.buffer;
}

async function writeMp3Tags({
  ID3Writer,
  songBuffer,
  title,
  artist,
  album,
  albumArtist,
  track,
  genre,
  coverBuffer,
}) {
  if (!songBuffer || songBuffer.byteLength < 16) {
    throw new ProcessingError(
      "This audio file is empty or incomplete. Choose another file.",
    );
  }

  const writer = new ID3Writer(stripId3v1(songBuffer));
  if (title) writer.setFrame("TIT2", title);
  if (artist) writer.setFrame("TPE1", [artist]);
  if (album) writer.setFrame("TALB", album);
  if (albumArtist) writer.setFrame("TPE2", albumArtist);
  if (track) writer.setFrame("TRCK", track);
  if (genre) writer.setFrame("TCON", [genre]);
  if (coverBuffer) {
    await setStage("Embedding artwork…");
    if (!coverMime(coverBuffer)) {
      throw new ProcessingError(
        "The artwork is not a valid JPEG, PNG, GIF, or WebP image. Choose another image.",
      );
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

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1000)),
    units.length - 1,
  );
  const value = bytes / 1000 ** unitIndex;
  const digits = unitIndex === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function setAudioError(message) {
  audioError.textContent = message || "";
  audioError.hidden = !message;
  audioDrop.classList.toggle("is-error", Boolean(message));
  fileInput.setAttribute("aria-invalid", String(Boolean(message)));
}

function setCoverError(message) {
  coverError.textContent = message || "";
  coverError.hidden = !message;
  coverDrop.classList.toggle("is-error", Boolean(message));
  coverInput.setAttribute("aria-invalid", String(Boolean(message)));
}

function validateTrack() {
  const valid = validTrack(fields.track.value);
  trackError.textContent = valid ? "" : "Use a track from 1–9999, or track/total (e.g. 3/10). The total must be at least the track number.";
  trackError.hidden = valid;
  fields.track.setAttribute("aria-invalid", String(!valid));
  return valid;
}

function clearDownload() {
  if (downloadUrl) {
    // A dispatched browser download may still be reading this URL. Retain it briefly
    // after edits/replacement, then release it; the current result stays retryable.
    const oldUrl = downloadUrl;
    const timer = setTimeout(() => {
      URL.revokeObjectURL(oldUrl);
      retiredDownloadUrls.delete(oldUrl);
    }, 60_000);
    retiredDownloadUrls.set(oldUrl, timer);
  }
  downloadUrl = null;
  downloadRecovery.hidden = true;
  downloadLink.hidden = true;
  downloadLink.removeAttribute("href");
  downloadLink.removeAttribute("download");
  downloadLink.removeAttribute("aria-label");
  downloadNameEl.textContent = "";
}

function invalidateDownload() {
  clearDownload();
  setStatus("");
}

function renderAudioState() {
  const hasFile = Boolean(selectedAudioFile && selectedAudioFormat);
  audioDrop.hidden = hasFile;
  fileSummary.hidden = !hasFile;
  fileInput.tabIndex = hasFile ? -1 : 0;
  workspaceDescription.textContent = hasFile
    ? "Ready to tag. Drop another file here or choose Replace."
    : "Choose a track or an album. Your audio stays in this browser.";
  fileNameEl.textContent = hasFile ? selectedAudioFile.name : "";
  fileNameEl.title = fileNameEl.textContent;
  fileSizeEl.textContent = hasFile ? formatFileSize(selectedAudioFile.size) : "";
  formatRouteEl.textContent = hasFile
    ? `${formatLabel(selectedAudioFormat)}${needsMp3Conversion(selectedAudioFormat) ? " → MP3" : ""}` : "";
  formatNoteEl.textContent = hasFile
    ? needsMp3Conversion(selectedAudioFormat) ? "192 kbps" : "Original audio quality"
    : "";
  fileDurationEl.hidden = !Number.isFinite(sourceDuration) || sourceDuration <= 0;
  fileDurationEl.textContent = fileDurationEl.hidden ? "" :
    `· ${Math.floor(sourceDuration / 60)}:${String(Math.floor(sourceDuration % 60)).padStart(2, "0")}`;
  updateActionAvailability();
}

function renderCoverState() {
  const hasCover = Boolean(selectedCoverFile && coverPreviewUrl);
  coverEmpty.hidden = hasCover;
  coverPreview.hidden = !hasCover;
  coverInfo.hidden = !hasCover;
  coverDrop.classList.toggle("has-cover", hasCover);
  coverInput.setAttribute("aria-label", hasCover ? "Replace cover artwork" : "Choose cover artwork");
  if (hasCover) coverPreview.src = coverPreviewUrl;
  else coverPreview.removeAttribute("src");
  coverNameEl.textContent = hasCover ? selectedCoverFile.name : "";
  coverNameEl.title = coverNameEl.textContent;
  updateActionAvailability();
}

function updateActionAvailability() {
  addAudioBtn.disabled = isProcessing;
  albumFilesInput.disabled = isProcessing;
  if (batch?.active) {
    audioDrop.hidden = false;
    fileSummary.hidden = true;
    fileInput.tabIndex = 0;
    fileInput.disabled = isProcessing;
    workspaceDescription.textContent = "Add more tracks to your album. Your audio stays in this browser.";
    submitBtn.disabled = isProcessing || batch.checking || !batch.count;
    submitLabel.textContent = isProcessing ? batch.actionLabel : batch.checking ? "Checking files…" : batch.count ? batch.actionLabel : "Add audio files first";
    if (!isProcessing && !statusEl.classList.contains("ok") && !statusEl.classList.contains("err")) {
      setStatus(batch.checking ? "Reading album files…" : batch.count
        ? `Ready to process all ${batch.count} tracks, one at a time.` : "Add audio files to begin.");
    }
    batch.updateControls(isProcessing);
    return;
  }
  const checking = isReadingAudio || isReadingMetadata || Boolean(pendingCover);
  submitBtn.disabled = isProcessing || checking || !selectedAudioFile;
  submitLabel.textContent = isProcessing ? "Creating your MP3…"
    : checking ? "Checking files…"
    : !selectedAudioFile ? "Add an audio file first"
    : statusEl.classList.contains("err") ? "Try again"
    : downloadUrl ? "Create another MP3" : "Create Spotify MP3";
  fileInput.disabled = isProcessing;
  coverInput.disabled = isProcessing;
  removeCoverBtn.disabled = isProcessing || (!selectedCoverFile && !pendingCover);
  if (!isProcessing && !downloadUrl && !statusEl.classList.contains("err")) {
    const message = checking ? "Reading your file…"
      : selectedAudioFile ? "Ready when you are. Your MP3 will download automatically."
      : "Add your audio, then create. The download starts automatically.";
    if (statusEl.textContent !== message) setStatus(message);
  }
}

function setBusy(busy) {
  isProcessing = busy;
  workspace.classList.toggle("is-processing", busy);
  form.classList.toggle("is-processing", busy);
  for (const region of form.querySelectorAll(".file-section, .editor-grid")) {
    region.setAttribute("aria-busy", String(busy));
  }
  for (const target of [audioDrop, fileSummary, coverDrop]) {
    target.classList.toggle("is-busy", busy);
    target.classList.remove("is-drag-active");
    target.setAttribute("aria-disabled", String(busy));
  }
  form.querySelectorAll("input, button").forEach((control) => { control.disabled = busy; });
  submitBtn.classList.toggle("is-processing", busy);
  updateActionAvailability();
}

function removeCover() {
  if (isProcessing) return;
  pendingCover = null;
  if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
  coverPreviewUrl = null;
  selectedCoverFile = null;
  coverOrigin = "user";
  coverInput.value = "";
  coverDrop.classList.remove("is-checking");
  setCoverError("");
  invalidateDownload();
  renderCoverState();
}

function clearMetadata({ preserveEdits = false } = {}) {
  if (!preserveEdits) editedFields.clear();
  for (const [name, input] of Object.entries(fields)) {
    if (!editedFields.has(name)) input.value = "";
  }
  if (!preserveEdits || pendingCover?.origin === "source") {
    pendingCover = null;
    coverDrop.classList.remove("is-checking");
  }
  if (!preserveEdits || coverOrigin === "source") {
    if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    coverPreviewUrl = null;
    selectedCoverFile = null;
    coverOrigin = null;
    coverInput.value = "";
    setCoverError("");
    renderCoverState();
  }
  validateTrack();
}

function removeAudio() {
  if (isProcessing) return;
  selectionToken += 1;
  sourceSelectionToken += 1;
  isReadingAudio = false;
  isReadingMetadata = false;
  selectedAudioFile = null;
  selectedAudioFormat = null;
  sourceDuration = null;
  fileInput.value = "";
  clearMetadata({ preserveEdits: true });
  invalidateDownload();
  setAudioError("");
  metadataNote.textContent = "All details are optional. Existing tags are filled in when available.";
  audioDrop.classList.remove("is-checking", "is-drag-active");
  dropTitle.textContent = "Drop an audio file here";
  renderAudioState();
  fileInput.focus();
}

async function inspectAudio(file) {
  if (file.size > MAX_AUDIO_BYTES) throw new ProcessingError("This file is too large. Choose audio up to 200 MB.");
  if (file.size < 16) throw new ProcessingError("This file is empty or incomplete. Choose a different audio file.");
  const header = await file.slice(0, 512_000).arrayBuffer();
  const format = detectFormat(file, header);
  if (!format) throw new ProcessingError("File not supported. Choose an MP3, WAV, FLAC, AIFF, M4A, AAC, or OGG file.");
  return format;
}

async function validateArtwork(file) {
  if (file.size > MAX_COVER_BYTES) throw new ProcessingError("This image is too large. Choose artwork up to 10 MB.");
  const header = await file.slice(0, 16).arrayBuffer();
  if (!coverMime(header)) throw new ProcessingError("Artwork must be a JPEG, PNG, GIF, or WebP image.");
  const url = URL.createObjectURL(file);
  try {
    const probe = new Image();
    probe.src = url;
    await probe.decode();
    return url;
  } catch {
    URL.revokeObjectURL(url);
    throw new ProcessingError("This image could not be opened. Choose another JPEG, PNG, GIF, or WebP image.");
  }
}

async function selectAudioFile(file) {
  if (!file || isProcessing) return;
  const token = ++selectionToken;
  // Changing the preference during a read only affects subsequent uploads.
  const shouldImportMetadata = importMetadataInput.checked;
  isReadingAudio = true;
  setAudioError("");
  audioDrop.classList.add("is-checking");
  dropTitle.textContent = "Checking audio file…";
  updateActionAvailability();

  try {
    const format = await inspectAudio(file);
    if (token !== selectionToken) return;

    // A rejected candidate must not cancel metadata still being read for the
    // current source. Validation and committed-source reads have separate tokens.
    const sourceToken = ++sourceSelectionToken;
    isReadingAudio = false;
    isReadingMetadata = shouldImportMetadata;
    invalidateDownload();
    // Each accepted upload starts a fresh track, including manual edits/artwork.
    clearMetadata();
    selectedAudioFile = file;
    selectedAudioFormat = format;
    sourceDuration = null;
    renderAudioState();
    if (!shouldImportMetadata) {
      metadataNote.textContent = "Metadata import is off. Add any details you like, or create as is.";
      return;
    }
    metadataNote.textContent = "Reading existing metadata… You can keep editing.";
    try {
      const source = await readSourceMetadata(file);
      if (sourceToken !== sourceSelectionToken) return;
      let imported = 0;
      for (const [name, input] of Object.entries(fields)) {
        if (source[name] && !editedFields.has(name)) {
          input.value = source[name];
          imported += 1;
        }
      }
      if (source.cover && coverOrigin !== "user" && pendingCover?.origin !== "user") {
        await selectCoverFile(source.cover, { origin: "source", sourceToken });
      }
      if (sourceToken !== sourceSelectionToken) return;
      sourceDuration = source.duration;
      metadataNote.textContent = imported || (source.cover && coverOrigin === "source")
        ? "Existing tags filled in. Edit any detail before creating your MP3."
        : "No readable tags to fill in. Add any details you like, or create as is.";
      validateTrack();
      renderAudioState();
    } finally {
      if (sourceToken === sourceSelectionToken) {
        isReadingMetadata = false;
        updateActionAvailability();
      }
    }
  } catch (error) {
    if (token !== selectionToken) return;
    setAudioError(error instanceof ProcessingError ? error.message :
      "This file could not be read. Choose another audio file and try again.");
  } finally {
    if (token === selectionToken) {
      isReadingAudio = false;
      fileInput.value = "";
      audioDrop.classList.remove("is-checking");
      dropTitle.textContent = "Drop an audio file here";
      updateActionAvailability();
    }
  }
}

async function selectCoverFile(file, { origin = "user", sourceToken } = {}) {
  if (!file || isProcessing) return;
  // Keep pending and committed provenance separate: a rejected replacement must
  // not make the previous source's artwork look like a deliberate user choice.
  const selection = { origin, sourceToken, file };
  pendingCover = selection;
  setCoverError("");
  coverDrop.classList.add("is-checking");
  updateActionAvailability();
  let nextPreviewUrl = null;
  try {
    nextPreviewUrl = await validateArtwork(file);
    if (pendingCover !== selection || (origin === "source" && sourceToken !== sourceSelectionToken)) return;
    if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    coverPreviewUrl = nextPreviewUrl;
    nextPreviewUrl = null;
    selectedCoverFile = file;
    coverOrigin = origin;
    invalidateDownload();
    renderCoverState();
  } catch (error) {
    if (pendingCover !== selection || (origin === "source" && sourceToken !== sourceSelectionToken)) return;
    setCoverError(error instanceof ProcessingError ? error.message :
      "This image could not be opened. Choose another JPEG, PNG, GIF, or WebP image.");
  } finally {
    if (nextPreviewUrl) URL.revokeObjectURL(nextPreviewUrl);
    if (pendingCover === selection) {
      pendingCover = null;
      coverInput.value = "";
      coverDrop.classList.remove("is-checking");
      updateActionAvailability();
    }
  }
}

function wireDropTarget(target, onFile, onError, multiple = false) {
  let dragDepth = 0;
  target.addEventListener("dragenter", (event) => {
    event.preventDefault();
    if (isProcessing) return;
    dragDepth += 1;
    target.classList.add("is-drag-active");
  });
  target.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = isProcessing ? "none" : "copy";
  });
  target.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) target.classList.remove("is-drag-active");
  });
  target.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    target.classList.remove("is-drag-active");
    if (isProcessing) return;
    const files = event.dataTransfer?.files;
    if (multiple && files?.length) onFile([...files]);
    else if (files?.length > 1) onError("Choose one file at a time.");
    else if (files?.[0]) onFile(files[0]);
  });
}

function addToBatch(files) {
  if (!files.length || isProcessing) return;
  setAudioError("");
  let seed = null;
  if (!batch.active) {
    if (selectedAudioFile) seed = {
      file: selectedAudioFile, format: selectedAudioFormat,
      values: Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])),
      edited: [...editedFields], cover: selectedCoverFile, coverEdited: coverOrigin === "user",
      pendingCover: pendingCover?.origin === "user" ? pendingCover.file : null,
      // Reread unfinished source tags, while keeping imported/manual values if
      // import was disabled after this file was loaded.
      importMetadata: isReadingMetadata,
    };
    selectionToken++;
    sourceSelectionToken++;
    isReadingAudio = false;
    isReadingMetadata = false;
    selectedAudioFile = null;
    selectedAudioFormat = null;
    clearMetadata();
    invalidateDownload();
    document.getElementById("single-editor").hidden = true;
    audioDrop.classList.remove("is-checking");
    dropTitle.textContent = "Drop audio files here";
  }
  batch.add(files, importMetadataInput.checked, seed);
}

function selectAudioFiles(files) {
  if (batch.active || files.length > 1) {
    addToBatch(files);
    fileInput.value = "";
  } else selectAudioFile(files[0]);
}

fileInput.addEventListener("change", () => selectAudioFiles([...fileInput.files]));
addAudioBtn.addEventListener("click", () => { if (!isProcessing) albumFilesInput.click(); });
albumFilesInput.addEventListener("change", () => {
  addToBatch([...albumFilesInput.files]);
  albumFilesInput.value = "";
});
coverInput.addEventListener("change", () => selectCoverFile(coverInput.files?.[0]));
replaceAudioBtn.addEventListener("click", () => { if (!isProcessing) fileInput.click(); });
removeAudioBtn.addEventListener("click", removeAudio);
removeCoverBtn.addEventListener("click", () => {
  removeCover();
  coverInput.focus();
});
fields.track.addEventListener("blur", validateTrack);
for (const [name, input] of Object.entries(fields)) {
  input.addEventListener("input", () => {
    editedFields.add(name);
    invalidateDownload();
    if (name === "track" && !trackError.hidden) validateTrack();
    updateActionAvailability();
  });
}
wireDropTarget(audioDrop, selectAudioFiles, setAudioError, true);
wireDropTarget(fileSummary, selectAudioFiles, setAudioError, true);
wireDropTarget(coverDrop, selectCoverFile, setCoverError);
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());

async function processTrack({ file, values, cover }) {
  try {
    await setStage("Reading audio…");
    let songBuffer = await file.arrayBuffer();
    if (songBuffer.byteLength < 16) {
      throw new ProcessingError("This audio file is empty or incomplete. Choose another file.");
    }
    const format = detectFormat(file, songBuffer);
    if (!format) throw new ProcessingError("The audio format could not be confirmed. Choose another audio file.");
    if (format === "mp3" && !hasMp3AudioFrame(songBuffer)) {
      throw new ProcessingError("This MP3 does not contain recognizable audio data. Re-export the track or choose another file.");
    }
    if (needsMp3Conversion(format)) {
      songBuffer = await convertToMp3(songBuffer, format, setProgress);
    }

    await setStage("Applying metadata…");
    let ID3Writer;
    try {
      ({ ID3Writer } = await import("https://cdn.jsdelivr.net/npm/browser-id3-writer@6.4.0/+esm"));
    } catch {
      throw new ProcessingError("The metadata writer could not load. Check your connection and try again. Your details are still here.");
    }
    const coverBuffer = cover ? await cover.arrayBuffer() : null;
    return await writeMp3Tags({ ID3Writer, songBuffer, ...values, coverBuffer });
  } finally {
    if (audioCtx) {
      await audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (batch.active) { await batch.process(); return; }
  if (isProcessing || isReadingAudio || isReadingMetadata || pendingCover) return;
  if (!selectedAudioFile) {
    setAudioError("Choose an audio file before creating your Spotify MP3.");
    fileInput.focus();
    return;
  }
  if (!validateTrack()) {
    fields.track.focus();
    return;
  }

  // Snapshot only after acquiring the submission guard; edits are locked until done.
  const file = selectedAudioFile;
  const values = Object.fromEntries(Object.entries(fields).map(([name, input]) => [name, input.value.trim()]));
  const cover = selectedCoverFile;
  const focusedControl = form.contains(document.activeElement) ? document.activeElement : null;
  clearDownload();
  setBusy(true);
  setAudioError("");
  try {
    const blob = await processTrack({ file, values, cover });
    await setStage("Preparing download…");
    downloadUrl = URL.createObjectURL(blob);
    const outName = outputName(values.artist, values.title, file.name);
    downloadLink.href = downloadUrl;
    downloadLink.download = outName;
    downloadLink.setAttribute("aria-label", `Download again: ${outName}`);
    downloadNameEl.textContent = outName;
    downloadNameEl.title = outName;
    downloadLink.hidden = false;
    downloadRecovery.hidden = false;
    try {
      downloadLink.click();
      setStatus("MP3 created — download started", "ok");
    } catch {
      // The finished output is still valid when download dispatch itself fails.
      setStatus("MP3 created — use Download again to save your file.", "ok");
    }
  } catch (error) {
    console.error(error);
    setStatus(error instanceof ProcessingError ? error.message :
      "The MP3 could not be created. Your details are still here; check your file and try again.", "err");
  } finally {
    progressEl.hidden = true;
    if (audioCtx) {
      await audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    setBusy(false);
    if (focusedControl && (document.activeElement === document.body || document.activeElement === focusedControl)) {
      focusedControl.focus({ preventScroll: true });
    }
  }
});

window.addEventListener("pagehide", (event) => {
  // Back/forward cache retains the page and its retryable download/preview URLs.
  if (event.persisted) return;
  batch.dispose();
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
  for (const [url, timer] of retiredDownloadUrls) {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
  retiredDownloadUrls.clear();
  if (audioCtx) audioCtx.close().catch(() => {});
});

batch = createBatchEditor({
  inspectAudio, validateArtwork, processTrack, formatLabel,
  safeName, outputName, setBusy, setStatus,
  updateActions: updateActionAvailability,
  finishProcessing() {
    progressEl.hidden = true;
    setBusy(false);
  },
});

renderCoverState();
renderAudioState();
