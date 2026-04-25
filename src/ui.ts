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
  ScanProgress,
  SampleRecord,
  WaveformPreview,
} from "./types";

interface UIHandlers {
  onPickDirectory: () => void | Promise<void>;
  onRefreshScan: () => void | Promise<void>;
  onResetAssignments: () => void | Promise<void>;
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
  destroy: () => void;
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
  size: HTMLSpanElement;
  count: HTMLSpanElement;
  cells: HTMLDivElement[];
}

interface ThemeOption {
  key: string;
  label: string;
  accent: string;
  accentStrong: string;
  contrast: string;
}

interface KeyboardPressState {
  intensity: number;
  lastPressedAt: number;
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
const BUTTON_PRESS_ANIMATION_MS = 130;
const KEYBOARD_BUTTON_PRESS_ANIMATION_MS = 240;
const SPACEBAR_PRESS_ANIMATION_BASE_MS = 300;
const KEYBOARD_PRESS_DECAY_MS = 700;
const BUTTON_PRESS_EASING = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const WAVEFORM_SWAP_ANIMATION_MS = 220;
const WAVEFORM_SWAP_EASING = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const ROOT_DIRECTORY_LABEL = "Root folder";
const THEME_STORAGE_KEY = "sample-picker-theme";
const THEME_OPTIONS = [
  {
    key: "lime",
    label: "Lime",
    accent: "#a9dc76",
    accentStrong: "#c9f2a0",
    contrast: "#fc9867",
  },
  {
    key: "yellow",
    label: "Yellow",
    accent: "#ffd866",
    accentStrong: "#ffe69c",
    contrast: "#ab9df2",
  },
  {
    key: "orange",
    label: "Orange",
    accent: "#fc9867",
    accentStrong: "#ffb38d",
    contrast: "#78dce8",
  },
  {
    key: "violet",
    label: "Violet",
    accent: "#ab9df2",
    accentStrong: "#d0c8ff",
    contrast: "#a9dc76",
  },
  {
    key: "cyan",
    label: "Cyan",
    accent: "#78dce8",
    accentStrong: "#a9eef6",
    contrast: "#ffd866",
  },
] as const satisfies readonly ThemeOption[];
type ThemeKey = (typeof THEME_OPTIONS)[number]["key"];
const DEFAULT_THEME_KEY: ThemeKey = "orange";
type ScrollAlignment = "start" | "center";

function isThemeKey(value: string | null): value is ThemeKey {
  return THEME_OPTIONS.some((option) => option.key === value);
}

function applyTheme(themeKey: ThemeKey): void {
  document.documentElement.dataset.theme = themeKey;
}

function readStoredTheme(): ThemeKey {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeKey(value) ? value : DEFAULT_THEME_KEY;
  } catch {
    return DEFAULT_THEME_KEY;
  }
}

function persistTheme(themeKey: ThemeKey): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeKey);
  } catch {
    // Ignore storage failures such as private mode restrictions.
  }
}

function getThemeOption(themeKey: ThemeKey): ThemeOption {
  return (
    THEME_OPTIONS.find((option) => option.key === themeKey) ??
    THEME_OPTIONS.find((option) => option.key === DEFAULT_THEME_KEY) ??
    THEME_OPTIONS[0]
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : normalized;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function getWaveformPalette(): {
  centerLine: string;
  placeholder: string;
  bar: string;
  playhead: string;
  playheadGlow: string;
} {
  const datasetTheme = document.documentElement.dataset.theme ?? null;
  const activeThemeKey = isThemeKey(datasetTheme)
    ? datasetTheme
    : DEFAULT_THEME_KEY;
  const theme = getThemeOption(activeThemeKey);

  return {
    centerLine: hexToRgba(theme.accent, 0.28),
    placeholder: hexToRgba(theme.contrast, 0.42),
    bar: hexToRgba(theme.contrast, 0.94),
    playhead: hexToRgba(theme.accentStrong, 0.96),
    playheadGlow: hexToRgba(theme.accentStrong, 0.34),
  };
}

function getSlotCategoryRangeStart(slotNumber: number): number {
  for (const definition of SLOT_CATEGORY_DEFINITIONS) {
    if (slotNumber >= definition.start && slotNumber <= definition.end) {
      return definition.start;
    }
  }

  return SLOT_CATEGORY_DEFINITIONS[0]?.start ?? 1;
}

function formatCount(count: number): string {
  const formattedCount = count.toLocaleString("en-US");
  return `${formattedCount} sample${count === 1 ? "" : "s"}`;
}

function formatMegabytes(bytes: number): string {
  const megabytes = Math.max(0, bytes) / (1024 * 1024);
  return `${megabytes.toLocaleString("en-US", {
    minimumFractionDigits: megabytes < 10 ? 1 : 0,
    maximumFractionDigits: 1,
  })} MB`;
}

function formatProgressCount(current: number, total: number | null): string {
  const formattedCurrent = current.toLocaleString("en-US");

  if (total === null) {
    return `${formattedCurrent} found`;
  }

  return `${formattedCurrent} / ${total.toLocaleString("en-US")}`;
}

function formatEta(estimatedRemainingMs: number | null): string {
  if (estimatedRemainingMs === null) {
    return "Calculating ETA";
  }

  if (estimatedRemainingMs <= 0) {
    return "Almost done";
  }

  const totalSeconds = Math.max(1, Math.round(estimatedRemainingMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s left`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds} left`;
}

function formatScanPhase(progress: ScanProgress): string {
  return progress.phase === "counting"
    ? "Counting sample library"
    : "Scanning sample library";
}

function formatScanDetail(progress: ScanProgress): string {
  if (progress.phase === "counting") {
    return `${formatProgressCount(progress.discoveredSampleCount, null)} supported samples found`;
  }

  return `${formatProgressCount(progress.scannedSampleCount, progress.totalSampleCount)} samples processed`;
}

function formatStatus(state: AppState): string {
  if (state.isScanning) {
    const directoryLabel = state.currentDirectoryName ?? "Folder";

    if (!state.scanProgress) {
      return `Folder: ${directoryLabel} · Scan in progress...`;
    }

    return `Folder: ${directoryLabel} · ${formatScanPhase(state.scanProgress)}`;
  }

  if (!state.currentDirectoryName) {
    return "No folder selected yet.";
  }

  const lastScan = state.lastScanAt
    ? `Last scanned: ${new Date(state.lastScanAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}`
    : "Index loaded from IndexedDB.";

  return `Folder: ${state.currentDirectoryName} · ${lastScan}`;
}

function formatDuration(durationSeconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationSeconds));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function getWaveformSignature(waveform: WaveformPreview | null): string | null {
  if (!waveform) {
    return null;
  }

  return `${waveform.sampleId}:${waveform.durationSeconds}:${waveform.peaks.length}`;
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
  const palette = getWaveformPalette();
  context.strokeStyle = palette.centerLine;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, centerY);
  context.lineTo(width, centerY);
  context.stroke();

  if (!waveform || waveform.peaks.length === 0) {
    context.fillStyle = palette.placeholder;
    context.fillRect(Math.max(0, width / 2 - 2), centerY - 18, 4, 36);
    return;
  }

  const usableHeight = Math.max(8, height - 8);
  const barWidth = 2;
  const gap = 1;
  const step = barWidth + gap;
  const barCount = Math.max(1, Math.floor(width / step));

  context.fillStyle = palette.bar;

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
  const palette = getWaveformPalette();
  context.strokeStyle = palette.playhead;
  context.lineWidth = 2;
  context.shadowBlur = 14;
  context.shadowColor = palette.playheadGlow;
  context.beginPath();
  context.moveTo(x, 2);
  context.lineTo(x, height - 2);
  context.stroke();
  context.shadowBlur = 0;
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
    : `Audio preview for .${sample.extension} is not supported by this browser.`;

  const slotIndicator = document.createElement("span");
  slotIndicator.className = "slot-indicator";
  slotIndicator.textContent =
    sample.slotNumber === null ? "Slot -" : `Slot ${sample.slotNumber}`;

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
  const initialTheme = readStoredTheme();
  applyTheme(initialTheme);
  const themePickerMarkup = THEME_OPTIONS.map(
    (option) => `
      <label
        class="theme-picker-option"
        style="--theme-swatch: ${option.accent}"
        title="${option.label}"
      >
        <input
          type="radio"
          name="theme-accent"
          value="${option.key}"
          data-role="theme-option"
          aria-label="${option.label}"
          ${option.key === initialTheme ? "checked" : ""}
        />
        <span class="theme-picker-swatch" aria-hidden="true"></span>
      </label>
    `,
  ).join("");

  root.innerHTML = `
    <main class="app-shell">
      <section class="main-column">
        <section class="topbar">
          <div class="headline">
            <div class="headline-brand">
              <fieldset class="theme-picker" aria-label="Accent color">
                ${themePickerMarkup}
              </fieldset>
              <h1>
                <a
                  class="headline-title-link"
                  href="https://open.spotify.com/artist/3nGx93gi9ipSyKlCBMTwlA?autoplay=true"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  DJ Coolplay Samplepicker
                </a>
              </h1>
            </div>
            <div class="headline-actions">
              <button
                type="button"
                class="danger-button headline-reset-button"
                data-role="reset-assignments"
              >
                Reset
              </button>
              <button
                type="button"
                class="secondary-button headline-export-button"
                data-role="export-assignments"
              >
                Export
              </button>
            </div>
          </div>
          <div class="panel">
            <div class="controls">
              <button type="button" class="primary-button" data-role="pick-directory">
                Choose folder
              </button>
              <button type="button" class="secondary-button" data-role="refresh-scan">
                Refresh folder
              </button>
              <div class="search-wrap">
                <input
                  type="search"
                  placeholder="Search by name or path"
                  aria-label="Search samples"
                  data-role="search"
                />
              </div>
              <label class="filter-toggle">
                <input type="checkbox" data-role="assigned-only" />
                Assigned only
              </label>
            </div>
          </div>
        </section>

        <div class="statusbar">
          <div data-role="status"></div>
          <div data-role="assigned-size"></div>
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
            aria-label="Scan progress"
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
        <div class="success-box" data-role="success" hidden></div>

        <section class="waveform-panel" data-role="waveform-panel">
          <div class="waveform-meta">
            <strong data-role="waveform-title">No sample selected</strong>
            <div class="waveform-controls">
              <label class="loop-toggle">
                <input type="checkbox" data-role="loop-toggle" />
                Loop
              </label>
              <label class="loop-toggle">
                <input type="checkbox" data-role="autoplay-toggle" />
                Autoplay
              </label>
              <span class="waveform-duration" data-role="waveform-duration">--:--</span>
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
            <div class="results-toolbar-main-actions keyboard-toolbar">
              <div class="keyboard-cluster">
                <button
                  type="button"
                  class="toolbar-main-button toolbar-spacebar is-play-main"
                  data-role="play-selected"
                  title="Start or stop playback for the selected sample (Space)"
                >
                  <span class="toolbar-spacebar-main toolbar-main-button-label">Play</span>
                  <span class="toolbar-spacebar-key">Space</span>
                </button>
                <button
                  type="button"
                  class="toolbar-main-button toolbar-key is-random-key"
                  data-role="random-sample"
                  title="Select a random sample from the current results (Left Arrow)"
                >
                  <span class="toolbar-key-arrow" aria-hidden="true">←</span>
                  <span class="toolbar-key-label">Random</span>
                </button>
                <button
                  type="button"
                  class="toolbar-main-button toolbar-key is-nav is-nav-up"
                  data-role="previous-selected"
                  title="Select the previous result (Up Arrow)"
                >
                  <span class="toolbar-key-arrow" aria-hidden="true">↑</span>
                  <span class="toolbar-key-label">Prev</span>
                </button>
                <button
                  type="button"
                  class="toolbar-main-button toolbar-key is-nav is-nav-down"
                  data-role="next-selected"
                  title="Select the next result (Down Arrow)"
                >
                  <span class="toolbar-key-arrow" aria-hidden="true">↓</span>
                  <span class="toolbar-key-label">Next</span>
                </button>
                <button
                  type="button"
                  class="toolbar-main-button toolbar-key is-write-key is-write"
                  data-role="write-selected"
                  title="Assign the selected sample to the next free slot in the active segment (Enter)"
                >
                  <span class="toolbar-key-arrow" aria-hidden="true">↵</span>
                  <span class="toolbar-key-label toolbar-main-button-label">Write</span>
                </button>
              </div>
            </div>
          </div>
          <div class="results-header">
            <div>Name</div>
            <div>Path</div>
            <div>Actions</div>
          </div>
          <div class="results-body" data-role="results-body"></div>
        </section>
      </section>

      <aside class="slot-panel">
        <div class="slot-panel-layout">
          <div class="slot-categories" data-role="slot-categories"></div>
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
  const searchInput = root.querySelector<HTMLInputElement>('[data-role="search"]');
  const assignedOnlyInput = root.querySelector<HTMLInputElement>(
    '[data-role="assigned-only"]',
  );
  const statusElement = root.querySelector<HTMLDivElement>('[data-role="status"]');
  const countElement = root.querySelector<HTMLDivElement>('[data-role="count"]');
  const assignedSizeElement = root.querySelector<HTMLDivElement>(
    '[data-role="assigned-size"]',
  );
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
  const successElement = root.querySelector<HTMLDivElement>('[data-role="success"]');
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
    !searchInput ||
    !assignedOnlyInput ||
    !statusElement ||
    !assignedSizeElement ||
    !countElement ||
    !scanProgressElement ||
    !scanProgressLabelElement ||
    !scanProgressMetaElement ||
    !scanProgressTrackElement ||
    !scanProgressFillElement ||
    !scanProgressDetailElement ||
    !scanProgressPathElement ||
    !errorElement ||
    !successElement ||
    !waveformPanel ||
    !waveformTitle ||
    !waveformDuration ||
    !loopToggleInput ||
    !waveformBaseCanvas ||
    !waveformPlayheadCanvas ||
    !resultsBody ||
    !slotCategories ||
    !playSelectedButtonLabel ||
    !writeSelectedButtonLabel
  ) {
    throw new Error("UI konnte nicht initialisiert werden.");
  }

  const waveformBaseCanvasElement = waveformBaseCanvas;
  const waveformPlayheadCanvasElement = waveformPlayheadCanvas;
  const waveformPanelElement = waveformPanel;
  const waveformTitleElement = waveformTitle;
  const waveformDurationElement = waveformDuration;
  const resultsBodyElement = resultsBody;
  const slotCategoriesElement = slotCategories;
  const searchInputElement = searchInput;
  const assignedOnlyInputElement = assignedOnlyInput;
  const playSelectedButtonLabelElement = playSelectedButtonLabel;
  const writeSelectedButtonLabelElement = writeSelectedButtonLabel;
  const exportAssignmentsButtonElement = exportAssignmentsButton;
  const themeOptionInputs = Array.from(
    root.querySelectorAll<HTMLInputElement>('[data-role="theme-option"]'),
  );
  const slotCategoryElements: SlotCategoryElements[] = [];
  let latestWaveform: WaveformPreview | null = null;
  let displayedWaveform: WaveformPreview | null = null;
  let displayedWaveformSignature: string | null = null;
  let pendingWaveformSignature: string | null = null;
  let latestSelectedSampleId: string | null = null;
  let latestCurrentAudioId: string | null = null;
  let playheadFrameId: number | null = null;
  let waveformSwapAnimation: Animation | null = null;
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
  let resizeObserver: ResizeObserver | null = null;
  const pressAnimationByButton = new WeakMap<HTMLButtonElement, Animation>();
  const keyboardPressStateByButton = new WeakMap<
    HTMLButtonElement,
    KeyboardPressState
  >();

  function getExportAssignmentsRequest(): ExportAssignmentsRequest {
    return {
      categories: slotCategoryElements.map((entry) => ({
        rangeStart: entry.definition.start,
        rangeEnd: entry.definition.end,
        label: entry.input.value.trim(),
      })),
    };
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

    const isKeyboardClusterButton = button.closest(".keyboard-cluster") !== null;
    const buttonStyles = window.getComputedStyle(button);
    const borderColor = buttonStyles.borderColor;
    const glowColor = buttonStyles.color;
    const isSpacebar = button.classList.contains("toolbar-spacebar");
    const now = performance.now();
    const previousKeyboardState = keyboardPressStateByButton.get(button);
    const decayedIntensity = previousKeyboardState
      ? previousKeyboardState.intensity *
        Math.exp(
          -(now - previousKeyboardState.lastPressedAt) / KEYBOARD_PRESS_DECAY_MS,
        )
      : 0;
    const nextIntensity = isKeyboardClusterButton
      ? Math.min(
          isSpacebar ? 4.8 : 3.5,
          decayedIntensity + (isSpacebar ? 1.05 : 0.78),
        )
      : 0;

    if (isKeyboardClusterButton) {
      keyboardPressStateByButton.set(button, {
        intensity: nextIntensity,
        lastPressedAt: now,
      });
    }

    const directionX = (Math.random() - 0.5) * (isSpacebar ? 1 : 0.82);
    const directionY = (Math.random() - 0.5) * 0.72;
    const rotationDirection = (Math.random() - 0.5) * (isSpacebar ? 1.4 : 1.1);
    const driftX = directionX * (isSpacebar ? 8.5 : 6.4) * nextIntensity;
    const driftY = directionY * (isSpacebar ? 4.8 : 3.8) * nextIntensity;
    const settleX = directionX * -2.4 * nextIntensity;
    const settleY = Math.max(0.5, 1 + Math.abs(directionY) * nextIntensity * 0.7);
    const peakRotation = rotationDirection * nextIntensity * (isSpacebar ? 1.1 : 0.85);
    const settleRotation = rotationDirection * nextIntensity * -0.36;
    const pressScaleX = isSpacebar
      ? 0.986 - Math.min(0.018, nextIntensity * 0.003)
      : 0.982 - Math.min(0.014, nextIntensity * 0.0024);
    const pressScaleY = isSpacebar
      ? 0.956 - Math.min(0.03, nextIntensity * 0.004)
      : 0.968 - Math.min(0.022, nextIntensity * 0.0032);
    const bounceScaleX = 1.008 + Math.min(0.026, nextIntensity * 0.005);
    const bounceScaleY = 1.012 + Math.min(0.03, nextIntensity * 0.0056);
    const animation = isKeyboardClusterButton
      ? isSpacebar
        ? button.animate(
            [
              {
                transform: "translate3d(0px, 0px, 0px) scale(1)",
                boxShadow: "2px 2px 0 rgba(0, 0, 0, 0.34)",
                filter: "brightness(1) saturate(1)",
              },
              {
                transform: `translate3d(0px, ${(1.8 + nextIntensity * 0.5).toFixed(2)}px, 0px) scale(${pressScaleX.toFixed(3)}, ${pressScaleY.toFixed(3)}) rotate(${(
                  rotationDirection * 0.22 * nextIntensity
                ).toFixed(3)}deg)`,
                boxShadow: `0 1px 0 rgba(0, 0, 0, 0.28), 0 0 ${(
                  16 + nextIntensity * 4
                ).toFixed(1)}px ${borderColor}`,
                filter: `brightness(${(1.16 + nextIntensity * 0.045).toFixed(3)}) saturate(${(
                  1.12 + nextIntensity * 0.035
                ).toFixed(3)})`,
                offset: 0.22,
              },
              {
                transform: `translate3d(${driftX.toFixed(2)}px, ${(
                  -1.4 + driftY
                ).toFixed(2)}px, 0px) scale(${bounceScaleX.toFixed(3)}, ${bounceScaleY.toFixed(
                  3,
                )}) rotate(${peakRotation.toFixed(3)}deg)`,
                boxShadow: `0 4px 14px rgba(0, 0, 0, 0.22), 0 0 ${(
                  18 + nextIntensity * 5.5
                ).toFixed(1)}px ${glowColor}`,
                filter: `brightness(${(1.12 + nextIntensity * 0.03).toFixed(3)}) saturate(${(
                  1.08 + nextIntensity * 0.028
                ).toFixed(3)})`,
                offset: 0.56,
              },
              {
                transform: `translate3d(${settleX.toFixed(2)}px, ${settleY.toFixed(
                  2,
                )}px, 0px) scale(${(0.996 + nextIntensity * 0.002).toFixed(3)}, ${(
                  0.988 + nextIntensity * 0.0018
                ).toFixed(3)}) rotate(${settleRotation.toFixed(3)}deg)`,
                boxShadow: `1px 2px 0 rgba(0, 0, 0, 0.24), 0 0 ${(
                  11 + nextIntensity * 2.5
                ).toFixed(1)}px ${borderColor}`,
                filter: `brightness(${(1.03 + nextIntensity * 0.014).toFixed(3)}) saturate(${(
                  1.01 + nextIntensity * 0.01
                ).toFixed(3)})`,
                offset: 0.78,
              },
              {
                transform: "translate3d(0px, 0px, 0px) scale(1)",
                boxShadow: "2px 2px 0 rgba(0, 0, 0, 0.34)",
                filter: "brightness(1) saturate(1)",
              },
            ],
            {
              duration: Math.round(
                SPACEBAR_PRESS_ANIMATION_BASE_MS +
                  Math.floor(Math.random() * 90) +
                  nextIntensity * 32,
              ),
              easing: "cubic-bezier(0.18, 0.82, 0.22, 1)",
            },
          )
        : button.animate(
            [
              {
                transform: "translate3d(0px, 0px, 0px) scale(1)",
                boxShadow: "2px 2px 0 rgba(0, 0, 0, 0.34)",
                filter: "brightness(1) saturate(1)",
              },
              {
                transform: `translate3d(0px, ${(1.6 + nextIntensity * 0.44).toFixed(
                  2,
                )}px, 0px) scale(${pressScaleX.toFixed(3)}, ${pressScaleY.toFixed(
                  3,
                )}) rotate(${(rotationDirection * 0.18 * nextIntensity).toFixed(3)}deg)`,
                boxShadow: `0 1px 0 rgba(0, 0, 0, 0.28), 0 0 ${(
                  12 + nextIntensity * 3.8
                ).toFixed(1)}px ${borderColor}`,
                filter: `brightness(${(1.12 + nextIntensity * 0.04).toFixed(3)}) saturate(${(
                  1.08 + nextIntensity * 0.03
                ).toFixed(3)})`,
                offset: 0.28,
              },
              {
                transform: `translate3d(${(driftX * 0.84).toFixed(2)}px, ${(
                  -1 + driftY * 0.78
                ).toFixed(2)}px, 0px) scale(${(1.01 + nextIntensity * 0.005).toFixed(
                  3,
                )}, ${(1.012 + nextIntensity * 0.0055).toFixed(3)}) rotate(${(
                  peakRotation * 0.72
                ).toFixed(3)}deg)`,
                boxShadow: `0 3px 10px rgba(0, 0, 0, 0.2), 0 0 ${(
                  11 + nextIntensity * 4
                ).toFixed(1)}px ${glowColor}`,
                filter: `brightness(${(1.05 + nextIntensity * 0.02).toFixed(3)}) saturate(${(
                  1.03 + nextIntensity * 0.018
                ).toFixed(3)})`,
                offset: 0.62,
              },
              {
                transform: `translate3d(${(settleX * 0.72).toFixed(2)}px, ${(
                  0.8 + settleY * 0.32
                ).toFixed(2)}px, 0px) scale(${(0.998 + nextIntensity * 0.0015).toFixed(
                  3,
                )}, ${(0.995 + nextIntensity * 0.0018).toFixed(3)}) rotate(${(
                  settleRotation * 0.8
                ).toFixed(3)}deg)`,
                boxShadow: `1px 2px 0 rgba(0, 0, 0, 0.24), 0 0 ${(
                  9 + nextIntensity * 2.4
                ).toFixed(1)}px ${borderColor}`,
                filter: `brightness(${(1.02 + nextIntensity * 0.01).toFixed(3)}) saturate(${(
                  1.01 + nextIntensity * 0.008
                ).toFixed(3)})`,
                offset: 0.82,
              },
              {
                transform: "translate3d(0px, 0px, 0px) scale(1)",
                boxShadow: "2px 2px 0 rgba(0, 0, 0, 0.34)",
                filter: "brightness(1) saturate(1)",
              },
            ],
            {
              duration: Math.round(
                KEYBOARD_BUTTON_PRESS_ANIMATION_MS + nextIntensity * 28,
              ),
              easing: "cubic-bezier(0.2, 0.88, 0.24, 1)",
            },
          )
      : button.animate(
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
      latestCurrentAudioId === latestSelectedSampleId &&
      latestWaveform?.sampleId === latestSelectedSampleId &&
      latestWaveform.peaks.length > 0 &&
      displayedWaveform?.sampleId === latestSelectedSampleId
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

      const countElement = document.createElement("span");
      countElement.className = "slot-category-count";
      countElement.textContent = "";

      const metaFooterElement = document.createElement("div");
      metaFooterElement.className = "slot-category-meta-footer";
      metaFooterElement.append(rangeElement, countElement);

      const sizeElement = document.createElement("span");
      sizeElement.className = "slot-category-size";
      sizeElement.textContent = "0 MB";

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
        }

        cells.push(pixelElement);
        pixelsElement.append(pixelElement);
      }

      metaElement.append(inputElement, metaFooterElement, sizeElement);
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
        size: sizeElement,
        count: countElement,
        cells,
      });
    }

    slotCategoriesElement.append(fragment);
  }

  function renderSlotMatrix(state: AppState): void {
    const assignedSlots = new Set<number>();
    const assignedBytesByCategoryStart = new Map<number, number>();

    for (const sample of state.samples) {
      if (sample.slotNumber !== null) {
        assignedSlots.add(sample.slotNumber);
        const categoryRangeStart = getSlotCategoryRangeStart(sample.slotNumber);
        assignedBytesByCategoryStart.set(
          categoryRangeStart,
          (assignedBytesByCategoryStart.get(categoryRangeStart) ?? 0) + sample.size,
        );
      }
    }

    for (const category of slotCategoryElements) {
      const isActive = category.definition.start === state.activeSlotRangeStart;

      category.element.classList.toggle(
        "is-active",
        isActive,
      );
      category.size.textContent = formatMegabytes(
        assignedBytesByCategoryStart.get(category.definition.start) ?? 0,
      );
      category.count.textContent = isActive
        ? String(state.activeSlotAssignedCount)
        : "";

      for (const cell of category.cells) {
        const slotNumber = Number.parseInt(cell.dataset.slotNumber ?? "", 10);

        if (!Number.isInteger(slotNumber)) {
          cell.classList.remove("is-assigned");
          continue;
        }

        cell.classList.toggle("is-assigned", assignedSlots.has(slotNumber));
      }
    }
  }

  createSlotCategoryElements();

  function setTheme(themeKey: ThemeKey): void {
    applyTheme(themeKey);
    persistTheme(themeKey);

    for (const input of themeOptionInputs) {
      input.checked = input.value === themeKey;
    }

    drawWaveform(waveformBaseCanvasElement, displayedWaveform);
    drawPlayhead(waveformPlayheadCanvasElement, getPlayheadProgress());
  }

  function renderWaveformMeta(
    waveform: WaveformPreview | null,
    fallbackSampleName: string | null = null,
  ): void {
    if (waveform) {
      waveformPanelElement.classList.add("is-active");
      waveformTitleElement.textContent = waveform.sampleName;
      waveformDurationElement.textContent =
        waveform.peaks.length > 0 ? formatDuration(waveform.durationSeconds) : "--:--";
      return;
    }

    if (fallbackSampleName) {
      waveformPanelElement.classList.add("is-active");
      waveformTitleElement.textContent = fallbackSampleName;
      waveformDurationElement.textContent = "--:--";
      return;
    }

    waveformPanelElement.classList.remove("is-active");
    waveformTitleElement.textContent = "No sample selected";
    waveformDurationElement.textContent = "--:--";
  }

  function applyDisplayedWaveform(waveform: WaveformPreview | null): void {
    displayedWaveform = waveform;
    displayedWaveformSignature = getWaveformSignature(waveform);
    drawWaveform(waveformBaseCanvasElement, displayedWaveform);
    renderWaveformMeta(displayedWaveform);
    syncPlayheadAnimation();
  }

  function stopWaveformSwapAnimation(): void {
    if (waveformSwapAnimation) {
      waveformSwapAnimation.cancel();
      waveformSwapAnimation = null;
    }

    waveformBaseCanvasElement.style.opacity = "1";
  }

  function runWaveformFade(
    keyframes: Keyframe[],
    duration: number,
    onFinish: () => void,
  ): void {
    waveformSwapAnimation = waveformBaseCanvasElement.animate(keyframes, {
      duration,
      easing: WAVEFORM_SWAP_EASING,
      fill: "forwards",
    });
    waveformSwapAnimation.addEventListener("finish", () => {
      waveformSwapAnimation = null;
      onFinish();
    });
  }

  function animateWaveformSwap(nextWaveform: WaveformPreview): void {
    stopWaveformSwapAnimation();
    pendingWaveformSignature = getWaveformSignature(nextWaveform);

    if (
      typeof waveformBaseCanvasElement.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      pendingWaveformSignature = null;
      applyDisplayedWaveform(nextWaveform);
      return;
    }

    if (displayedWaveform === null) {
      waveformBaseCanvasElement.style.opacity = "0";
      applyDisplayedWaveform(nextWaveform);
      runWaveformFade(
        [{ opacity: 0 }, { opacity: 1 }],
        WAVEFORM_SWAP_ANIMATION_MS,
        () => {
          pendingWaveformSignature = null;
          waveformBaseCanvasElement.style.opacity = "1";
        },
      );
      return;
    }

    const halfDuration = Math.max(80, Math.round(WAVEFORM_SWAP_ANIMATION_MS / 2));
    runWaveformFade(
      [{ opacity: 1 }, { opacity: 0 }],
      halfDuration,
      () => {
        waveformBaseCanvasElement.style.opacity = "0";
        applyDisplayedWaveform(nextWaveform);
        runWaveformFade(
          [{ opacity: 0 }, { opacity: 1 }],
          halfDuration,
          () => {
            pendingWaveformSignature = null;
            waveformBaseCanvasElement.style.opacity = "1";
          },
        );
      },
    );
  }

  function commitDisplayedWaveform(waveform: WaveformPreview | null): void {
    const nextSignature = getWaveformSignature(waveform);

    if (nextSignature === displayedWaveformSignature) {
      applyDisplayedWaveform(waveform);
      return;
    }

    if (waveform) {
      if (nextSignature !== pendingWaveformSignature) {
        animateWaveformSwap(waveform);
      }
      return;
    }

    pendingWaveformSignature = null;
    applyDisplayedWaveform(null);
    stopWaveformSwapAnimation();
  }

  for (const input of themeOptionInputs) {
    input.addEventListener("change", (event) => {
      const target = event.currentTarget as HTMLInputElement;

      if (!target.checked || !isThemeKey(target.value)) {
        return;
      }

      setTheme(target.value);
    });
  }

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

  resetAssignmentsButton.addEventListener("click", () => {
    const shouldReset = window.confirm(
      "Reset all assignments? This action cannot be undone.",
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

  const handleWindowKeydown = (event: KeyboardEvent): void => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isEditableTarget(event.target)
    ) {
      return;
    }

    let handled = false;

    if (event.key === "ArrowLeft") {
      handled = triggerToolbarButton(randomSampleButton);
    } else if (event.key === "ArrowUp") {
      handled = triggerToolbarButton(previousSelectedButton);
    } else if (event.code === "Space" || event.key === " ") {
      handled = triggerToolbarButton(playSelectedButton);
    } else if (event.key === "ArrowDown") {
      handled = triggerToolbarButton(nextSelectedButton);
    } else if (event.key === "Enter") {
      handled = triggerToolbarButton(writeSelectedButton);
    }

    if (handled) {
      event.preventDefault();
    }
  };

  window.addEventListener("keydown", handleWindowKeydown);

  resultsBodyElement.addEventListener("scroll", () => {
    if (!virtualListMounted || virtualSamples.length === 0) {
      return;
    }

    scheduleVirtualRowsRender();
  });

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
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
      resetAssignmentsButton.disabled =
        state.isScanning ||
        state.currentDirectoryId === null ||
        !hasAssignments;
      const randomCandidateCount = state.showAssignedOnly
        ? state.filteredSamples.length
        : state.filteredSamples.filter((sample) => sample.slotNumber === null).length;
      randomSampleButton.disabled =
        state.isScanning ||
        state.currentDirectoryId === null ||
        randomCandidateCount === 0;
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
        ? "Stop playback for the selected sample (Space)"
        : "Start or stop playback for the selected sample (Space)";
      writeSelectedButton.disabled = !canUseSelectedSampleActions;
      writeSelectedButton.dataset.mode = removeSelectedAssignment ? "remove" : "write";
      writeSelectedButton.classList.toggle("is-write", !removeSelectedAssignment);
      writeSelectedButton.classList.toggle("is-remove", removeSelectedAssignment);
      writeSelectedButtonLabelElement.textContent = removeSelectedAssignment
        ? "Remove"
        : "Write";
      writeSelectedButton.title = removeSelectedAssignment
        ? "Remove the selected sample assignment and close the gap in this segment (Enter)."
        : "Assign the selected sample to the next free slot in the active segment (Enter).";

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
        ? "Search is paused while only assigned samples are shown."
        : "";
      assignedOnlyInputElement.checked = state.showAssignedOnly;
      assignedSizeElement.textContent = `Assigned ${formatMegabytes(
        state.samples.reduce(
          (total, sample) => total + (sample.slotNumber !== null ? sample.size : 0),
          0,
        ),
      )}`;
      loopToggleInput.checked = state.loopEnabled;
      autoplayToggleInput.checked = state.autoplayEnabled;

      statusElement.textContent = formatStatus(state);
      countElement.textContent =
        state.isScanning && state.scanProgress
          ? state.scanProgress.phase === "counting"
            ? `${state.scanProgress.discoveredSampleCount.toLocaleString(
                "en-US",
              )} samples found`
            : `${formatProgressCount(
                state.scanProgress.scannedSampleCount,
                state.scanProgress.totalSampleCount,
              )} samples`
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

      if (!state.error && state.success) {
        successElement.hidden = false;
        successElement.textContent = state.success;
      } else {
        successElement.hidden = true;
        successElement.textContent = "";
      }

      const readyWaveform =
        state.currentWaveform && state.currentWaveform.peaks.length > 0
          ? state.currentWaveform
          : null;

      if (readyWaveform) {
        commitDisplayedWaveform(readyWaveform);
      } else if (!state.currentWaveform) {
        commitDisplayedWaveform(null);
      } else if (displayedWaveform === null) {
        drawWaveform(waveformBaseCanvasElement, null);
      }

      renderWaveformMeta(
        displayedWaveform,
        displayedWaveform === null ? state.currentWaveform?.sampleName ?? null : null,
      );

      latestSelectedSampleId = state.selectedSampleId;
      latestCurrentAudioId = state.currentAudioId;
      latestWaveform = state.currentWaveform;
      syncPlayheadAnimation();
      renderSlotMatrix(state);

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
          ? "No matching samples found."
          : "Choose a local sample folder to start the first scan.";
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
    destroy() {
      clearVirtualRenderFrame();
      stopPlayheadAnimation();
      stopWaveformSwapAnimation();
      resizeObserver?.disconnect();
      resizeObserver = null;
      window.removeEventListener("keydown", handleWindowKeydown);
    },
  };
}
