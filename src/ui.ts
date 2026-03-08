import type { AppState, SampleRecord, WaveformPreview } from "./types";

interface UIHandlers {
  onPickDirectory: () => void | Promise<void>;
  onRefreshScan: () => void | Promise<void>;
  onResetAssignments: () => void | Promise<void>;
  onSearchChange: (query: string) => void;
  onAssignedOnlyChange: (showAssignedOnly: boolean) => void;
  onSlotCounterChange: (slotNumber: number) => void;
  onSlotCounterAdjust: (delta: number) => void;
  onSlotCategoryActivate: (rangeStart: number, rangeEnd: number) => void;
  onLoopEnabledChange: (loopEnabled: boolean) => void;
  getPlaybackProgress: (
    sampleId: string,
    fallbackDurationSeconds: number,
  ) => number | null;
  onSelectSample: (sampleId: string) => void;
  onWriteSample: (sampleId: string) => void | Promise<void>;
  onTogglePlay: (sampleId: string) => void | Promise<void>;
}

interface UIController {
  render: (state: AppState) => void;
}

interface SlotCategoryDefinition {
  key: string;
  label: string;
  start: number;
  end: number;
}

interface SlotCategoryElements {
  definition: SlotCategoryDefinition;
  input: HTMLInputElement;
  cells: HTMLDivElement[];
}

const SLOT_CATEGORY_DEFINITIONS: SlotCategoryDefinition[] = [
  { key: "kicks", label: "Kicks", start: 1, end: 99 },
  { key: "snares", label: "Snares", start: 100, end: 199 },
  { key: "cymbals", label: "Cymbals", start: 200, end: 299 },
  { key: "perc", label: "Perc", start: 300, end: 399 },
  { key: "bass", label: "Bass", start: 400, end: 499 },
  { key: "leads", label: "Leads", start: 500, end: 599 },
  { key: "skanks", label: "Skanks", start: 600, end: 699 },
  { key: "voxfx", label: "Vox & Fx", start: 700, end: 799 },
  { key: "loops", label: "Loops", start: 800, end: 899 },
  { key: "user", label: "User", start: 900, end: 999 },
];

const DEFAULT_VIRTUAL_ROW_HEIGHT = 72;
const VIRTUAL_OVERSCAN_ROWS = 8;

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
  path.textContent = formatPathPreview(sample.relativePath);

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

  const slotIndicator = document.createElement("span");
  slotIndicator.className = "slot-indicator";
  slotIndicator.textContent =
    sample.slotNumber === null ? "Nr. -" : `Nr. ${sample.slotNumber}`;

  const writeButton = document.createElement("button");
  writeButton.className = "row-button write-button";
  writeButton.type = "button";
  writeButton.dataset.action = "write";
  writeButton.dataset.id = sample.id;
  writeButton.textContent = "Write";

  actions.append(playButton, slotIndicator, writeButton);
  row.append(name, path, category, actions);

  return row;
}

function formatPathPreview(relativePath: string): string {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const segments = normalizedPath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return relativePath;
  }

  const directories = segments.length > 1 ? segments.slice(0, -1) : segments;
  const visibleDirectories = directories.slice(0, 3);

  if (visibleDirectories.length === 0) {
    return "/";
  }

  const suffix = directories.length > visibleDirectories.length ? "/..." : "";
  return `${visibleDirectories.join("/")}${suffix}`;
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
          <div class="results-toolbar">
            <button
              type="button"
              class="danger-button"
              data-role="reset-assignments"
            >
              Alle Zuweisungen zuruecksetzen
            </button>
          </div>
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
        <div class="slot-panel-head">
          <span class="slot-counter-label">Writehead</span>
          <input
            type="number"
            min="1"
            max="999"
            step="1"
            class="slot-counter-input"
            data-role="slot-counter"
            aria-label="Writehead Counter"
          />
        </div>
        <div class="slot-categories" data-role="slot-categories"></div>
      </aside>
    </main>
  `;

  const pickDirectoryButton = root.querySelector<HTMLButtonElement>(
    '[data-role="pick-directory"]',
  );
  const refreshScanButton = root.querySelector<HTMLButtonElement>(
    '[data-role="refresh-scan"]',
  );
  const resetAssignmentsButton = root.querySelector<HTMLButtonElement>(
    '[data-role="reset-assignments"]',
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
  const slotCounterInput = root.querySelector<HTMLInputElement>(
    '[data-role="slot-counter"]',
  );
  const slotCategories = root.querySelector<HTMLDivElement>(
    '[data-role="slot-categories"]',
  );

  if (
    !pickDirectoryButton ||
    !refreshScanButton ||
    !resetAssignmentsButton ||
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
    !slotCounterInput ||
    !slotCategories
  ) {
    throw new Error("UI konnte nicht initialisiert werden.");
  }

  const waveformBaseCanvasElement = waveformBaseCanvas;
  const waveformPlayheadCanvasElement = waveformPlayheadCanvas;
  const resultsBodyElement = resultsBody;
  const slotCategoriesElement = slotCategories;
  const slotCounterInputElement = slotCounterInput;
  const searchInputElement = searchInput;
  const slotCategoryElements: SlotCategoryElements[] = [];
  let latestWaveform: WaveformPreview | null = null;
  let latestSelectedSampleId: string | null = null;
  let latestCurrentAudioId: string | null = null;
  let playheadFrameId: number | null = null;
  const virtualTopSpacer = document.createElement("div");
  virtualTopSpacer.className = "results-virtual-spacer";
  const virtualRows = document.createElement("div");
  virtualRows.className = "results-virtual-rows";
  const virtualBottomSpacer = document.createElement("div");
  virtualBottomSpacer.className = "results-virtual-spacer";
  let virtualSamples: SampleRecord[] = [];
  let virtualSelectedSampleId: string | null = null;
  let virtualCurrentAudioId: string | null = null;
  let virtualRowHeight = DEFAULT_VIRTUAL_ROW_HEIGHT;
  let virtualListMounted = false;
  let virtualRenderFrameId: number | null = null;
  let virtualForceRenderRequested = false;
  let lastVirtualStartIndex = -1;
  let lastVirtualEndIndex = -1;
  let lastVirtualTotalCount = -1;
  let lastVirtualSelectedSampleId: string | null = null;
  let lastVirtualCurrentAudioId: string | null = null;

  function readVirtualRowHeight(): number {
    const value = Number.parseFloat(
      window
        .getComputedStyle(resultsBodyElement)
        .getPropertyValue("--results-row-height"),
    );

    if (Number.isFinite(value) && value >= 24) {
      return value;
    }

    return DEFAULT_VIRTUAL_ROW_HEIGHT;
  }

  function clearVirtualRenderFrame(): void {
    if (virtualRenderFrameId !== null) {
      window.cancelAnimationFrame(virtualRenderFrameId);
      virtualRenderFrameId = null;
    }

    virtualForceRenderRequested = false;
  }

  function invalidateVirtualWindow(): void {
    lastVirtualStartIndex = -1;
    lastVirtualEndIndex = -1;
    lastVirtualTotalCount = -1;
    lastVirtualSelectedSampleId = null;
    lastVirtualCurrentAudioId = null;
  }

  function ensureVirtualListMounted(): void {
    if (virtualListMounted) {
      return;
    }

    resultsBodyElement.replaceChildren(
      virtualTopSpacer,
      virtualRows,
      virtualBottomSpacer,
    );
    virtualListMounted = true;
  }

  function renderVirtualRows(force = false): void {
    if (!virtualListMounted) {
      return;
    }

    const totalCount = virtualSamples.length;

    if (totalCount === 0) {
      virtualTopSpacer.style.height = "0px";
      virtualBottomSpacer.style.height = "0px";
      virtualRows.replaceChildren();
      invalidateVirtualWindow();
      return;
    }

    virtualRowHeight = readVirtualRowHeight();
    const viewportHeight = Math.max(virtualRowHeight, resultsBodyElement.clientHeight);
    const scrollTop = Math.max(0, resultsBodyElement.scrollTop);
    const visibleCount = Math.max(1, Math.ceil(viewportHeight / virtualRowHeight));
    const startIndex = Math.max(
      0,
      Math.floor(scrollTop / virtualRowHeight) - VIRTUAL_OVERSCAN_ROWS,
    );
    const endIndex = Math.min(
      totalCount,
      startIndex + visibleCount + VIRTUAL_OVERSCAN_ROWS * 2,
    );

    if (
      !force &&
      startIndex === lastVirtualStartIndex &&
      endIndex === lastVirtualEndIndex &&
      totalCount === lastVirtualTotalCount &&
      virtualSelectedSampleId === lastVirtualSelectedSampleId &&
      virtualCurrentAudioId === lastVirtualCurrentAudioId
    ) {
      return;
    }

    lastVirtualStartIndex = startIndex;
    lastVirtualEndIndex = endIndex;
    lastVirtualTotalCount = totalCount;
    lastVirtualSelectedSampleId = virtualSelectedSampleId;
    lastVirtualCurrentAudioId = virtualCurrentAudioId;

    virtualTopSpacer.style.height = `${startIndex * virtualRowHeight}px`;
    virtualBottomSpacer.style.height = `${Math.max(
      0,
      (totalCount - endIndex) * virtualRowHeight,
    )}px`;

    const fragment = document.createDocumentFragment();

    for (let index = startIndex; index < endIndex; index += 1) {
      const sample = virtualSamples[index];

      if (!sample) {
        continue;
      }

      fragment.append(
        createRow(sample, virtualCurrentAudioId, virtualSelectedSampleId),
      );
    }

    virtualRows.replaceChildren(fragment);
  }

  function scheduleVirtualRowsRender(force = false): void {
    if (force) {
      virtualForceRenderRequested = true;
    }

    if (virtualRenderFrameId !== null) {
      return;
    }

    virtualRenderFrameId = window.requestAnimationFrame(() => {
      const shouldForce = virtualForceRenderRequested;
      virtualRenderFrameId = null;
      virtualForceRenderRequested = false;
      renderVirtualRows(shouldForce);
    });
  }

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

  function createSlotCategoryElements(): void {
    slotCategoriesElement.replaceChildren();
    slotCategoryElements.length = 0;

    const fragment = document.createDocumentFragment();

    const triggerSearch = (query: string): void => {
      searchInputElement.value = query;
      searchInputElement.dispatchEvent(new Event("input", { bubbles: true }));
    };

    for (const definition of SLOT_CATEGORY_DEFINITIONS) {
      const categoryElement = document.createElement("section");
      categoryElement.className = "slot-category";

      const metaElement = document.createElement("div");
      metaElement.className = "slot-category-meta";
      const rangeElement = document.createElement("span");
      rangeElement.className = "slot-category-range";
      rangeElement.textContent = `${definition.start} - ${definition.end}`;

      const inputElement = document.createElement("input");
      inputElement.className = "slot-category-input";
      inputElement.type = "text";
      inputElement.name = `slot-category-${definition.key}`;
      inputElement.value = definition.label;

      const pixelsElement = document.createElement("div");
      pixelsElement.className = "slot-category-pixels";

      const cells: HTMLDivElement[] = [];

      for (let index = 0; index < 100; index += 1) {
        const pixelElement = document.createElement("div");
        pixelElement.className = "slot-pixel";

        const slotNumber = definition.start + index;

        if (slotNumber <= definition.end) {
          pixelElement.dataset.slotNumber = String(slotNumber);
        } else {
          pixelElement.classList.add("is-empty");
        }

        cells.push(pixelElement);
        pixelsElement.append(pixelElement);
      }

      metaElement.append(inputElement, rangeElement);
      categoryElement.append(metaElement, pixelsElement);
      categoryElement.addEventListener("click", (event) => {
        const target = event.target as HTMLElement;

        if (target.closest(".slot-category-input")) {
          return;
        }

        triggerSearch(inputElement.value);
        handlers.onSlotCategoryActivate(definition.start, definition.end);
      });
      fragment.append(categoryElement);
      slotCategoryElements.push({
        definition,
        input: inputElement,
        cells,
      });
    }

    slotCategoriesElement.append(fragment);
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

    for (const category of slotCategoryElements) {
      for (const cell of category.cells) {
        const slotNumber = Number.parseInt(cell.dataset.slotNumber ?? "", 10);

        if (!Number.isInteger(slotNumber)) {
          cell.classList.remove("is-assigned", "is-selected", "is-counter");
          continue;
        }

        cell.classList.toggle("is-assigned", assignedSlots.has(slotNumber));
        cell.classList.toggle("is-selected", selectedSlotNumber === slotNumber);
        cell.classList.toggle("is-counter", state.slotCounter === slotNumber);
      }
    }
  }

  createSlotCategoryElements();

  pickDirectoryButton.addEventListener("click", () => {
    void handlers.onPickDirectory();
  });

  refreshScanButton.addEventListener("click", () => {
    void handlers.onRefreshScan();
  });

  resetAssignmentsButton.addEventListener("click", () => {
    const shouldReset = window.confirm(
      "Alle Zuweisungen wirklich zuruecksetzen? Dieser Schritt kann nicht rueckgaengig gemacht werden.",
    );

    if (!shouldReset) {
      return;
    }

    void handlers.onResetAssignments();
  });

  searchInput.addEventListener("input", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    handlers.onSearchChange(target.value);
  });

  assignedOnlyInput.addEventListener("change", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    handlers.onAssignedOnlyChange(target.checked);
  });

  slotCounterInputElement.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();

      if (event.deltaY === 0) {
        return;
      }

      handlers.onSlotCounterAdjust(event.deltaY > 0 ? 1 : -1);
    },
    { passive: false },
  );

  slotCounterInputElement.addEventListener("input", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    const parsed = Number.parseInt(target.value, 10);

    if (!Number.isInteger(parsed)) {
      return;
    }

    handlers.onSlotCounterChange(parsed);
  });

  loopToggleInput.addEventListener("change", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    handlers.onLoopEnabledChange(target.checked);
  });

  resultsBodyElement.addEventListener("scroll", () => {
    if (!virtualListMounted || virtualSamples.length === 0) {
      return;
    }

    scheduleVirtualRowsRender();
  });

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      if (!virtualListMounted || virtualSamples.length === 0) {
        return;
      }

      invalidateVirtualWindow();
      scheduleVirtualRowsRender(true);
    });

    resizeObserver.observe(resultsBodyElement);
  }

  resultsBodyElement.addEventListener("click", (event) => {
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

      if (action === "write") {
        void handlers.onWriteSample(sampleId);
      }

      return;
    }

    const row = target.closest<HTMLDivElement>(".sample-row");

    if (!row?.dataset.id) {
      return;
    }

    handlers.onSelectSample(row.dataset.id);
  });

  return {
    render(state) {
      pickDirectoryButton.disabled = state.isScanning;
      refreshScanButton.disabled =
        state.isScanning || state.currentDirectoryId === null;
      resetAssignmentsButton.disabled =
        state.isScanning ||
        state.currentDirectoryId === null ||
        !state.samples.some((sample) => sample.slotNumber !== null);
      searchInput.value = state.query;
      assignedOnlyInput.checked = state.showAssignedOnly;
      slotCounterInputElement.value = String(state.slotCounter);
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

      if (state.filteredSamples.length === 0) {
        clearVirtualRenderFrame();
        invalidateVirtualWindow();
        virtualSamples = [];
        virtualSelectedSampleId = null;
        virtualCurrentAudioId = null;
        virtualTopSpacer.style.height = "0px";
        virtualBottomSpacer.style.height = "0px";
        virtualRows.replaceChildren();
        virtualListMounted = false;
        const emptyState = document.createElement("div");
        emptyState.className = "empty-state";
        emptyState.textContent = state.currentDirectoryId
          ? "Keine passenden Samples gefunden."
          : "Waehle einen lokalen Sample-Ordner, um den ersten Scan zu starten.";
        resultsBodyElement.replaceChildren(emptyState);
        return;
      }

      virtualSamples = state.filteredSamples;
      virtualSelectedSampleId = state.selectedSampleId;
      virtualCurrentAudioId = state.currentAudioId;
      ensureVirtualListMounted();
      scheduleVirtualRowsRender(true);
    },
  };
}
