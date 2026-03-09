import { isBrowserAudioExtensionSupported } from "./audioSupport";
import {
  fuzzyMatch,
  mergeFuzzyRanges,
  normalizeFuzzyQuery,
  splitNormalizedFuzzyQuery,
} from "./fuzzy";
import type {
  AppState,
  ExportAssignmentsRequest,
  RandomizerRequest,
  ScanProgress,
  SampleRecord,
  WaveformPreview,
} from "./types";

interface UIHandlers {
  onPickDirectory: () => void | Promise<void>;
  onRefreshScan: () => void | Promise<void>;
  onResetAssignments: () => void | Promise<void>;
  onRunRandomizer: (request: RandomizerRequest) => void | Promise<void>;
  onRandomizerStepRatioChange: (stepRatio: number) => void;
  onExportAssignments: (request: ExportAssignmentsRequest) => void | Promise<void>;
  onSelectRandomSample: () => string | null;
  onSelectPreviousSample: () => string | null;
  onSelectNextSample: () => string | null;
  onPlaySelectedSample: () => void | Promise<void>;
  onWriteSelectedSample: () => void | Promise<void>;
  onRemoveSelectedSample: () => void | Promise<void>;
  onSearchChange: (query: string) => void;
  onAssignedOnlyChange: (showAssignedOnly: boolean) => void;
  onSlotCategoryActivate: (rangeStart: number, rangeEnd: number) => void;
  onLoopEnabledChange: (loopEnabled: boolean) => void;
  onAutoplayEnabledChange: (autoplayEnabled: boolean) => void;
  getPlaybackProgress: (
    sampleId: string,
    fallbackDurationSeconds: number,
  ) => number | null;
  onSelectSample: (sampleId: string) => void;
  onWriteSample: (sampleId: string) => void | Promise<void>;
  onRemoveSample: (sampleId: string) => void | Promise<void>;
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
  element: HTMLElement;
  definition: SlotCategoryDefinition;
  input: HTMLInputElement;
  cells: HTMLDivElement[];
}

const SLOT_CATEGORY_DEFINITIONS: SlotCategoryDefinition[] = [
  { key: "kicks", label: "Kick", start: 1, end: 99 },
  { key: "snares", label: "Snare", start: 100, end: 199 },
  { key: "cymbals", label: "Cymbal", start: 200, end: 299 },
  { key: "perc", label: "Perc", start: 300, end: 399 },
  { key: "bass", label: "Bass", start: 400, end: 499 },
  { key: "leads", label: "Lead", start: 500, end: 599 },
  { key: "skanks", label: "Pad", start: 600, end: 699 },
  { key: "voxfx", label: "Vox", start: 700, end: 799 },
  { key: "loops", label: "FX", start: 800, end: 899 },
  { key: "user", label: "Breakbeat", start: 900, end: 999 },
];

const DEFAULT_VIRTUAL_ROW_HEIGHT = 72;
const VIRTUAL_OVERSCAN_ROWS = 8;
const DEFAULT_VISIBLE_PATH_SEGMENTS = 4;
const PATH_MATCH_CONTEXT_CHARACTERS = 24;
const DEFAULT_RANDOMIZER_STEP_RATIO = 0.75;
const BUTTON_PRESS_ANIMATION_MS = 130;
const BUTTON_PRESS_EASING = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const ROOT_DIRECTORY_LABEL = "Ordnerwurzel";
type ScrollAlignment = "start" | "center";

function clampRandomizerRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_RANDOMIZER_STEP_RATIO;
  }

  return Math.max(0, Math.min(1, value));
}

function formatCount(count: number): string {
  const formattedCount = count.toLocaleString("de-DE");
  return `${formattedCount} Sample${count === 1 ? "" : "s"}`;
}

function formatProgressCount(current: number, total: number | null): string {
  const formattedCurrent = current.toLocaleString("de-DE");

  if (total === null) {
    return `${formattedCurrent} gefunden`;
  }

  return `${formattedCurrent} / ${total.toLocaleString("de-DE")}`;
}

function formatEta(estimatedRemainingMs: number | null): string {
  if (estimatedRemainingMs === null) {
    return "ETA wird berechnet";
  }

  if (estimatedRemainingMs <= 0) {
    return "Fast fertig";
  }

  const totalSeconds = Math.max(1, Math.round(estimatedRemainingMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s Rest`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds} Rest`;
}

function formatScanPhase(progress: ScanProgress): string {
  return progress.phase === "counting"
    ? "Sample-Library wird gezaehlt"
    : "Sample-Library wird gescannt";
}

function formatScanDetail(progress: ScanProgress): string {
  if (progress.phase === "counting") {
    return `${formatProgressCount(progress.discoveredSampleCount, null)} unterstuetzte Samples entdeckt`;
  }

  return `${formatProgressCount(progress.scannedSampleCount, progress.totalSampleCount)} Samples verarbeitet`;
}

function formatStatus(state: AppState): string {
  if (state.isScanning) {
    const directoryLabel = state.currentDirectoryName ?? "Ordner";

    if (!state.scanProgress) {
      return `Ordner: ${directoryLabel} · Scan laeuft...`;
    }

    return `Ordner: ${directoryLabel} · ${formatScanPhase(state.scanProgress)}`;
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
  const directoryPath = getDirectoryPath(sample.relativePath);
  path.title = directoryPath || ROOT_DIRECTORY_LABEL;
  const pathPreview = formatPathPreview(directoryPath, normalizedQuery);
  applyFuzzyHighlight(path, pathPreview, normalizedQuery);

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

  const assignmentButton = document.createElement("button");
  const removeAssignment = sample.slotNumber !== null;
  assignmentButton.className = removeAssignment
    ? "row-button remove-button"
    : "row-button write-button";
  assignmentButton.type = "button";
  assignmentButton.dataset.action = removeAssignment ? "remove" : "write";
  assignmentButton.dataset.id = sample.id;
  assignmentButton.textContent = removeAssignment ? "Remove" : "Write";

  actions.append(playButton, slotIndicator, assignmentButton);
  row.append(name, path, actions);

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

  const ranges = findHighlightRanges(text, normalizedQuery);

  if (ranges.length === 0) {
    element.textContent = text;
    return;
  }

  const fragment = document.createDocumentFragment();
  let textIndex = 0;

  for (const range of ranges) {
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

function getDirectoryPath(relativePath: string): string {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const lastSeparatorIndex = normalizedPath.lastIndexOf("/");

  if (lastSeparatorIndex <= 0) {
    return "";
  }

  return normalizedPath.slice(0, lastSeparatorIndex);
}

function findHighlightRanges(
  text: string,
  normalizedQuery: string,
): Array<{
  start: number;
  end: number;
}> {
  const queryTokens = splitNormalizedFuzzyQuery(normalizedQuery);

  if (queryTokens.length === 0) {
    return [];
  }

  const ranges = queryTokens.flatMap((token) => fuzzyMatch(text, token)?.ranges ?? []);
  return mergeFuzzyRanges(ranges);
}

function buildDefaultPathPreview(normalizedPath: string): string {
  if (!normalizedPath) {
    return ROOT_DIRECTORY_LABEL;
  }

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

  const ranges = findHighlightRanges(normalizedPath, normalizedQuery);

  if (ranges.length === 0) {
    return buildDefaultPathPreview(normalizedPath);
  }

  const firstMatch = ranges[0];
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

        <section class="scan-progress" data-role="scan-progress" hidden>
          <div class="scan-progress-head">
            <strong data-role="scan-progress-label"></strong>
            <span data-role="scan-progress-meta"></span>
          </div>
          <div
            class="scan-progress-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="0"
            aria-label="Scan-Fortschritt"
            data-role="scan-progress-track"
          >
            <div class="scan-progress-fill" data-role="scan-progress-fill"></div>
          </div>
          <div class="scan-progress-detail">
            <span data-role="scan-progress-detail"></span>
            <span data-role="scan-progress-path"></span>
          </div>
        </section>

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
                  title="Wiedergabe des ausgewaehlten Samples starten oder stoppen (S)"
                >
                  <span class="toolbar-main-button-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path class="is-solid" d="M8 6v12l10-6z" />
                    </svg>
                  </span>
                  <span class="toolbar-main-button-label">Play</span>
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
                  title="Ausgewaehltes Sample auf den naechsten freien Slot im aktiven Segment schreiben (D)"
                >
                  <span class="toolbar-main-button-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path
                        d="M6 5h9l3 3v11H6zM15 5v4h4M9 14h6M9 17h6M9 11h3"
                      />
                    </svg>
                  </span>
                  <span class="toolbar-main-button-label">Write</span>
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
            <div>Aktionen</div>
          </div>
          <div class="results-body" data-role="results-body"></div>
        </section>
      </section>

      <aside class="slot-panel">
        <div class="slot-panel-layout">
          <div class="slot-categories" data-role="slot-categories"></div>
          <div class="slot-counter-rail" data-role="slot-counter-rail">
            <div
              class="slot-counter-display"
              data-role="slot-counter"
              aria-label="Belegte Slots im aktiven Segment"
            ></div>
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
  const scanProgressElement = root.querySelector<HTMLElement>(
    '[data-role="scan-progress"]',
  );
  const scanProgressLabelElement = root.querySelector<HTMLElement>(
    '[data-role="scan-progress-label"]',
  );
  const scanProgressMetaElement = root.querySelector<HTMLElement>(
    '[data-role="scan-progress-meta"]',
  );
  const scanProgressTrackElement = root.querySelector<HTMLElement>(
    '[data-role="scan-progress-track"]',
  );
  const scanProgressFillElement = root.querySelector<HTMLElement>(
    '[data-role="scan-progress-fill"]',
  );
  const scanProgressDetailElement = root.querySelector<HTMLElement>(
    '[data-role="scan-progress-detail"]',
  );
  const scanProgressPathElement = root.querySelector<HTMLElement>(
    '[data-role="scan-progress-path"]',
  );
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
  const slotCounterDisplay = root.querySelector<HTMLDivElement>(
    '[data-role="slot-counter"]',
  );
  const slotCounterRail = root.querySelector<HTMLDivElement>(
    '[data-role="slot-counter-rail"]',
  );
  const slotCategories = root.querySelector<HTMLDivElement>(
    '[data-role="slot-categories"]',
  );
  const playSelectedButtonLabel = playSelectedButton?.querySelector<HTMLSpanElement>(
    ".toolbar-main-button-label",
  );
  const writeSelectedButtonLabel = writeSelectedButton?.querySelector<HTMLSpanElement>(
    ".toolbar-main-button-label",
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
    !scanProgressElement ||
    !scanProgressLabelElement ||
    !scanProgressMetaElement ||
    !scanProgressTrackElement ||
    !scanProgressFillElement ||
    !scanProgressDetailElement ||
    !scanProgressPathElement ||
    !errorElement ||
    !waveformPanel ||
    !waveformTitle ||
    !waveformDuration ||
    !loopToggleInput ||
    !waveformBaseCanvas ||
    !waveformPlayheadCanvas ||
    !resultsBody ||
    !slotCounterDisplay ||
    !slotCounterRail ||
    !slotCategories ||
    !playSelectedButtonLabel ||
    !writeSelectedButtonLabel
  ) {
    throw new Error("UI konnte nicht initialisiert werden.");
  }

  const waveformBaseCanvasElement = waveformBaseCanvas;
  const waveformPlayheadCanvasElement = waveformPlayheadCanvas;
  const resultsBodyElement = resultsBody;
  const slotCategoriesElement = slotCategories;
  const slotCounterRailElement = slotCounterRail;
  const slotCounterDisplayElement = slotCounterDisplay;
  const searchInputElement = searchInput;
  const assignedOnlyInputElement = assignedOnlyInput;
  const playSelectedButtonLabelElement = playSelectedButtonLabel;
  const writeSelectedButtonLabelElement = writeSelectedButtonLabel;
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
  let lastRenderedQuery = "";
  let lastRenderedAssignedOnly = false;
  const pressAnimationByButton = new WeakMap<HTMLButtonElement, Animation>();

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

  function getExportAssignmentsRequest(): ExportAssignmentsRequest {
    return {
      categories: slotCategoryElements.map((entry) => ({
        rangeStart: entry.definition.start,
        rangeEnd: entry.definition.end,
        label: entry.input.value.trim(),
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
    const totalHeight = totalCount * virtualRowHeight;
    const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
    const unclampedScrollTop = Math.max(0, resultsBodyElement.scrollTop);
    const scrollTop = Math.min(unclampedScrollTop, maxScrollTop);

    if (scrollTop !== unclampedScrollTop) {
      resultsBodyElement.scrollTop = scrollTop;
    }

    const visibleCount = Math.max(1, Math.ceil(viewportHeight / virtualRowHeight));
    const firstVisibleIndex = Math.min(
      totalCount - 1,
      Math.floor(scrollTop / virtualRowHeight),
    );
    const startIndex = Math.max(
      0,
      firstVisibleIndex - VIRTUAL_OVERSCAN_ROWS,
    );
    const endIndex = Math.min(
      totalCount,
      Math.max(
        firstVisibleIndex + visibleCount + VIRTUAL_OVERSCAN_ROWS,
        startIndex + visibleCount + VIRTUAL_OVERSCAN_ROWS * 2,
      ),
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

  function animateButtonPress(button: HTMLButtonElement): void {
    const previousAnimation = pressAnimationByButton.get(button);

    if (previousAnimation) {
      previousAnimation.cancel();
      pressAnimationByButton.delete(button);
    }

    button.classList.remove("is-pressed");

    if (typeof button.animate !== "function") {
      button.classList.add("is-pressed");
      window.setTimeout(() => {
        button.classList.remove("is-pressed");
      }, BUTTON_PRESS_ANIMATION_MS);
      return;
    }

    const animation = button.animate(
      [
        {
          transform: "translate(1px, 1px)",
          boxShadow: "1px 1px 0 rgba(73, 44, 53, 0.28)",
        },
        {
          transform: "translate(0px, 0px)",
          boxShadow: "2px 2px 0 rgba(73, 44, 53, 0.24)",
        },
      ],
      {
        duration: BUTTON_PRESS_ANIMATION_MS,
        easing: BUTTON_PRESS_EASING,
      },
    );

    pressAnimationByButton.set(button, animation);
    animation.addEventListener("finish", () => {
      if (pressAnimationByButton.get(button) === animation) {
        pressAnimationByButton.delete(button);
      }
    });
    animation.addEventListener("cancel", () => {
      if (pressAnimationByButton.get(button) === animation) {
        pressAnimationByButton.delete(button);
      }
    });
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
        if (!assignedOnlyInputElement.checked) {
          triggerSearch(inputElement.value);
        }
        handlers.onSlotCategoryActivate(definition.start, definition.end);
      });
      fragment.append(categoryElement);
      slotCategoryElements.push({
        element: categoryElement,
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

    for (const category of slotCategoryElements) {
      category.element.classList.toggle(
        "is-active",
        category.definition.start === state.activeSlotRangeStart,
      );

      for (const cell of category.cells) {
        const slotNumber = Number.parseInt(cell.dataset.slotNumber ?? "", 10);

        if (!Number.isInteger(slotNumber)) {
          cell.classList.remove("is-assigned", "is-counter");
          continue;
        }

        cell.classList.toggle("is-assigned", assignedSlots.has(slotNumber));
        cell.classList.toggle(
          "is-counter",
          state.slotCounter !== null && state.slotCounter === slotNumber,
        );
      }
    }
  }

  function syncSlotCounterPosition(): void {
    const railRect = slotCounterRailElement.getBoundingClientRect();
    const displayHeight = slotCounterDisplayElement.offsetHeight;

    if (displayHeight <= 0 || railRect.height <= 0) {
      slotCounterDisplayElement.style.setProperty("--slot-counter-offset", "0px");
      return;
    }

    const activePixel = slotCategoriesElement.querySelector<HTMLElement>(
      ".slot-pixel.is-counter",
    );
    const fallbackCategory = slotCategoriesElement.querySelector<HTMLElement>(
      ".slot-category.is-active",
    );
    const defaultCategory = slotCategoriesElement.querySelector<HTMLElement>(
      ".slot-category",
    );
    const targetElement = activePixel ?? fallbackCategory ?? defaultCategory;

    if (!targetElement) {
      slotCounterDisplayElement.style.setProperty("--slot-counter-offset", "0px");
      return;
    }

    const targetRect = targetElement.getBoundingClientRect();
    const unclampedOffset =
      targetRect.top - railRect.top + targetRect.height / 2 - displayHeight / 2;
    const maxOffset = Math.max(0, railRect.height - displayHeight);
    const clampedOffset = Math.max(0, Math.min(maxOffset, unclampedOffset));

    slotCounterDisplayElement.style.setProperty(
      "--slot-counter-offset",
      `${Math.round(clampedOffset)}px`,
    );
  }

  createSlotCategoryElements();
  syncRandomizerRatioInputs(DEFAULT_RANDOMIZER_STEP_RATIO * 100);

  pickDirectoryButton.addEventListener("click", () => {
    animateButtonPress(pickDirectoryButton);
    void handlers.onPickDirectory();
  });

  exportAssignmentsButtonElement.addEventListener("click", () => {
    void handlers.onExportAssignments(getExportAssignmentsRequest());
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
    animateButtonPress(randomSampleButton);
    selectAndCenter(handlers.onSelectRandomSample, "center");
  });

  previousSelectedButton.addEventListener("click", () => {
    animateButtonPress(previousSelectedButton);
    selectAndCenter(handlers.onSelectPreviousSample, "center");
  });

  playSelectedButton.addEventListener("click", () => {
    animateButtonPress(playSelectedButton);
    void handlers.onPlaySelectedSample();
  });

  nextSelectedButton.addEventListener("click", () => {
    animateButtonPress(nextSelectedButton);
    selectAndCenter(handlers.onSelectNextSample, "center");
  });

  writeSelectedButton.addEventListener("click", () => {
    animateButtonPress(writeSelectedButton);
    if (writeSelectedButton.dataset.mode === "remove") {
      void handlers.onRemoveSelectedSample();
      return;
    }

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
        return;
      }

      if (action === "remove") {
        void handlers.onRemoveSample(sampleId);
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
      const selectedSampleIsPlaying =
        selectedSample !== null && state.currentAudioId === selectedSample.id;
      const removeSelectedAssignment = selectedSample?.slotNumber !== null;
      playSelectedButton.disabled =
        !canUseSelectedSampleActions ||
        selectedSample === null ||
        !isBrowserAudioExtensionSupported(selectedSample.extension);
      playSelectedButton.classList.toggle("is-active-play", selectedSampleIsPlaying);
      playSelectedButtonLabelElement.textContent = selectedSampleIsPlaying
        ? "Stop"
        : "Play";
      playSelectedButton.title = selectedSampleIsPlaying
        ? "Wiedergabe des ausgewaehlten Samples stoppen (S)"
        : "Wiedergabe des ausgewaehlten Samples starten oder stoppen (S)";
      writeSelectedButton.disabled = !canUseSelectedSampleActions;
      writeSelectedButton.dataset.mode = removeSelectedAssignment ? "remove" : "write";
      writeSelectedButton.classList.toggle("is-write", !removeSelectedAssignment);
      writeSelectedButton.classList.toggle("is-remove", removeSelectedAssignment);
      writeSelectedButtonLabelElement.textContent = removeSelectedAssignment
        ? "Remove"
        : "Write";
      writeSelectedButton.title = removeSelectedAssignment
        ? "Zuweisung des ausgewaehlten Samples entfernen und Segment lueckenlos nachruecken."
        : "Ausgewaehltes Sample auf den naechsten freien Slot im aktiven Segment schreiben.";

      const assignedOnlyModeActive = state.showAssignedOnly;
      const effectiveNormalizedQuery = assignedOnlyModeActive
        ? ""
        : normalizeFuzzyQuery(state.query);
      const filterModeChanged =
        state.query !== lastRenderedQuery ||
        assignedOnlyModeActive !== lastRenderedAssignedOnly;

      lastRenderedQuery = state.query;
      lastRenderedAssignedOnly = assignedOnlyModeActive;

      searchInput.value = state.query;
      searchInput.disabled = assignedOnlyModeActive;
      searchInput.title = assignedOnlyModeActive
        ? "Suchfilter pausiert, solange nur zugewiesene Samples angezeigt werden."
        : "";
      assignedOnlyInputElement.checked = state.showAssignedOnly;
      syncRandomizerRatioInputs(state.randomizerStepRatio * 100);
      slotCounterDisplayElement.textContent = String(state.activeSlotAssignedCount);
      loopToggleInput.checked = state.loopEnabled;
      autoplayToggleInput.checked = state.autoplayEnabled;

      statusElement.textContent = formatStatus(state);
      countElement.textContent =
        state.isScanning && state.scanProgress
          ? state.scanProgress.phase === "counting"
            ? `${state.scanProgress.discoveredSampleCount.toLocaleString(
                "de-DE",
              )} Samples gefunden`
            : `${formatProgressCount(
                state.scanProgress.scannedSampleCount,
                state.scanProgress.totalSampleCount,
              )} Samples`
          : formatCount(state.filteredSamples.length);

      if (state.isScanning && state.scanProgress) {
        const { scanProgress } = state;
        const progressPercent =
          scanProgress.phase === "scanning" &&
          scanProgress.totalSampleCount !== null &&
          scanProgress.totalSampleCount > 0
            ? Math.max(
                0,
                Math.min(
                  100,
                  (scanProgress.scannedSampleCount / scanProgress.totalSampleCount) *
                    100,
                ),
              )
            : 0;

        scanProgressElement.hidden = false;
        scanProgressLabelElement.textContent = formatScanPhase(scanProgress);
        scanProgressMetaElement.textContent =
          scanProgress.phase === "counting"
            ? formatProgressCount(scanProgress.discoveredSampleCount, null)
            : `${formatProgressCount(
                scanProgress.scannedSampleCount,
                scanProgress.totalSampleCount,
              )} · ${formatEta(scanProgress.estimatedRemainingMs)}`;
        scanProgressDetailElement.textContent = formatScanDetail(scanProgress);
        scanProgressPathElement.textContent = scanProgress.currentPath
          ? buildDefaultPathPreview(scanProgress.currentPath)
          : "";
        scanProgressTrackElement.classList.toggle(
          "is-indeterminate",
          scanProgress.phase === "counting",
        );
        scanProgressTrackElement.setAttribute(
          "aria-valuenow",
          String(Math.round(progressPercent)),
        );
        scanProgressFillElement.style.width =
          scanProgress.phase === "counting" ? "36%" : `${progressPercent}%`;
      } else {
        scanProgressElement.hidden = true;
        scanProgressLabelElement.textContent = "";
        scanProgressMetaElement.textContent = "";
        scanProgressDetailElement.textContent = "";
        scanProgressPathElement.textContent = "";
        scanProgressTrackElement.classList.remove("is-indeterminate");
        scanProgressTrackElement.setAttribute("aria-valuenow", "0");
        scanProgressFillElement.style.width = "0%";
      }

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
      virtualNormalizedQuery = effectiveNormalizedQuery;
      ensureVirtualListMounted();

      if (filterModeChanged) {
        if (!state.selectedSampleId || !scrollSampleInResults(state.selectedSampleId, "start")) {
          resultsBodyElement.scrollTop = 0;
          invalidateVirtualWindow();
        }
      }

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
