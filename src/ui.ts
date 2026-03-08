import { isBrowserAudioExtensionSupported } from "./audioSupport";
import { fuzzyMatch, normalizeFuzzyQuery } from "./fuzzy";
import type {
  AppState,
  RandomizerRequest,
  SampleRecord,
  WaveformPreview,
} from "./types";

interface UIHandlers {
  onPickDirectory: () => void | Promise<void>;
  onRefreshScan: () => void | Promise<void>;
  onResetAssignments: () => void | Promise<void>;
  onRunRandomizer: (request: RandomizerRequest) => void | Promise<void>;
  onRandomizerStepRatioChange: (stepRatio: number) => void;
  onExportAssignments: () => void;
  onSelectRandomSample: () => string | null;
  onSelectPreviousSample: () => string | null;
  onSelectNextSample: () => string | null;
  onPlaySelectedSample: () => void | Promise<void>;
  onWriteSelectedSample: () => void | Promise<void>;
  onSearchChange: (query: string) => void;
  onAssignedOnlyChange: (showAssignedOnly: boolean) => void;
  onSlotCounterChange: (slotNumber: number) => void;
  onSlotCounterAdjust: (delta: number) => void;
  onSlotCategoryActivate: (rangeStart: number, rangeEnd: number) => void;
  onLoopEnabledChange: (loopEnabled: boolean) => void;
  onAutoplayEnabledChange: (autoplayEnabled: boolean) => void;
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
const DEFAULT_VISIBLE_PATH_SEGMENTS = 4;
const PATH_MATCH_CONTEXT_CHARACTERS = 24;
const DEFAULT_RANDOMIZER_STEP_RATIO = 0.75;
type ScrollAlignment = "start" | "center";

function clampRandomizerRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_RANDOMIZER_STEP_RATIO;
  }

  return Math.max(0, Math.min(1, value));
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
  context.strokeStyle = "rgba(112, 84, 93, 0.34)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, centerY);
  context.lineTo(width, centerY);
  context.stroke();

  if (!waveform || waveform.peaks.length === 0) {
    context.fillStyle = "rgba(112, 84, 93, 0.46)";
    context.fillRect(Math.max(0, width / 2 - 2), centerY - 18, 4, 36);
    return;
  }

  const usableHeight = Math.max(8, height - 8);
  const barWidth = 2;
  const gap = 1;
  const step = barWidth + gap;
  const barCount = Math.max(1, Math.floor(width / step));

  context.fillStyle = "rgba(110, 16, 47, 0.88)";

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
  context.strokeStyle = "rgba(47, 154, 131, 0.95)";
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
  normalizedQuery: string,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className =
    sample.id === selectedSampleId ? "sample-row is-selected" : "sample-row";
  row.dataset.id = sample.id;

  const name = document.createElement("div");
  name.className = "sample-name";
  name.title = sample.name;
  applyFuzzyHighlight(name, sample.name, normalizedQuery);

  const path = document.createElement("div");
  path.className = "sample-path";
  path.title = sample.relativePath;
  const pathPreview = formatPathPreview(sample.relativePath, normalizedQuery);
  applyFuzzyHighlight(path, pathPreview, normalizedQuery);

  const category = document.createElement("div");
  const categoryBadge = document.createElement("span");
  categoryBadge.className = "category-badge";
  categoryBadge.textContent = sample.categoryGuess;
  category.append(categoryBadge);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const playButton = document.createElement("button");
  const isPlayable = isBrowserAudioExtensionSupported(sample.extension);
  playButton.className =
    sample.id === currentAudioId ? "row-button active" : "row-button";
  playButton.type = "button";
  playButton.dataset.action = "play";
  playButton.dataset.id = sample.id;
  playButton.textContent = sample.id === currentAudioId ? "Stop" : "Play";
  playButton.disabled = !isPlayable;
  playButton.title = isPlayable
    ? ""
    : `Audio-Preview fuer .${sample.extension} wird vom Browser nicht unterstuetzt.`;

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

function applyFuzzyHighlight(
  element: HTMLElement,
  text: string,
  normalizedQuery: string,
): void {
  if (!normalizedQuery || text.length === 0) {
    element.textContent = text;
    return;
  }

  const match = fuzzyMatch(text, normalizedQuery);

  if (!match) {
    element.textContent = text;
    return;
  }

  const fragment = document.createDocumentFragment();
  let textIndex = 0;

  for (const range of match.ranges) {
    if (range.start > textIndex) {
      fragment.append(document.createTextNode(text.slice(textIndex, range.start)));
    }

    const highlight = document.createElement("span");
    highlight.className = "fuzzy-hit";
    highlight.textContent = text.slice(range.start, range.end);
    fragment.append(highlight);
    textIndex = range.end;
  }

  if (textIndex < text.length) {
    fragment.append(document.createTextNode(text.slice(textIndex)));
  }

  element.replaceChildren(fragment);
}

function buildDefaultPathPreview(normalizedPath: string): string {
  const segments = normalizedPath
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return normalizedPath;
  }

  if (segments.length <= DEFAULT_VISIBLE_PATH_SEGMENTS) {
    return segments.join("/");
  }

  return `.../${segments.slice(-DEFAULT_VISIBLE_PATH_SEGMENTS).join("/")}`;
}

function formatPathPreview(relativePath: string, normalizedQuery: string): string {
  const normalizedPath = relativePath.replace(/\\/g, "/");

  if (!normalizedQuery) {
    return buildDefaultPathPreview(normalizedPath);
  }

  const match = fuzzyMatch(normalizedPath, normalizedQuery);

  if (!match || match.ranges.length === 0) {
    return buildDefaultPathPreview(normalizedPath);
  }

  const firstMatch = match.ranges[0];
  const previewStart = Math.max(
    0,
    firstMatch.start - PATH_MATCH_CONTEXT_CHARACTERS,
  );
  const previewEnd = Math.min(
    normalizedPath.length,
    firstMatch.end + PATH_MATCH_CONTEXT_CHARACTERS,
  );

  let preview = normalizedPath.slice(previewStart, previewEnd);

  if (previewStart > 0) {
    preview = `...${preview}`;
  }

  if (previewEnd < normalizedPath.length) {
    preview = `${preview}...`;
  }

  return preview;
}

export function createUI(root: HTMLElement, handlers: UIHandlers): UIController {
  root.innerHTML = `
    <main class="app-shell">
      <section class="main-column">
        <section class="topbar">
          <div class="headline">
            <h1>Sample Picker</h1>
            <button
              type="button"
              class="secondary-button headline-export-button"
              data-role="export-assignments"
            >
              Export
            </button>
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
            <div class="randomizer-controls">
              <button
                type="button"
                class="secondary-button randomizer-run-button"
                data-role="run-randomizer"
                title="Setzt alle Zuweisungen zurueck und belegt je Kategorie die ersten 50 Slots."
              >
                Randomizer
              </button>
              <label class="randomizer-ratio">
                <span>Step Ratio</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value="75"
                  data-role="randomizer-ratio-range"
                />
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value="75"
                  data-role="randomizer-ratio-number"
                  aria-label="Randomizer Step Ratio in Prozent"
                />
              </label>
              <span class="randomizer-hint">
                0% = harte Spruenge, 100% = lokale Schritte.
              </span>
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
            <div class="results-toolbar-main-actions">
              <button
                type="button"
                class="toolbar-main-button"
                data-role="random-sample"
                title="Zufaelliges Sample aus aktueller Trefferliste auswaehlen (A)"
              >
                <span class="toolbar-main-button-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path
                      d="M4 7h3l2.6 3.2M4 17h3l2.6-3.2M14.5 7H20m0 0-2.2-2.2M20 7l-2.2 2.2M14.5 17H20m0 0-2.2-2.2M20 17l-2.2 2.2"
                    />
                  </svg>
                </span>
                <span>Random Pick</span>
              </button>
              <div class="toolbar-nav-stack">
                <button
                  type="button"
                  class="toolbar-main-button is-nav"
                  data-role="previous-selected"
                  title="Vorherigen Eintrag auswaehlen (W)"
                >
                  <span class="toolbar-main-button-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M12 5v14M6.5 10.5 12 5l5.5 5.5" />
                    </svg>
                  </span>
                  <span>Previous</span>
                </button>
                <button
                  type="button"
                  class="toolbar-main-button is-play-main"
                  data-role="play-selected"
                  title="Ausgewaehltes Sample einmal abspielen (S)"
                >
                  <span class="toolbar-main-button-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path class="is-solid" d="M8 6v12l10-6z" />
                    </svg>
                  </span>
                  <span>Play</span>
                </button>
                <button
                  type="button"
                  class="toolbar-main-button is-nav"
                  data-role="next-selected"
                  title="Naechsten Eintrag auswaehlen (X)"
                >
                  <span class="toolbar-main-button-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M12 19V5m5.5 8.5L12 19l-5.5-5.5" />
                    </svg>
                  </span>
                  <span>Next</span>
                </button>
              </div>
              <button
                type="button"
                class="toolbar-main-button is-write"
                data-role="write-selected"
                title="Ausgewaehltes Sample auf den aktuellen Counter schreiben (D)"
              >
                <span class="toolbar-main-button-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path
                      d="M6 5h9l3 3v11H6zM15 5v4h4M9 14h6M9 17h6M9 11h3"
                    />
                  </svg>
                </span>
                <span>Write</span>
              </button>
              <label class="toolbar-toggle">
                <input type="checkbox" data-role="autoplay-toggle" />
                <span>Autoplay</span>
              </label>
            </div>
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
        <div class="slot-panel-layout">
          <div class="slot-categories" data-role="slot-categories"></div>
          <div class="slot-counter-rail" data-role="slot-counter-rail">
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
        </div>
      </aside>
    </main>
  `;

  const pickDirectoryButton = root.querySelector<HTMLButtonElement>(
    '[data-role="pick-directory"]',
  );
  const exportAssignmentsButton = root.querySelector<HTMLButtonElement>(
    '[data-role="export-assignments"]',
  );
  const refreshScanButton = root.querySelector<HTMLButtonElement>(
    '[data-role="refresh-scan"]',
  );
  const resetAssignmentsButton = root.querySelector<HTMLButtonElement>(
    '[data-role="reset-assignments"]',
  );
  const randomSampleButton = root.querySelector<HTMLButtonElement>(
    '[data-role="random-sample"]',
  );
  const previousSelectedButton = root.querySelector<HTMLButtonElement>(
    '[data-role="previous-selected"]',
  );
  const playSelectedButton = root.querySelector<HTMLButtonElement>(
    '[data-role="play-selected"]',
  );
  const nextSelectedButton = root.querySelector<HTMLButtonElement>(
    '[data-role="next-selected"]',
  );
  const writeSelectedButton = root.querySelector<HTMLButtonElement>(
    '[data-role="write-selected"]',
  );
  const autoplayToggleInput = root.querySelector<HTMLInputElement>(
    '[data-role="autoplay-toggle"]',
  );
  const randomizerRunButton = root.querySelector<HTMLButtonElement>(
    '[data-role="run-randomizer"]',
  );
  const randomizerRatioRangeInput = root.querySelector<HTMLInputElement>(
    '[data-role="randomizer-ratio-range"]',
  );
  const randomizerRatioNumberInput = root.querySelector<HTMLInputElement>(
    '[data-role="randomizer-ratio-number"]',
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
  const slotCounterRail = root.querySelector<HTMLDivElement>(
    '[data-role="slot-counter-rail"]',
  );
  const slotCategories = root.querySelector<HTMLDivElement>(
    '[data-role="slot-categories"]',
  );

  if (
    !pickDirectoryButton ||
    !exportAssignmentsButton ||
    !refreshScanButton ||
    !resetAssignmentsButton ||
    !randomSampleButton ||
    !previousSelectedButton ||
    !playSelectedButton ||
    !nextSelectedButton ||
    !writeSelectedButton ||
    !autoplayToggleInput ||
    !randomizerRunButton ||
    !randomizerRatioRangeInput ||
    !randomizerRatioNumberInput ||
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
    !slotCounterRail ||
    !slotCategories
  ) {
    throw new Error("UI konnte nicht initialisiert werden.");
  }

  const waveformBaseCanvasElement = waveformBaseCanvas;
  const waveformPlayheadCanvasElement = waveformPlayheadCanvas;
  const resultsBodyElement = resultsBody;
  const slotCategoriesElement = slotCategories;
  const slotCounterRailElement = slotCounterRail;
  const slotCounterInputElement = slotCounterInput;
  const searchInputElement = searchInput;
  const exportAssignmentsButtonElement = exportAssignmentsButton;
  const randomizerRunButtonElement = randomizerRunButton;
  const randomizerRatioRangeInputElement = randomizerRatioRangeInput;
  const randomizerRatioNumberInputElement = randomizerRatioNumberInput;
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
  let virtualNormalizedQuery = "";
  let virtualRowHeight = DEFAULT_VIRTUAL_ROW_HEIGHT;
  let virtualListMounted = false;
  let virtualRenderFrameId: number | null = null;
  let virtualForceRenderRequested = false;
  let pendingCategoryFirstResultScroll = false;
  let lastVirtualStartIndex = -1;
  let lastVirtualEndIndex = -1;
  let lastVirtualTotalCount = -1;
  let lastVirtualSelectedSampleId: string | null = null;
  let lastVirtualCurrentAudioId: string | null = null;

  function syncRandomizerRatioInputs(percentValue: number): void {
    const normalizedPercent = Number.isFinite(percentValue)
      ? percentValue
      : DEFAULT_RANDOMIZER_STEP_RATIO * 100;
    const clampedPercent = Math.max(0, Math.min(100, Math.round(normalizedPercent)));
    const nextValue = String(clampedPercent);
    randomizerRatioRangeInputElement.value = nextValue;
    randomizerRatioNumberInputElement.value = nextValue;
  }

  function getRandomizerRequest(): RandomizerRequest {
    const ratio = getRandomizerStepRatioFromInputs();

    return {
      stepRatio: ratio,
      categories: slotCategoryElements.map((entry) => ({
        rangeStart: entry.definition.start,
        rangeEnd: entry.definition.end,
        query: entry.input.value.trim(),
      })),
    };
  }

  function getRandomizerStepRatioFromInputs(): number {
    const parsedRatioPercent = Number.parseFloat(
      randomizerRatioNumberInputElement.value,
    );
    return clampRandomizerRatio(
      Number.isFinite(parsedRatioPercent)
        ? parsedRatioPercent / 100
        : DEFAULT_RANDOMIZER_STEP_RATIO,
    );
  }

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
        createRow(
          sample,
          virtualCurrentAudioId,
          virtualSelectedSampleId,
          virtualNormalizedQuery,
        ),
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

  function scrollSampleInResults(
    sampleId: string,
    alignment: ScrollAlignment,
  ): boolean {
    if (!virtualListMounted || virtualSamples.length === 0) {
      return false;
    }

    const targetIndex = virtualSamples.findIndex((sample) => sample.id === sampleId);

    if (targetIndex < 0) {
      return false;
    }

    const rowHeight = readVirtualRowHeight();
    const viewportHeight = Math.max(rowHeight, resultsBodyElement.clientHeight);
    const totalHeight = virtualSamples.length * rowHeight;
    const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
    const targetScrollTop =
      alignment === "center"
        ? targetIndex * rowHeight - (viewportHeight - rowHeight) / 2
        : targetIndex * rowHeight;
    const clampedScrollTop = Math.max(
      0,
      Math.min(maxScrollTop, targetScrollTop),
    );

    resultsBodyElement.scrollTop = Math.round(clampedScrollTop);
    invalidateVirtualWindow();
    scheduleVirtualRowsRender(true);
    return true;
  }

  function selectAndCenter(
    selectionHandler: () => string | null,
    alignment: ScrollAlignment,
  ): void {
    const sampleId = selectionHandler();

    if (!sampleId) {
      return;
    }

    if (scrollSampleInResults(sampleId, alignment)) {
      return;
    }

    window.requestAnimationFrame(() => {
      scrollSampleInResults(sampleId, alignment);
    });
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    if (target.isContentEditable) {
      return true;
    }

    const tagName = target.tagName;

    return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
  }

  function triggerToolbarButton(button: HTMLButtonElement): boolean {
    if (button.disabled) {
      return false;
    }

    button.click();
    return true;
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

        pendingCategoryFirstResultScroll = true;
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

  function syncSlotCounterPosition(): void {
    const railRect = slotCounterRailElement.getBoundingClientRect();
    const inputHeight = slotCounterInputElement.offsetHeight;

    if (inputHeight <= 0 || railRect.height <= 0) {
      slotCounterInputElement.style.setProperty("--slot-counter-offset", "0px");
      return;
    }

    const activePixel = slotCategoriesElement.querySelector<HTMLElement>(
      ".slot-pixel.is-counter",
    );
    const fallbackCategory = slotCategoriesElement.querySelector<HTMLElement>(
      ".slot-category",
    );
    const targetElement = activePixel ?? fallbackCategory;

    if (!targetElement) {
      slotCounterInputElement.style.setProperty("--slot-counter-offset", "0px");
      return;
    }

    const targetRect = targetElement.getBoundingClientRect();
    const unclampedOffset =
      targetRect.top - railRect.top + targetRect.height / 2 - inputHeight / 2;
    const maxOffset = Math.max(0, railRect.height - inputHeight);
    const clampedOffset = Math.max(0, Math.min(maxOffset, unclampedOffset));

    slotCounterInputElement.style.setProperty(
      "--slot-counter-offset",
      `${Math.round(clampedOffset)}px`,
    );
  }

  createSlotCategoryElements();
  syncRandomizerRatioInputs(DEFAULT_RANDOMIZER_STEP_RATIO * 100);

  pickDirectoryButton.addEventListener("click", () => {
    void handlers.onPickDirectory();
  });

  exportAssignmentsButtonElement.addEventListener("click", () => {
    handlers.onExportAssignments();
  });

  refreshScanButton.addEventListener("click", () => {
    void handlers.onRefreshScan();
  });

  randomizerRunButtonElement.addEventListener("click", () => {
    const shouldRun = window.confirm(
      "Randomizer startet neu: Alle aktuellen Zuweisungen werden geloescht. Fortfahren?",
    );

    if (!shouldRun) {
      return;
    }

    void handlers.onRunRandomizer(getRandomizerRequest());
  });

  randomizerRatioRangeInputElement.addEventListener("input", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    syncRandomizerRatioInputs(Number.parseInt(target.value, 10));
    handlers.onRandomizerStepRatioChange(getRandomizerStepRatioFromInputs());
  });

  randomizerRatioNumberInputElement.addEventListener("input", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    syncRandomizerRatioInputs(Number.parseInt(target.value, 10));
    handlers.onRandomizerStepRatioChange(getRandomizerStepRatioFromInputs());
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

  randomSampleButton.addEventListener("click", () => {
    selectAndCenter(handlers.onSelectRandomSample, "center");
  });

  previousSelectedButton.addEventListener("click", () => {
    selectAndCenter(handlers.onSelectPreviousSample, "center");
  });

  playSelectedButton.addEventListener("click", () => {
    void handlers.onPlaySelectedSample();
  });

  nextSelectedButton.addEventListener("click", () => {
    selectAndCenter(handlers.onSelectNextSample, "center");
  });

  writeSelectedButton.addEventListener("click", () => {
    void handlers.onWriteSelectedSample();
  });

  autoplayToggleInput.addEventListener("change", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    handlers.onAutoplayEnabledChange(target.checked);
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

  window.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isEditableTarget(event.target)
    ) {
      return;
    }

    const key = event.key.toLowerCase();
    let handled = false;

    if (key === "a") {
      handled = triggerToolbarButton(randomSampleButton);
    } else if (key === "w") {
      handled = triggerToolbarButton(previousSelectedButton);
    } else if (key === "s") {
      handled = triggerToolbarButton(playSelectedButton);
    } else if (key === "x") {
      handled = triggerToolbarButton(nextSelectedButton);
    } else if (key === "d") {
      handled = triggerToolbarButton(writeSelectedButton);
    }

    if (handled) {
      event.preventDefault();
    }
  });

  resultsBodyElement.addEventListener("scroll", () => {
    if (!virtualListMounted || virtualSamples.length === 0) {
      return;
    }

    scheduleVirtualRowsRender();
  });

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      syncSlotCounterPosition();

      if (!virtualListMounted || virtualSamples.length === 0) {
        return;
      }

      invalidateVirtualWindow();
      scheduleVirtualRowsRender(true);
    });

    resizeObserver.observe(resultsBodyElement);
    resizeObserver.observe(slotCategoriesElement);
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
      const hasAssignments = state.samples.some(
        (sample) => sample.slotNumber !== null,
      );
      pickDirectoryButton.disabled = state.isScanning;
      refreshScanButton.disabled =
        state.isScanning || state.currentDirectoryId === null;
      exportAssignmentsButtonElement.disabled =
        state.isScanning || state.currentDirectoryId === null || !hasAssignments;
      randomizerRunButtonElement.disabled =
        state.isScanning ||
        state.currentDirectoryId === null ||
        state.samples.length === 0;
      randomizerRatioRangeInputElement.disabled = randomizerRunButtonElement.disabled;
      randomizerRatioNumberInputElement.disabled = randomizerRunButtonElement.disabled;
      resetAssignmentsButton.disabled =
        state.isScanning ||
        state.currentDirectoryId === null ||
        !hasAssignments;
      randomSampleButton.disabled =
        state.isScanning ||
        state.currentDirectoryId === null ||
        state.filteredSamples.length === 0;
      previousSelectedButton.disabled =
        state.isScanning ||
        state.currentDirectoryId === null ||
        state.filteredSamples.length === 0;
      nextSelectedButton.disabled =
        state.isScanning ||
        state.currentDirectoryId === null ||
        state.filteredSamples.length === 0;

      const selectedSample =
        state.selectedSampleId === null
          ? null
          : state.samples.find((sample) => sample.id === state.selectedSampleId) ?? null;
      const canUseSelectedSampleActions =
        !state.isScanning &&
        state.currentDirectoryId !== null &&
        selectedSample !== null;
      playSelectedButton.disabled =
        !canUseSelectedSampleActions ||
        selectedSample === null ||
        !isBrowserAudioExtensionSupported(selectedSample.extension);
      writeSelectedButton.disabled = !canUseSelectedSampleActions;

      searchInput.value = state.query;
      assignedOnlyInput.checked = state.showAssignedOnly;
      syncRandomizerRatioInputs(state.randomizerStepRatio * 100);
      slotCounterInputElement.value = String(state.slotCounter);
      loopToggleInput.checked = state.loopEnabled;
      autoplayToggleInput.checked = state.autoplayEnabled;

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
      syncSlotCounterPosition();

      if (state.filteredSamples.length === 0) {
        pendingCategoryFirstResultScroll = false;
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
      virtualNormalizedQuery = normalizeFuzzyQuery(state.query);
      ensureVirtualListMounted();

      if (pendingCategoryFirstResultScroll) {
        pendingCategoryFirstResultScroll = false;
        const firstSampleId = state.filteredSamples[0]?.id ?? null;

        if (firstSampleId) {
          if (!scrollSampleInResults(firstSampleId, "start")) {
            window.requestAnimationFrame(() => {
              scrollSampleInResults(firstSampleId, "start");
            });
          }
        }
      }

      scheduleVirtualRowsRender(true);
    },
  };
}
