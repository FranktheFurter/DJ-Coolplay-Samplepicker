import type { AppState, SampleRecord, WaveformPreview } from "./types";

interface UIHandlers {
  onPickDirectory: () => void | Promise<void>;
  onRefreshScan: () => void | Promise<void>;
  onSearchChange: (query: string) => void;
  onAssignedOnlyChange: (showAssignedOnly: boolean) => void;
  onLoopEnabledChange: (loopEnabled: boolean) => void;
  getPlaybackProgress: (
    sampleId: string,
    fallbackDurationSeconds: number,
  ) => number | null;
  onSelectSample: (sampleId: string) => void;
  onAssignSlot: (sampleId: string, slotValue: string) => void | Promise<void>;
  onTogglePlay: (sampleId: string) => void | Promise<void>;
}

interface UIController {
  render: (state: AppState) => void;
}

function formatCount(count: number): string {
  return `${count} Sample${count === 1 ? "" : "s"}`;
}

function formatStatus(state: AppState): string {
  if (state.isScanning) {
    return "Scan laeuft...";
  }

  if (!state.currentDirectoryName) {
    return "Noch kein Ordner ausgewaehlt.";
  }

  const lastScan = state.lastScanAt
    ? `Zuletzt gescannt: ${new Date(state.lastScanAt).toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : "Index aus IndexedDB geladen.";

  return `Ordner: ${state.currentDirectoryName} · ${lastScan}`;
}

function formatDuration(durationSeconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationSeconds));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  waveform: WaveformPreview | null,
): void {
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  const devicePixelRatio = window.devicePixelRatio || 1;
  const renderWidth = Math.max(1, Math.floor(width * devicePixelRatio));
  const renderHeight = Math.max(1, Math.floor(height * devicePixelRatio));

  if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
    canvas.width = renderWidth;
    canvas.height = renderHeight;
  }

  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  const centerY = height / 2;
  context.strokeStyle = "rgba(101, 93, 82, 0.32)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, centerY);
  context.lineTo(width, centerY);
  context.stroke();

  if (!waveform || waveform.peaks.length === 0) {
    context.fillStyle = "rgba(101, 93, 82, 0.45)";
    context.fillRect(Math.max(0, width / 2 - 2), centerY - 18, 4, 36);
    return;
  }

  const usableHeight = Math.max(8, height - 8);
  const barWidth = 2;
  const gap = 1;
  const step = barWidth + gap;
  const barCount = Math.max(1, Math.floor(width / step));

  context.fillStyle = "rgba(15, 74, 37, 0.88)";

  for (let i = 0; i < barCount; i += 1) {
    const x = i * step;
    const peakIndex = Math.floor((i / barCount) * waveform.peaks.length);
    const amplitude = Math.max(0.03, waveform.peaks[peakIndex] ?? 0);
    const barHeight = amplitude * usableHeight;
    const y = centerY - barHeight / 2;
    context.fillRect(x, y, barWidth, barHeight);
  }

}

function drawPlayhead(
  canvas: HTMLCanvasElement,
  playheadProgress: number | null,
): void {
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  const devicePixelRatio = window.devicePixelRatio || 1;
  const renderWidth = Math.max(1, Math.floor(width * devicePixelRatio));
  const renderHeight = Math.max(1, Math.floor(height * devicePixelRatio));

  if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
    canvas.width = renderWidth;
    canvas.height = renderHeight;
  }

  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  if (playheadProgress === null) {
    return;
  }

  const clamped = Math.max(0, Math.min(1, playheadProgress));
  const x = Math.round(clamped * (width - 1)) + 0.5;
  context.strokeStyle = "rgba(22, 101, 52, 0.95)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x, 2);
  context.lineTo(x, height - 2);
  context.stroke();
}

function createRow(
  sample: SampleRecord,
  currentAudioId: string | null,
  selectedSampleId: string | null,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className =
    sample.id === selectedSampleId ? "sample-row is-selected" : "sample-row";
  row.dataset.id = sample.id;

  const name = document.createElement("div");
  name.className = "sample-name";
  name.textContent = sample.name;

  const path = document.createElement("div");
  path.className = "sample-path";
  path.title = sample.relativePath;
  path.textContent = sample.relativePath;

  const category = document.createElement("div");
  const categoryBadge = document.createElement("span");
  categoryBadge.className = "category-badge";
  categoryBadge.textContent = sample.categoryGuess;
  category.append(categoryBadge);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const playButton = document.createElement("button");
  playButton.className =
    sample.id === currentAudioId ? "row-button active" : "row-button";
  playButton.type = "button";
  playButton.dataset.action = "play";
  playButton.dataset.id = sample.id;
  playButton.textContent = sample.id === currentAudioId ? "Stop" : "Play";

  const slotInput = document.createElement("input");
  slotInput.className = "slot-input";
  slotInput.type = "number";
  slotInput.name = "slot-number";
  slotInput.min = "1";
  slotInput.max = "999";
  slotInput.step = "1";
  slotInput.placeholder = "Nr.";
  slotInput.dataset.action = "slot-input";
  slotInput.dataset.id = sample.id;
  slotInput.value = sample.slotNumber === null ? "" : String(sample.slotNumber);

  const assignButton = document.createElement("button");
  assignButton.className =
    sample.slotNumber === null ? "row-button" : "row-button active";
  assignButton.type = "button";
  assignButton.dataset.action = "assign";
  assignButton.dataset.id = sample.id;
  assignButton.textContent = "Setzen";

  actions.append(playButton, slotInput, assignButton);
  row.append(name, path, category, actions);

  return row;
}

export function createUI(root: HTMLElement, handlers: UIHandlers): UIController {
  root.innerHTML = `
    <main class="app-shell">
      <section class="main-column">
        <section class="topbar">
          <div class="headline">
            <h1>Sample Picker</h1>
            <p>
              Lokaler Desktop-MVP fuer schnelles Browsen, Vorhoeren und Merken von
              Kicks, Snares, Hats und anderem Sample-Material.
            </p>
          </div>
          <div class="panel">
            <div class="controls">
              <button type="button" class="primary-button" data-role="pick-directory">
                Ordner auswaehlen
              </button>
              <button type="button" class="secondary-button" data-role="refresh-scan">
                Ordner aktualisieren
              </button>
              <div class="search-wrap">
                <input
                  type="search"
                  placeholder="Suche nach Name oder Pfad"
                  aria-label="Samples durchsuchen"
                  data-role="search"
                />
              </div>
              <label class="filter-toggle">
                <input type="checkbox" data-role="assigned-only" />
                Nur zugewiesene
              </label>
            </div>
          </div>
        </section>

        <div class="statusbar">
          <div data-role="status"></div>
          <div data-role="count"></div>
        </div>

        <div class="error-box" data-role="error" hidden></div>

        <section class="waveform-panel" data-role="waveform-panel">
          <div class="waveform-meta">
            <strong data-role="waveform-title">Kein Sample aktiv</strong>
            <div class="waveform-controls">
              <label class="loop-toggle">
                <input type="checkbox" data-role="loop-toggle" />
                Loop
              </label>
              <span data-role="waveform-duration">Eintrag waehlen, um Waveform zu sehen</span>
            </div>
          </div>
          <div class="waveform-canvas-wrap">
            <canvas
              class="waveform-canvas waveform-canvas-base"
              data-role="waveform-canvas-base"
            ></canvas>
            <canvas
              class="waveform-canvas waveform-canvas-playhead"
              data-role="waveform-canvas-playhead"
            ></canvas>
          </div>
        </section>

        <section class="results">
          <div class="results-header">
            <div>Name</div>
            <div>Pfad</div>
            <div>Kategorie</div>
            <div>Aktionen</div>
          </div>
          <div class="results-body" data-role="results-body"></div>
        </section>
      </section>

      <aside class="slot-panel">
        <div class="slot-panel-header">
          <strong>Nummern-Matrix</strong>
          <span data-role="slot-summary">0 / 999 belegt</span>
        </div>
        <div class="slot-grid" data-role="slot-grid"></div>
      </aside>
    </main>
  `;

  const pickDirectoryButton = root.querySelector<HTMLButtonElement>(
    '[data-role="pick-directory"]',
  );
  const refreshScanButton = root.querySelector<HTMLButtonElement>(
    '[data-role="refresh-scan"]',
  );
  const searchInput = root.querySelector<HTMLInputElement>('[data-role="search"]');
  const assignedOnlyInput = root.querySelector<HTMLInputElement>(
    '[data-role="assigned-only"]',
  );
  const statusElement = root.querySelector<HTMLDivElement>('[data-role="status"]');
  const countElement = root.querySelector<HTMLDivElement>('[data-role="count"]');
  const errorElement = root.querySelector<HTMLDivElement>('[data-role="error"]');
  const waveformPanel = root.querySelector<HTMLElement>(
    '[data-role="waveform-panel"]',
  );
  const waveformTitle = root.querySelector<HTMLElement>(
    '[data-role="waveform-title"]',
  );
  const waveformDuration = root.querySelector<HTMLElement>(
    '[data-role="waveform-duration"]',
  );
  const loopToggleInput = root.querySelector<HTMLInputElement>(
    '[data-role="loop-toggle"]',
  );
  const waveformBaseCanvas = root.querySelector<HTMLCanvasElement>(
    '[data-role="waveform-canvas-base"]',
  );
  const waveformPlayheadCanvas = root.querySelector<HTMLCanvasElement>(
    '[data-role="waveform-canvas-playhead"]',
  );
  const resultsBody = root.querySelector<HTMLDivElement>(
    '[data-role="results-body"]',
  );
  const slotSummary = root.querySelector<HTMLElement>('[data-role="slot-summary"]');
  const slotGrid = root.querySelector<HTMLDivElement>('[data-role="slot-grid"]');

  if (
    !pickDirectoryButton ||
    !refreshScanButton ||
    !searchInput ||
    !assignedOnlyInput ||
    !statusElement ||
    !countElement ||
    !errorElement ||
    !waveformPanel ||
    !waveformTitle ||
    !waveformDuration ||
    !loopToggleInput ||
    !waveformBaseCanvas ||
    !waveformPlayheadCanvas ||
    !resultsBody ||
    !slotSummary ||
    !slotGrid
  ) {
    throw new Error("UI konnte nicht initialisiert werden.");
  }

  const waveformBaseCanvasElement = waveformBaseCanvas;
  const waveformPlayheadCanvasElement = waveformPlayheadCanvas;
  const slotSummaryElement = slotSummary;
  const slotGridElement = slotGrid;
  let latestWaveform: WaveformPreview | null = null;
  let latestSelectedSampleId: string | null = null;
  let latestCurrentAudioId: string | null = null;
  let playheadFrameId: number | null = null;

  function getPlayheadProgress(): number | null {
    if (
      !latestSelectedSampleId ||
      latestCurrentAudioId !== latestSelectedSampleId
    ) {
      return null;
    }

    return handlers.getPlaybackProgress(
      latestSelectedSampleId,
      latestWaveform?.durationSeconds ?? 0,
    );
  }

  function hasActivePlayheadTrack(): boolean {
    return (
      latestSelectedSampleId !== null &&
      latestCurrentAudioId === latestSelectedSampleId
    );
  }

  function stopPlayheadAnimation(): void {
    if (playheadFrameId !== null) {
      window.cancelAnimationFrame(playheadFrameId);
      playheadFrameId = null;
    }
  }

  function renderPlayheadFrame(): void {
    const progress = getPlayheadProgress();
    drawPlayhead(waveformPlayheadCanvasElement, progress);

    if (!hasActivePlayheadTrack()) {
      playheadFrameId = null;
      return;
    }

    playheadFrameId = window.requestAnimationFrame(renderPlayheadFrame);
  }

  function syncPlayheadAnimation(): void {
    if (!hasActivePlayheadTrack()) {
      stopPlayheadAnimation();
      drawPlayhead(waveformPlayheadCanvasElement, null);
      return;
    }

    if (playheadFrameId === null) {
      renderPlayheadFrame();
    }
  }

  function renderSlotMatrix(state: AppState): void {
    const assignedSlots = new Set<number>();

    for (const sample of state.samples) {
      if (sample.slotNumber !== null) {
        assignedSlots.add(sample.slotNumber);
      }
    }

    const selectedSlotNumber =
      state.samples.find((sample) => sample.id === state.selectedSampleId)
        ?.slotNumber ?? null;

    slotSummaryElement.textContent = `${assignedSlots.size} / 999 belegt`;
    slotGridElement.replaceChildren();

    const fragment = document.createDocumentFragment();

    for (let slot = 1; slot <= 999; slot += 1) {
      const cell = document.createElement("div");
      cell.className = "slot-cell";
      cell.textContent = String(slot);

      if (assignedSlots.has(slot)) {
        cell.classList.add("is-assigned");
      }

      if (selectedSlotNumber === slot) {
        cell.classList.add("is-selected");
      }

      fragment.append(cell);
    }

    slotGridElement.append(fragment);
  }

  pickDirectoryButton.addEventListener("click", () => {
    void handlers.onPickDirectory();
  });

  refreshScanButton.addEventListener("click", () => {
    void handlers.onRefreshScan();
  });

  searchInput.addEventListener("input", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    handlers.onSearchChange(target.value);
  });

  assignedOnlyInput.addEventListener("change", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    handlers.onAssignedOnlyChange(target.checked);
  });

  loopToggleInput.addEventListener("change", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    handlers.onLoopEnabledChange(target.checked);
  });

  resultsBody.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-action]");

    if (button) {
      const sampleId = button.dataset.id;

      if (!sampleId) {
        return;
      }

      const action = button.dataset.action;

      if (action === "play") {
        void handlers.onTogglePlay(sampleId);
        return;
      }

      if (action === "assign") {
        const row = button.closest<HTMLDivElement>(".sample-row");
        const slotInput = row?.querySelector<HTMLInputElement>(
          'input[data-action="slot-input"]',
        );
        void handlers.onAssignSlot(sampleId, slotInput?.value ?? "");
      }

      return;
    }

    if (target.closest('input[data-action="slot-input"]')) {
      return;
    }

    const row = target.closest<HTMLDivElement>(".sample-row");

    if (!row?.dataset.id) {
      return;
    }

    handlers.onSelectSample(row.dataset.id);
  });

  resultsBody.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;

    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    if (target.dataset.action !== "slot-input" || event.key !== "Enter") {
      return;
    }

    const sampleId = target.dataset.id;

    if (!sampleId) {
      return;
    }

    event.preventDefault();
    void handlers.onAssignSlot(sampleId, target.value);
  });

  return {
    render(state) {
      pickDirectoryButton.disabled = state.isScanning;
      refreshScanButton.disabled =
        state.isScanning || state.currentDirectoryId === null;
      searchInput.value = state.query;
      assignedOnlyInput.checked = state.showAssignedOnly;
      loopToggleInput.checked = state.loopEnabled;

      statusElement.textContent = formatStatus(state);
      countElement.textContent = formatCount(state.filteredSamples.length);

      if (state.error) {
        errorElement.hidden = false;
        errorElement.textContent = state.error;
      } else {
        errorElement.hidden = true;
        errorElement.textContent = "";
      }

      if (state.currentWaveform) {
        waveformPanel.classList.add("is-active");
        waveformTitle.textContent = state.currentWaveform.sampleName;
        waveformDuration.textContent =
          state.currentWaveform.peaks.length > 0
            ? formatDuration(state.currentWaveform.durationSeconds)
            : "Waveform wird geladen...";
      } else {
        waveformPanel.classList.remove("is-active");
        waveformTitle.textContent = "Kein Sample aktiv";
        waveformDuration.textContent = "Eintrag waehlen, um Waveform zu sehen";
      }

      latestSelectedSampleId = state.selectedSampleId;
      latestCurrentAudioId = state.currentAudioId;
      latestWaveform = state.currentWaveform;
      drawWaveform(waveformBaseCanvasElement, latestWaveform);
      syncPlayheadAnimation();
      renderSlotMatrix(state);

      resultsBody.replaceChildren();

      if (state.filteredSamples.length === 0) {
        const emptyState = document.createElement("div");
        emptyState.className = "empty-state";
        emptyState.textContent = state.currentDirectoryId
          ? "Keine passenden Samples gefunden."
          : "Waehle einen lokalen Sample-Ordner, um den ersten Scan zu starten.";
        resultsBody.append(emptyState);
        return;
      }

      const fragment = document.createDocumentFragment();

      for (const sample of state.filteredSamples) {
        fragment.append(
          createRow(sample, state.currentAudioId, state.selectedSampleId),
        );
      }

      resultsBody.append(fragment);
    },
  };
}
