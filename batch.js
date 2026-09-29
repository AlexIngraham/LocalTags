import { readSourceMetadata } from "./metadata.js";
import { createZip, uniqueFilename } from "./zip.js";
import {
  FIELDS,
  applyPatch,
  buildPatch,
  summarize,
  summarizeCovers,
  validTrack,
} from "./edits.js";

const FIELD_KEYS = FIELDS.map(({ key }) => key);
const BULK_KEYS = [...FIELD_KEYS, "cover"];
const LABELS = {
  ...Object.fromEntries(FIELDS.map(({ key, label }) => [key, label])),
  cover: "Cover art",
};
const TEXT_MODES = [
  ["keep", "Keep existing"],
  ["set", "Set to"],
  ["clear", "Clear"],
];
const TRACK_MODES = [
  ["keep", "Keep existing"],
  ["set", "Set to"],
  ["sequence", "Number in order from"],
  ["clear", "Clear"],
];
const PENCIL =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z"/></svg>';

const plural = (count, noun = "track") =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

function listLabels(keys) {
  const labels = keys.map((key) => LABELS[key]);
  return labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`
    : labels[0];
}

function coverSummary(current, count) {
  if (current.kind === "none") return "Select tracks to see artwork";
  if (current.kind === "empty") return "No artwork";
  if (current.kind === "same")
    return count === 1 ? "Current artwork" : `Same artwork on all ${count}`;
  return `${current.withArt} of ${current.total} have artwork · each keeps its own`;
}

export function createBatchEditor(host) {
  const root = document.getElementById("batch-editor");
  const list = document.getElementById("track-list");
  const head = document.getElementById("track-head");
  const tableWrap = document.getElementById("track-table-wrap");
  const emptyNote = document.getElementById("album-empty");
  const summary = document.getElementById("batch-summary");
  const albumDownload = document.getElementById("album-download");
  const downloadHelp = document.getElementById("album-download-help");
  const feedback = document.getElementById("album-feedback");
  const stopButton = document.getElementById("stop-album");
  const albumProgress = document.getElementById("album-progress");
  const progressMeter = document.getElementById("album-progress-meter");
  const progressLabel = document.getElementById("album-progress-label");
  const undoButton = document.getElementById("undo-bulk");
  const bulkFields = document.getElementById("bulk-fields");
  const bulkSelection = document.getElementById("bulk-selection");
  const bulkPlan = document.getElementById("bulk-plan");
  const bulkMessage = document.getElementById("bulk-message");
  const applyButton = document.getElementById("apply-selected");
  const sharedCoverInput = document.getElementById("album-cover");
  const sharedPreview = document.getElementById("album-cover-preview");
  const coverNote = document.getElementById("bulk-cover-note");
  const shared = { cover: null, url: null, version: 0, pending: false };
  let tracks = [];
  let nextId = 0;
  let active = false;
  let busy = false;
  let orderVersion = 0;
  let archiveUrl = null;
  let currentTrack = null;
  let processingIndex = 0;
  let processedCount = 0;
  let hasProcessed = false;
  let stopRequested = false;
  let undo = null;
  let workers = 0;
  let anchor = null;
  const jobs = [];
  const retired = new Map();
  const alive = (track) => tracks.includes(track);
  const reading = () =>
    tracks.some((track) => track.pending || track.coverPending);
  const selection = () => tracks.filter((track) => track.selected);
  const trackFor = (element) =>
    tracks.find(
      (entry) => entry.id === element.closest(".track-row")?.dataset.trackId,
    );
  const modeOf = (key) => document.getElementById(`bulk-mode-${key}`);
  const inputOf = (key) => document.getElementById(`bulk-${key}`);
  const pendingEdits = () => BULK_KEYS.some((key) => modeOf(key).value !== "keep");

  bulkFields.insertAdjacentHTML(
    "afterbegin",
    FIELDS.map(
      ({ key, label }) => `
    <div class="bulk-row" data-bulk-row="${key}">
      <label class="bulk-label" for="bulk-mode-${key}">${label}</label>
      <select id="bulk-mode-${key}" data-bulk-mode="${key}">${(key === "track"
        ? TRACK_MODES
        : TEXT_MODES
      )
        .map(([value, text]) => `<option value="${value}">${text}</option>`)
        .join("")}</select>
      <input id="bulk-${key}" data-bulk-value="${key}" type="text" autocomplete="off" aria-describedby="bulk-error-${key}" />
      <p class="bulk-error" id="bulk-error-${key}" hidden></p>
    </div>`,
    ).join(""),
  );
  head.innerHTML = `<tr>
    <th scope="col" class="col-select"><input id="select-all-tracks" type="checkbox" aria-label="Select all tracks" /></th>
    ${[...FIELDS, { key: "cover", label: "Cover art" }]
      .map(
        ({ key, label, column = label }) => `
    <th scope="col" class="col-${key}"><span class="column-heading"><span id="col-${key}">${column}</span>
      <button type="button" class="column-edit" data-bulk-target="${key}" title="Set ${label} for selected tracks"
        aria-label="Set ${label} for selected tracks">${PENCIL}</button></span></th>`,
      )
      .join("")}
    <th scope="col" class="col-file">Filename</th>
    <th scope="col" class="col-status">Status</th>
    <th scope="col" class="col-actions"><span class="visually-hidden">Order and removal</span></th>
  </tr>`;
  const selectAll = document.getElementById("select-all-tracks");

  function retire(url) {
    if (!url) return;
    retired.set(
      url,
      setTimeout(() => {
        URL.revokeObjectURL(url);
        retired.delete(url);
      }, 60_000),
    );
  }

  function clearArchive() {
    if (!busy) host.setStatus("");
    retire(archiveUrl);
    archiveUrl = null;
    albumDownload.removeAttribute("href");
    albumDownload.removeAttribute("download");
    albumDownload.setAttribute("aria-disabled", "true");
    albumDownload.tabIndex = -1;
  }

  function invalidate(track) {
    clearArchive();
    if (track.result) retire(track.result.url);
    track.result = null;
    if (!track.pending && !track.loadError) track.status = "Waiting";
    track.error = track.loadError || "";
    track.percent = null;
  }

  function renderAlbumStatus() {
    const completed = tracks.filter((track) => track.result).length;
    const failed = tracks.filter((track) => track.status === "Error").length;
    const waiting = tracks.length - completed - failed;
    albumDownload.hidden = !active;
    feedback.hidden = !active;
    const ready = Boolean(archiveUrl) && !busy;
    albumDownload.setAttribute("aria-disabled", String(!ready));
    albumDownload.tabIndex = ready ? 0 : -1;
    stopButton.hidden = !busy || !currentTrack || processingIndex >= tracks.length;
    stopButton.disabled = stopRequested;
    stopButton.textContent = stopRequested ? "Stopping after this track…" : "Stop after this track";
    albumProgress.hidden = !busy;
    progressMeter.max = tracks.length || 1;
    progressMeter.value = processedCount;
    progressLabel.textContent = `Album progress: ${processedCount} of ${tracks.length} finished · ${completed} complete · ${failed} failed`;
    downloadHelp.textContent = busy
      ? !currentTrack && processedCount
        ? `Preparing a ZIP with ${plural(completed, "successful track")}…`
        : stopRequested
          ? "The current track will finish. Completed tracks will be available in the ZIP."
          : `Processing all ${plural(tracks.length)}. The ZIP will include successful tracks only.`
      : ready
        ? `ZIP ready · ${completed} of ${plural(tracks.length)} included.${failed || waiting ? ` Successful tracks only; ${failed} failed, ${waiting} not processed.` : ""}`
        : completed
          ? "Album changed or ZIP unavailable. Process Album again to prepare an updated ZIP. Individual MP3s are still available."
          : hasProcessed && failed
            ? "No ZIP available: no tracks processed successfully. Check the track errors and process again."
            : "Edit metadata → Process Album → Download Album ZIP. Processing includes all tracks; selection is for editing.";
  }

  function createRow(track) {
    const row = document.createElement("tr");
    const name = `${track.id}-name`;
    row.className = "track-row";
    row.dataset.trackId = track.id;
    row.innerHTML = `
      <td class="col-select"><input type="checkbox" data-select /></td>
      ${FIELD_KEYS.map(
        (key) => `<td class="col-${key}">
        <input class="cell-input" data-field="${key}" type="text" autocomplete="off" aria-labelledby="col-${key} ${name}" /></td>`,
      ).join("")}
      <td class="col-cover"><div class="cell-cover">
        <label class="track-cover-picker" for="${track.id}-cover"><img class="track-cover" alt="Track artwork" hidden /></label>
        <input id="${track.id}-cover" data-cover type="file" class="visually-hidden-file" aria-labelledby="col-cover ${name}"
          accept="image/jpeg,image/png,image/gif,image/webp" />
        <button type="button" class="cell-button" data-action="cover-remove" aria-label="Clear artwork">Clear</button>
      </div></td>
      <td class="col-file"><span class="track-filename" id="${name}"></span><span class="track-format"></span></td>
      <td class="col-status"><span class="track-status" role="status" aria-atomic="true"></span>
        <a class="download-link track-download" hidden>Download MP3</a>
        <p class="track-error" id="${track.id}-error" role="alert" hidden></p></td>
      <td class="col-actions"><div class="row-actions">
        <button type="button" class="cell-button" data-action="up" aria-label="Move track up">↑</button>
        <button type="button" class="cell-button" data-action="down" aria-label="Move track down">↓</button>
        <button type="button" class="cell-button" data-action="remove" aria-label="Remove track">✕</button>
      </div></td>`;
    row
      .querySelector("[data-select]")
      .setAttribute("aria-label", `Select ${track.file.name}`);
    row.querySelector('[data-field="track"]').setAttribute("aria-describedby", `${track.id}-error`);
    return row;
  }

  function renderTrack(track) {
    const row = track.row;
    const filename = row.querySelector(".track-filename");
    filename.textContent = track.file.name;
    filename.title = track.file.name;
    row.querySelector(".track-format").textContent = track.format
      ? host.formatLabel(track.format)
      : "Checking";
    row.querySelector(".track-status").textContent = track.coverPending
      ? "Reading artwork"
      : `${track.status}${track.percent == null ? "" : ` · ${track.percent}%`}`;
    row.dataset.status = track.status.toLowerCase();
    row.classList.toggle("is-selected", track.selected);
    row.querySelector("[data-select]").checked = track.selected;
    for (const key of FIELD_KEYS) {
      const input = row.querySelector(`[data-field="${key}"]`);
      const value = track.values[key];
      if (input.value !== value) input.value = value;
      if (key === "track")
        input.setAttribute("aria-invalid", String(!validTrack(value)));
    }
    const image = row.querySelector(".track-cover");
    image.hidden = !track.coverUrl;
    if (track.coverUrl) image.src = track.coverUrl;
    else image.removeAttribute("src");
    row.querySelector(".track-cover-picker").title = track.coverUrl
      ? "Replace artwork"
      : "Choose artwork";
    row.querySelector('[data-action="cover-remove"]').hidden =
      !track.coverUrl && !track.coverPending;
    const error = row.querySelector(".track-error");
    error.textContent = !validTrack(track.values.track)
      ? "Use a track number from 1–9999, or track/total (e.g. 3/10)."
      : track.error || track.coverError || "";
    error.hidden = !error.textContent;
    const link = row.querySelector(".track-download");
    link.hidden = !track.result;
    if (track.result) {
      link.href = track.result.url;
      link.download = track.result.name;
    } else link.removeAttribute("href");
  }

  function renderBulk() {
    const selected = selection();
    const count = selected.length;
    bulkSelection.textContent = count
      ? `${count} of ${plural(tracks.length)} selected`
      : "No tracks selected";
    for (const { key, label } of FIELDS) {
      const mode = modeOf(key).value;
      const input = inputOf(key);
      input.closest(".bulk-row").dataset.mode = mode;
      input.disabled = busy || mode === "clear";
      modeOf(key).disabled = busy;
      input.setAttribute(
        "aria-label",
        mode === "sequence"
          ? "First track number"
          : `${label} for selected tracks`,
      );
      if (mode === "keep") {
        // Preview only: a shared value is shown, but a mixed one is never
        // replaced by any single track's value.
        const current = summarize(selected.map((track) => track.values[key]));
        const preview = current.kind === "same" ? current.value : "";
        if (input.value !== preview) input.value = preview;
        input.placeholder = {
          none: "Select tracks to see values",
          empty: "No value",
          mixed: "Mixed · each track keeps its own",
          same: "",
        }[current.kind];
      } else if (mode === "clear") {
        input.value = "";
        input.placeholder = count
          ? `Will be cleared on ${plural(count)}`
          : "Will be cleared";
      } else
        input.placeholder =
          mode === "sequence" ? "1" : `New ${label.toLowerCase()}`;
    }
    const coverMode = modeOf("cover").value;
    modeOf("cover").disabled = busy;
    sharedCoverInput.disabled = busy;
    let preview = null;
    sharedCoverInput.closest(".bulk-row").dataset.mode = coverMode;
    if (coverMode === "keep") {
      const current = summarizeCovers(selected.map((track) => track.cover));
      if (current.kind === "same")
        preview = selected.find(
          (track) => track.cover === current.cover,
        ).coverUrl;
      coverNote.textContent = coverSummary(current, count);
    } else if (coverMode === "set") {
      preview = shared.url;
      coverNote.textContent = shared.cover
        ? "New image"
        : "JPEG, PNG, GIF or WebP · up to 10 MB";
    } else
      coverNote.textContent = count
        ? `Will be removed from ${plural(count)}`
        : "Will be removed";
    sharedPreview.hidden = !preview;
    if (!preview) sharedPreview.removeAttribute("src");
    else if (sharedPreview.getAttribute("src") !== preview)
      sharedPreview.src = preview;
    const changing = BULK_KEYS.filter((key) => modeOf(key).value !== "keep");
    applyButton.textContent = count
      ? `Apply to ${plural(count, "selected track")}`
      : "Apply to selected tracks";
    applyButton.disabled = busy || shared.pending || !count || !changing.length;
    document.getElementById("reset-bulk").disabled = busy || (!changing.length && !shared.pending && !bulkFields.querySelector('[aria-invalid="true"]'));
    undoButton.hidden = !undo;
    undoButton.disabled = busy || !undo;
    bulkPlan.textContent = !count
      ? "Select tracks in the table below to edit them together."
      : !changing.length
        ? "Choose Set or Clear on only the fields you want to change."
        : `Not applied yet: ${listLabels(changing)} on ${plural(count)}. Everything else stays as is.${modeOf("track").value === "sequence" ? " Numbers follow the current table order." : ""}`;
  }

  function render() {
    tracks.forEach((track, index) => {
      renderTrack(track);
      if (list.children[index] !== track.row)
        list.insertBefore(track.row, list.children[index] || null);
    });
    const selected = selection().length;
    const completed = tracks.filter((track) => track.result).length;
    const failed = tracks.filter((track) => track.status === "Error").length;
    summary.textContent = `${plural(tracks.length)} uploaded · ${selected} selected${hasProcessed || failed ? ` · ${completed} complete · ${failed} failed` : ""}`;
    tableWrap.hidden = !tracks.length;
    emptyNote.hidden = Boolean(tracks.length);
    selectAll.checked = tracks.length > 0 && selected === tracks.length;
    selectAll.indeterminate = selected > 0 && selected < tracks.length;
    host.updateActions();
    renderAlbumStatus();
  }

  function showError(key, message = "") {
    const error = document.getElementById(`bulk-error-${key}`);
    error.textContent = message;
    error.hidden = !message;
    (key === "cover" ? modeOf(key) : inputOf(key)).setAttribute(
      "aria-invalid",
      String(Boolean(message)),
    );
  }

  function resetBulk() {
    for (const key of BULK_KEYS) {
      modeOf(key).value = "keep";
      showError(key);
    }
  }

  function replaceCover(track, file) {
    // The shared file was already validated. A fresh preview URL belongs to
    // each track, so removing one track cannot revoke another track's art.
    track.coverVersion++;
    track.coverPending = false;
    track.coverEdited = true;
    track.coverError = "";
    if (track.coverUrl) URL.revokeObjectURL(track.coverUrl);
    track.cover = file;
    track.coverUrl = file ? URL.createObjectURL(file) : null;
  }

  function applyBulk() {
    if (busy || shared.pending) return;
    const targets = selection();
    const controls = Object.fromEntries(
      BULK_KEYS.map((key) => [
        key,
        {
          mode: modeOf(key).value,
          value: key === "cover" ? shared.cover : inputOf(key).value,
        },
      ]),
    );
    const { patch, errors } = buildPatch(controls, targets.length);
    const invalid = Object.keys(errors);
    const keys = Object.keys(patch);
    BULK_KEYS.forEach((key) => showError(key, errors[key]));
    if (!targets.length || invalid.length || !keys.length) {
      bulkMessage.textContent = !targets.length
        ? "Select tracks first."
        : invalid.length
          ? `Nothing was changed. Fix ${listLabels(invalid)} first.`
          : "Choose Set or Clear on at least one field.";
      if (invalid.length)
        (invalid[0] === "cover"
          ? modeOf("cover")
          : inputOf(invalid[0])
        ).focus();
      return;
    }
    // Undo is offered once source reads have settled, so it cannot restore an
    // incomplete metadata snapshot over tags that arrived in the meantime.
    undo = targets.some((track) => track.pending || track.coverPending) ? null : {
      keys,
      entries: targets.map((track) => ({
        track, values: { ...track.values }, cover: track.cover,
        edited: new Set(track.edited), coverEdited: track.coverEdited,
      })),
    };
    for (const [track, next] of applyPatch(tracks, patch)) {
      for (const key of FIELD_KEYS) if (patch[key]) track.edited.add(key);
      track.values = next.values;
      if (patch.cover) replaceCover(track, next.cover);
      invalidate(track);
    }
    if (patch.track) orderVersion++;
    // Starting fresh keeps a finished edit from being re-applied to the next selection.
    resetBulk();
    bulkMessage.textContent = `Updated ${listLabels(keys)} on ${plural(targets.length)}. Everything else was left as is.`;
    render();
  }

  function openBulkField(key) {
    if (busy || !selection().length) return;
    const mode = modeOf(key);
    if (mode.value === "keep") mode.value = "set";
    showError(key);
    renderBulk();
    const row = mode.closest(".bulk-row");
    row.classList.add("is-targeted");
    row.addEventListener(
      "animationend",
      () => row.classList.remove("is-targeted"),
      { once: true },
    );
    const target = key === "cover" ? sharedCoverInput : inputOf(key);
    target.focus();
    if (key !== "cover") target.select();
  }

  function select(track, selected, extend) {
    const from = extend && alive(anchor) ? tracks.indexOf(anchor) : -1;
    const to = tracks.indexOf(track);
    if (from < 0) track.selected = selected;
    else
      for (let index = Math.min(from, to); index <= Math.max(from, to); index++)
        tracks[index].selected = selected;
    anchor = track;
    render();
  }

  async function setCover(track, file, userEdit = true) {
    if (!alive(track)) return;
    if (userEdit) undo = null;
    if (userEdit) track.coverEdited = true;
    const version = ++track.coverVersion;
    track.coverPending = Boolean(file);
    track.coverError = "";
    invalidate(track);
    render();
    let url = null;
    try {
      if (file) url = await host.validateArtwork(file);
      if (!alive(track) || version !== track.coverVersion) return;
      if (track.coverUrl) URL.revokeObjectURL(track.coverUrl);
      track.cover = file;
      track.coverUrl = url;
      url = null;
    } catch (error) {
      if (alive(track) && version === track.coverVersion)
        track.coverError = error.message;
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (alive(track) && version === track.coverVersion) {
        track.coverPending = false;
        render();
      }
    }
  }

  async function readTrack(track, importMetadata) {
    try {
      if (!alive(track)) return;
      track.status = "Reading metadata";
      render();
      track.format = await host.inspectAudio(track.file);
      if (!alive(track)) return;
      if (importMetadata) {
        // Parsers already recover from corrupt tags; keep the batch usable even
        // if a browser File read or an unexpected parser exception rejects.
        const source = await readSourceMetadata(track.file).catch(() => ({}));
        if (!alive(track)) return;
        for (const key of FIELD_KEYS) {
          if (!track.edited.has(key)) track.values[key] = source[key] || "";
        }
        if (source.cover && !track.coverEdited)
          await setCover(track, source.cover, false);
      }
      if (alive(track)) track.status = "Waiting";
    } catch (error) {
      if (alive(track)) {
        track.loadError = error.message;
        track.error = error.message;
        track.status = "Error";
      }
    } finally {
      if (alive(track)) {
        track.pending = false;
        render();
      }
    }
  }

  function pump() {
    while (workers < 2 && jobs.length) {
      const job = jobs.shift();
      if (!alive(job.track)) {
        job.resolve();
        continue;
      }
      workers++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        workers--;
        job.track.releaseRead = null;
        job.resolve();
        pump();
      };
      // File reads cannot be physically aborted. Detach a removed entry from
      // the queue so an old stalled read cannot hold up a newly added album.
      job.track.releaseRead = release;
      readTrack(job.track, job.importMetadata).finally(release);
    }
  }

  function compareTracks(a, b) {
    const number = (track) =>
      Number.parseInt(track.values.track, 10) || Infinity;
    const left = number(a),
      right = number(b);
    return (
      (left === right ? 0 : left - right) ||
      a.file.name.localeCompare(b.file.name, undefined, { numeric: true })
    );
  }

  async function add(files, importMetadata, seed = null) {
    if (busy) return;
    undo = null;
    active = true;
    root.hidden = false;
    clearArchive();
    const initiallyEmpty = !tracks.length;
    const revision = ++orderVersion;
    const entries = [...(seed ? [seed.file] : []), ...files];
    const pending = entries.map((file, index) => {
      const initial = seed && index === 0 ? seed : null;
      const track = {
        id: `track-${++nextId}`,
        file,
        format: initial?.format || null,
        values: Object.fromEntries(
          FIELD_KEYS.map((key) => [key, initial?.values[key] || ""]),
        ),
        edited: new Set(initial?.edited || []),
        selected: false,
        pending: true,
        status: "Waiting",
        loadError: "",
        error: "",
        coverError: "",
        result: null,
        cover: initial?.cover || null,
        coverUrl: initial?.cover ? URL.createObjectURL(initial.cover) : null,
        coverEdited: initial?.coverEdited || false,
        coverVersion: 0,
        coverPending: false,
      };
      track.row = createRow(track);
      tracks.push(track);
      if (initial?.pendingCover) setCover(track, initial.pendingCover);
      return new Promise((resolve) =>
        jobs.push({
          track,
          importMetadata: initial?.importMetadata ?? importMetadata,
          resolve,
        }),
      );
    });
    render();
    pump();
    await Promise.all(pending);
    // Initial sorting is a convenience. Never undo a user's reorder/numbering
    // or reshuffle existing edits when another upload has joined the album.
    if (initiallyEmpty && revision === orderVersion) {
      tracks.sort(compareTracks);
      render();
    }
  }

  function remove(track) {
    if (busy || !alive(track)) return;
    undo = null;
    const wasFocused = track.row.contains(document.activeElement);
    const next = tracks[tracks.indexOf(track) + 1] || tracks[tracks.indexOf(track) - 1];
    orderVersion++;
    invalidate(track);
    if (track.coverUrl) URL.revokeObjectURL(track.coverUrl);
    tracks = tracks.filter((entry) => entry !== track);
    track.releaseRead?.();
    track.row.remove();
    render();
    if (wasFocused) (next?.row.querySelector("[data-select]") || document.getElementById("add-audio")).focus();
  }

  function clear() {
    if (busy) return;
    for (const track of [...tracks]) remove(track);
    shared.version++;
    shared.pending = false;
    shared.cover = null;
    if (shared.url) URL.revokeObjectURL(shared.url);
    shared.url = null;
    sharedCoverInput.value = "";
    resetBulk();
    bulkMessage.textContent = "";
    hasProcessed = false;
    processedCount = 0;
    render();
  }

  async function process() {
    if (busy || reading() || shared.pending || !tracks.length) return;
    if (pendingEdits()) {
      host.setStatus("Bulk changes have not been applied. Apply to selected tracks or Discard changes before processing.", "err");
      (applyButton.disabled ? document.getElementById("reset-bulk") : applyButton).focus();
      return;
    }
    const focusedControl = document.activeElement;
    busy = true;
    hasProcessed = true;
    stopRequested = false;
    processedCount = 0;
    processingIndex = 0;
    undo = null;
    for (const track of tracks) invalidate(track);
    host.setBusy(true);
    render();
    let completed = 0;
    const usedNames = new Set();
    try {
      for (const [index, track] of tracks.entries()) {
        if (stopRequested) break;
        currentTrack = track;
        processingIndex = index + 1;
        track.status = "Reading audio";
        host.setStatus(`Processing ${processingIndex} of ${tracks.length} · ${track.file.name}`);
        render();
        try {
          if (track.loadError) throw new Error(track.loadError);
          if (!validTrack(track.values.track))
            throw new Error(
              "Use a track number from 1–9999, or track/total with total at least the track number.",
            );
          const values = Object.fromEntries(
            Object.entries(track.values).map(([key, value]) => [
              key,
              value.trim(),
            ]),
          );
          const blob = await host.processTrack({
            file: track.file,
            values,
            cover: track.cover,
          });
          const number = Number.parseInt(values.track, 10);
          const title = host.safeName(
            values.title || track.file.name.replace(/\.[^.]+$/, ""),
          );
          const name = uniqueFilename(
            number
              ? `${String(number).padStart(2, "0")} - ${[...title].slice(0, 100).join("") || "Track"}.mp3`
              : host.outputName(values.artist, values.title, track.file.name),
            usedNames,
          );
          track.result = { blob, name, url: URL.createObjectURL(blob) };
          track.status = "Complete";
          completed++;
        } catch (error) {
          track.status = "Error";
          track.error =
            error.message ||
            "This track could not be processed. Try another source file.";
        }
        track.percent = null;
        processedCount++;
        render();
      }
      currentTrack = null;
      host.updateActions();
      renderAlbumStatus();
      if (completed) {
        host.setStatus("Preparing album ZIP…");
        const blob = await createZip(
          tracks.filter((track) => track.result).map((track) => track.result),
        );
        archiveUrl = URL.createObjectURL(blob);
        const albums = new Set(
          tracks
            .filter((track) => track.result)
            .map((track) => track.values.album.trim())
            .filter(Boolean),
        );
        const album = albums.size === 1 ? [...albums][0] : "Tagged album";
        albumDownload.href = archiveUrl;
        albumDownload.download = `${[...host.safeName(album)].slice(0, 100).join("") || "Tagged album"}.zip`;
      }
      const failed = tracks.filter((track) => track.status === "Error").length;
      host.setStatus(
        `${stopRequested ? "Processing stopped" : "Album processed"}: ${completed} complete, ${failed} failed${stopRequested ? `, ${tracks.length - completed - failed} not processed` : ""}.${completed ? " Download Album ZIP or individual MP3s." : ""}${failed ? " Check the errors beside each track, then Process Album to retry." : ""}${stopRequested ? " Process Album again to restart." : ""}`,
        failed || !completed ? "err" : "ok",
      );
    } catch (error) {
      host.setStatus(
        `${completed} tracks complete. ${error.message} Individual downloads remain available.`,
        "err",
      );
    } finally {
      currentTrack = null;
      busy = false;
      host.finishProcessing();
      render();
      if (document.activeElement === document.body || document.activeElement === stopButton || document.activeElement === focusedControl) {
        document.getElementById("submit-button").focus({ preventScroll: true });
      }
    }
  }

  list.addEventListener("input", (event) => {
    const track = trackFor(event.target);
    const key = event.target.dataset.field;
    if (busy || !track || !key) return;
    undo = null;
    track.values[key] = event.target.value;
    track.edited.add(key);
    if (key === "track") orderVersion++;
    invalidate(track);
    render();
  });
  list.addEventListener("keydown", (event) => {
    const key = event.target.dataset.field;
    if (event.key !== "Enter" || event.isComposing || !key) return;
    // Enter commits a cell like a spreadsheet instead of processing the album.
    event.preventDefault();
    const row = event.target.closest(".track-row");
    const next = event.shiftKey
      ? row.previousElementSibling
      : row.nextElementSibling;
    next?.querySelector(`[data-field="${key}"]`).focus();
  });
  list.addEventListener("change", (event) => {
    if (busy || !event.target.matches("[data-cover]")) return;
    const track = trackFor(event.target);
    const file = event.target.files?.[0];
    if (track && file) setCover(track, file);
    event.target.value = "";
  });
  list.addEventListener("click", (event) => {
    const track = trackFor(event.target);
    if (busy || !track) return;
    if (event.target.matches("[data-select]")) {
      select(track, event.target.checked, event.shiftKey);
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "remove") remove(track);
    else if (action === "cover-remove") setCover(track, null);
    else if (action === "up" || action === "down") {
      const index = tracks.indexOf(track);
      const next = index + (action === "up" ? -1 : 1);
      if (next < 0 || next >= tracks.length) return;
      [tracks[index], tracks[next]] = [tracks[next], tracks[index]];
      orderVersion++;
      clearArchive();
      render();
    }
  });
  head.addEventListener("click", (event) => {
    const key = event.target.closest("[data-bulk-target]")?.dataset.bulkTarget;
    if (key) openBulkField(key);
  });
  selectAll.addEventListener("change", () => {
    if (busy) return;
    tracks.forEach((track) => {
      track.selected = selectAll.checked;
    });
    anchor = null;
    render();
  });
  bulkFields.addEventListener("change", (event) => {
    const key = event.target.dataset.bulkMode;
    if (busy || !key) return;
    showError(key);
    if (key !== "cover") {
      const input = inputOf(key);
      const previous = event.target.closest(".bulk-row").dataset.mode;
      if (event.target.value === "sequence") input.value = "1";
      else if (event.target.value === "set" && previous !== "keep")
        input.value = "";
    }
    renderBulk();
  });
  bulkFields.addEventListener("input", (event) => {
    const key = event.target.dataset.bulkValue;
    if (busy || !key) return;
    if (modeOf(key).value === "keep") modeOf(key).value = "set";
    showError(key);
    renderBulk();
  });
  bulkFields.addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" ||
      event.isComposing ||
      !event.target.dataset.bulkValue
    )
      return;
    event.preventDefault();
    applyBulk();
  });
  document.getElementById("clear-batch").addEventListener("click", () => {
    if (busy || !tracks.length) return;
    if (window.confirm(`Clear all ${plural(tracks.length)}? Metadata edits and prepared downloads will be removed. Your original files will stay on your device.`)) {
      clear();
      document.getElementById("add-audio").focus();
    }
  });
  document.getElementById("remove-selected").addEventListener("click", () => {
    const targets = selection();
    if (busy || !targets.length) return;
    if (window.confirm(`Remove ${plural(targets.length, "selected track")}? Their metadata edits and prepared downloads will be removed. Your original files will stay on your device.`)) {
      targets.forEach(remove);
      (tracks[0]?.row.querySelector("[data-select]") || document.getElementById("add-audio")).focus();
    }
  });
  stopButton.addEventListener("click", () => {
    if (!busy || !currentTrack) return;
    stopRequested = true;
    renderAlbumStatus();
  });
  albumDownload.addEventListener("click", (event) => {
    if (busy || !archiveUrl) event.preventDefault();
  });
  undoButton.addEventListener("click", () => {
    if (busy || !undo) return;
    const { entries, keys } = undo;
    undo = null;
    for (const entry of entries) {
      const { track } = entry;
      if (!alive(track)) continue;
      for (const key of keys) {
        if (key === "cover") {
          replaceCover(track, entry.cover);
          track.coverEdited = entry.coverEdited;
        } else {
          track.values[key] = entry.values[key];
          if (entry.edited.has(key)) track.edited.add(key);
          else track.edited.delete(key);
        }
      }
      invalidate(track);
    }
    if (keys.includes("track")) orderVersion++;
    bulkMessage.textContent = `Undid ${listLabels(keys)} on ${plural(entries.length)}.`;
    render();
    selectAll.focus();
  });
  document.getElementById("sort-tracks").addEventListener("click", () => {
    if (busy) return;
    orderVersion++;
    tracks.sort(compareTracks);
    clearArchive();
    render();
  });
  applyButton.addEventListener("click", applyBulk);
  document.getElementById("reset-bulk").addEventListener("click", () => {
    if (busy) return;
    shared.version++;
    shared.pending = false;
    sharedCoverInput.value = "";
    resetBulk();
    bulkMessage.textContent = "";
    host.setStatus("");
    render();
  });
  sharedCoverInput.addEventListener("change", async () => {
    const file = sharedCoverInput.files?.[0];
    if (busy || !file) return;
    const version = ++shared.version;
    shared.pending = true;
    showError("cover");
    bulkMessage.textContent = "Checking artwork…";
    render();
    let url = null;
    try {
      url = await host.validateArtwork(file);
      if (version !== shared.version) return;
      if (shared.url) URL.revokeObjectURL(shared.url);
      shared.cover = file;
      shared.url = url;
      url = null;
      modeOf("cover").value = "set";
      bulkMessage.textContent =
        "Artwork ready. Choose Apply to use it on the selected tracks.";
    } catch (error) {
      if (version === shared.version) {
        showError("cover", error.message);
        bulkMessage.textContent = "";
      }
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (version === shared.version) {
        shared.pending = false;
        sharedCoverInput.value = "";
        render();
      }
    }
  });

  return {
    get active() {
      return active;
    },
    get checking() {
      return reading() || shared.pending;
    },
    get count() {
      return tracks.length;
    },
    get actionLabel() {
      if (!busy) return hasProcessed ? "Reprocess Album" : "Process Album";
      return currentTrack || !processedCount
        ? `Processing… ${processingIndex} / ${tracks.length}`
        : "Preparing ZIP…";
    },
    add,
    process,
    clear,
    stage(label) {
      if (!currentTrack) return label;
      currentTrack.percent = null;
      currentTrack.status = /metadata|artwork/i.test(label)
        ? "Tagging"
        : /decod|creating/i.test(label)
          ? "Converting"
          : "Reading audio";
      renderTrack(currentTrack);
      return `Processing ${processingIndex} of ${tracks.length} · ${label}`;
    },
    progress(percent) {
      if (!currentTrack) return;
      currentTrack.percent = percent;
      renderTrack(currentTrack);
    },
    updateControls(processing) {
      root.querySelectorAll("input, button, select").forEach((control) => {
        control.disabled = processing;
      });
      if (!processing) {
        const count = selection().length;
        selectAll.disabled = !tracks.length;
        selectAll.setAttribute("aria-label", selectAll.checked ? "Deselect all tracks" : "Select all tracks");
        document.getElementById("clear-batch").disabled = !tracks.length;
        document.getElementById("remove-selected").disabled = !count;
        document.getElementById("sort-tracks").disabled = tracks.length < 2 || reading();
        head.querySelectorAll("button").forEach((button) => { button.disabled = !count; });
        tracks.forEach((track, index) => {
          track.row.querySelector('[data-action="up"]').disabled = index === 0;
          track.row.querySelector('[data-action="down"]').disabled = index === tracks.length - 1;
        });
        renderBulk();
      }
    },
    dispose() {
      for (const track of tracks) {
        if (track.coverUrl) URL.revokeObjectURL(track.coverUrl);
        if (track.result) URL.revokeObjectURL(track.result.url);
      }
      if (archiveUrl) URL.revokeObjectURL(archiveUrl);
      if (shared.url) URL.revokeObjectURL(shared.url);
      for (const [url, timer] of retired) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      retired.clear();
    },
  };
}
