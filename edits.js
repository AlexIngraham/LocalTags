// Bulk edits are partial patches: a field that is absent from a patch is never
// written, so every track keeps its own value for anything not chosen.
export const FIELDS = [
  { key: "track", label: "Track number", column: "Track #" },
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "albumArtist", label: "Album artist" },
  { key: "genre", label: "Genre" },
];

export function validTrack(value) {
  value = value.trim();
  const parts = value.split("/").map(Number);
  return !value || (/^\d{1,4}(\/\d{1,4})?$/.test(value) &&
    parts.every((part) => part > 0) && (parts.length === 1 || parts[0] <= parts[1]));
}

/**
 * Turns per-field controls into a patch. Each control is { mode, value } where
 * mode is "keep", "set", "clear", or (track only) "sequence". Blank "set"
 * values are rejected rather than guessed at; clearing must be explicit.
 */
export function buildPatch(controls, count = 1) {
  const patch = {};
  const errors = {};
  for (const { key, label } of FIELDS) {
    const { mode = "keep", value = "" } = controls[key] || {};
    const text = String(value).trim();
    if (mode === "clear") patch[key] = { action: "clear" };
    else if (mode === "set") {
      if (!text) errors[key] = `Type a new ${label.toLowerCase()}, or choose Clear to remove it.`;
      else if (key === "track" && !validTrack(text)) errors[key] = "Use a track number from 1–9999, or track/total (e.g. 3/10).";
      else patch[key] = { action: "set", value: text };
    } else if (mode === "sequence" && key === "track") {
      const start = Number(text || 1);
      if (!/^\d{1,4}$/.test(text || "1") || start < 1 || start + Math.max(count, 1) - 1 > 9999) {
        errors[key] = "Start at a whole number that keeps every track within 1–9999.";
      } else patch[key] = { action: "sequence", start };
    }
  }
  const cover = controls.cover || {};
  if (cover.mode === "clear") patch.cover = { action: "clear" };
  else if (cover.mode === "set") {
    if (cover.value) patch.cover = { action: "set", value: cover.value };
    else errors.cover = "Choose an image, or keep the existing artwork.";
  }
  return { patch, errors };
}

// Returns new { values, cover } for one track; `position` numbers sequences.
export function patchMetadata({ values, cover }, patch, position = 0) {
  const next = { values: { ...values }, cover };
  for (const { key } of FIELDS) {
    const change = patch[key];
    if (change?.action === "set") next.values[key] = change.value;
    else if (change?.action === "clear") next.values[key] = "";
    else if (change?.action === "sequence") next.values[key] = String(change.start + position);
  }
  if (patch.cover?.action === "set") next.cover = patch.cover.value;
  else if (patch.cover?.action === "clear") next.cover = null;
  return next;
}

// Maps each selected track, in list order, to its patched metadata.
export function applyPatch(tracks, patch) {
  const targets = tracks.filter((track) => track.selected);
  return new Map(targets.map((track, position) => [track, patchMetadata(track, patch, position)]));
}

export function summarize(values) {
  const distinct = new Set(values.map((value) => value.trim()));
  if (distinct.size > 1) return { kind: "mixed" };
  const [value] = distinct;
  if (value === undefined) return { kind: "none" };
  return value ? { kind: "same", value } : { kind: "empty" };
}

// Covers are compared by identity; separately imported images count as distinct.
export function summarizeCovers(covers) {
  const withArt = covers.filter(Boolean).length;
  if (!covers.length) return { kind: "none" };
  if (!withArt) return { kind: "empty" };
  if (covers.every((cover) => cover === covers[0])) return { kind: "same", cover: covers[0] };
  return { kind: "mixed", withArt, total: covers.length };
}
