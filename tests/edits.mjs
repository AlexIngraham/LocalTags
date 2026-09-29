// Run with: node --test tests/edits.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPatch, buildPatch, patchMetadata, summarize, summarizeCovers, validTrack } from "../edits.js";

const embedded = { name: "embedded.png" };
const otherArt = { name: "other.png" };
const newArt = { name: "new.png" };

function album() {
  return [
    { selected: true, cover: embedded, values: { track: "1", title: "One More Time", artist: "Daft Punk", album: "Discovery", albumArtist: "Daft Punk", genre: "Dance" } },
    { selected: true, cover: otherArt, values: { track: "2", title: "Aerodynamic", artist: "Daft Punk", album: "Discovery", albumArtist: "", genre: "Electronic" } },
    { selected: true, cover: null, values: { track: "3", title: "Digital Love", artist: "Daft Punk feat. DJ Falcon", album: "Discovery", albumArtist: "", genre: "Pop" } },
    { selected: false, cover: embedded, values: { track: "4", title: "Harder, Better, Faster, Stronger", artist: "Daft Punk", album: "Discovery", albumArtist: "", genre: "House" } },
  ];
}

// Commits a patch the way the editor does: only mapped tracks receive new metadata.
function edit(tracks, controls) {
  const { patch, errors } = buildPatch(controls, tracks.filter((track) => track.selected).length);
  const changes = applyPatch(tracks, patch);
  return { patch, errors, tracks: tracks.map((track) => (changes.has(track) ? { ...track, ...changes.get(track) } : track)) };
}

function expectOnly(before, after, change) {
  after.forEach((track, index) => {
    const expected = change(before[index], index);
    assert.deepEqual(track.values, expected.values, `track ${index + 1} values`);
    assert.equal(track.cover, expected.cover, `track ${index + 1} artwork`);
  });
}

const withValues = (track, values) => ({ ...track, values: { ...track.values, ...values } });

test("editing only Album preserves title, artist, genre, artwork and track number", () => {
  const before = album();
  const { patch, tracks } = edit(before, { album: { mode: "set", value: "Discovery (Remastered)" } });
  assert.deepEqual(Object.keys(patch), ["album"]);
  expectOnly(before, tracks, (track) => (track.selected ? withValues(track, { album: "Discovery (Remastered)" }) : track));
});

test("editing only cover art preserves all text metadata", () => {
  const before = album();
  const { patch, tracks } = edit(before, { cover: { mode: "set", value: newArt } });
  assert.deepEqual(patch, { cover: { action: "set", value: newArt } });
  expectOnly(before, tracks, (track) => (track.selected ? { ...track, cover: newArt } : track));
});

test("editing one track's title does not modify any other track", () => {
  const before = album().map((track, index) => ({ ...track, selected: index === 1 }));
  const { tracks } = edit(before, { title: { mode: "set", value: "Aerodynamic (Edit)" } });
  expectOnly(before, tracks, (track, index) => (index === 1 ? withValues(track, { title: "Aerodynamic (Edit)" }) : track));
});

test("unselected tracks are not patched, and inputs are never mutated", () => {
  const before = album();
  const snapshot = structuredClone(before);
  const { patch } = buildPatch({ genre: { mode: "set", value: "French House" }, cover: { mode: "clear" } });
  const changes = applyPatch(before, patch);
  assert.deepEqual([...changes.keys()], before.slice(0, 3));
  assert.equal(changes.has(before[3]), false);
  assert.deepEqual(before, snapshot);
  assert.equal(before[0].cover, embedded);
});

test("mixed values are reported as mixed and survive when their field is untouched", () => {
  const before = album();
  const selected = before.filter((track) => track.selected);
  assert.deepEqual(summarize(selected.map((track) => track.values.genre)), { kind: "mixed" });
  assert.deepEqual(summarize(selected.map((track) => track.values.artist)), { kind: "mixed" });
  assert.deepEqual(summarize(selected.map((track) => track.values.album)), { kind: "same", value: "Discovery" });
  const { patch, tracks } = edit(before, { album: { mode: "set", value: "Discovery" }, genre: { mode: "keep", value: "" }, artist: { mode: "keep" } });
  assert.deepEqual(Object.keys(patch), ["album"]);
  assert.deepEqual(tracks.map((track) => track.values.genre), ["Dance", "Electronic", "Pop", "House"]);
  assert.deepEqual(tracks.map((track) => track.values.artist), before.map((track) => track.values.artist));
});

test("explicit clearing removes only the chosen field", () => {
  const before = album();
  const { patch, tracks } = edit(before, { genre: { mode: "clear" } });
  assert.deepEqual(patch, { genre: { action: "clear" } });
  expectOnly(before, tracks, (track) => (track.selected ? withValues(track, { genre: "" }) : track));
});

test("empty bulk fields never erase metadata", () => {
  const before = album();
  for (const value of ["", "   "]) {
    const { patch, errors, tracks } = edit(before, { album: { mode: "set", value }, artist: { mode: "set", value } });
    assert.deepEqual(patch, {});
    assert.match(errors.album, /Clear/);
    assert.match(errors.artist, /Clear/);
    expectOnly(before, tracks, (track) => track);
  }
  const untouched = edit(before, Object.fromEntries(["track", "title", "artist", "album", "albumArtist", "genre"].map((key) => [key, { mode: "keep", value: "" }])));
  assert.deepEqual(untouched.patch, {});
  expectOnly(before, untouched.tracks, (track) => track);
  assert.deepEqual(buildPatch({ cover: { mode: "set", value: null } }).patch, {});
  assert.match(buildPatch({ cover: { mode: "set", value: null } }).errors.cover, /Choose an image/);
  assert.deepEqual(patchMetadata(before[0], {}), { values: before[0].values, cover: embedded });
});

test("sequential numbering follows list order and modifies only the track number", () => {
  const before = album().map((track, index) => ({ ...track, selected: index > 0 }));
  const { patch, tracks } = edit(before, { track: { mode: "sequence", value: "7" } });
  assert.deepEqual(patch, { track: { action: "sequence", start: 7 } });
  expectOnly(before, tracks, (track, index) => (index ? withValues(track, { track: String(index + 6) }) : track));
  assert.deepEqual(buildPatch({ track: { mode: "sequence", value: "" } }).patch, { track: { action: "sequence", start: 1 } });
  for (const value of ["0", "1.5", "abc", "9999"]) {
    assert.ok(buildPatch({ track: { mode: "sequence", value } }, 2).errors.track, `start ${value} is rejected`);
  }
  assert.deepEqual(buildPatch({ track: { mode: "sequence", value: "9998" } }, 2).errors, {});
  assert.deepEqual(buildPatch({ title: { mode: "sequence", value: "1" } }).patch, {}, "only track numbers can be sequenced");
});

test("removing artwork does not modify other tags", () => {
  const before = album();
  const { tracks } = edit(before, { cover: { mode: "clear" } });
  expectOnly(before, tracks, (track) => (track.selected ? { ...track, cover: null } : track));
});

test("multiple field changes apply together while untouched fields stay intact", () => {
  const before = album();
  const { patch, errors, tracks } = edit(before, {
    album: { mode: "set", value: "  Discovery  " },
    genre: { mode: "set", value: "Electronic" },
    track: { mode: "clear" },
    cover: { mode: "set", value: newArt },
    title: { mode: "keep", value: "ignored while kept" },
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(Object.keys(patch).sort(), ["album", "cover", "genre", "track"]);
  expectOnly(before, tracks, (track) => (track.selected
    ? { ...withValues(track, { album: "Discovery", genre: "Electronic", track: "" }), cover: newArt }
    : track));
});

test("a set track number is validated before anything is patched", () => {
  assert.match(buildPatch({ track: { mode: "set", value: "3/2" } }).errors.track, /1–9999/);
  assert.deepEqual(buildPatch({ track: { mode: "set", value: "3/10" } }).patch, { track: { action: "set", value: "3/10" } });
  assert.ok(validTrack("") && validTrack("12") && !validTrack("0") && !validTrack("1/2/3"));
});

test("summaries distinguish none, empty, same and mixed values and artwork", () => {
  assert.deepEqual(summarize([]), { kind: "none" });
  assert.deepEqual(summarize(["", " "]), { kind: "empty" });
  assert.deepEqual(summarize(["Discovery", " Discovery "]), { kind: "same", value: "Discovery" });
  assert.deepEqual(summarize(["Discovery", ""]), { kind: "mixed" });
  assert.deepEqual(summarizeCovers([]), { kind: "none" });
  assert.deepEqual(summarizeCovers([null, null]), { kind: "empty" });
  assert.deepEqual(summarizeCovers([newArt, newArt]), { kind: "same", cover: newArt });
  assert.deepEqual(summarizeCovers([embedded, null, otherArt]), { kind: "mixed", withArt: 2, total: 3 });
});
