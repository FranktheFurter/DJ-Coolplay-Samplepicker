import { AudioPreviewController } from "./audioPreview";
import { isBrowserAudioExtensionSupported } from "./audioSupport";
import {
  getCurrentDirectory,
  getSamplesForDirectory,
  replaceSamplesForDirectory,
  saveDirectory,
  updateSampleSlotNumber,
  updateSampleSlotNumbers,
} from "./db";
import {
  buildSampleRecordId,
  createPersistedDirectory,
  getFileFromRelativePath,
  isFileSystemAccessSupported,
  scanDirectory,
} from "./fileScanner";
import { filterSamples } from "./search";
import { isSupportedSampleExtension } from "./sampleFormats";
import { createAppStore, initialAppState } from "./state";
import "./styles.css";
import type {
  AppState,
  ExportAssignmentsRequest,
  PersistedDirectory,
  SampleRecord,
} from "./types";
import { createUI } from "./ui";
import { createWaveformPreview } from "./waveform";

const store = createAppStore(initialAppState);
const audioPreview = new AudioPreviewController((sampleId) => {
  commitState({ currentAudioId: sampleId });
});

let activeDirectory: PersistedDirectory | null = null;
let waveformRequestToken = 0;
let lastSelectedSampleId: string | null = null;
let activeScanRunId = 0;
let directoryContextVersion = 0;
const MIN_SLOT_NUMBER = 1;
const MAX_SLOT_NUMBER = 999;
const EXPORT_FOLDER_PREFIX = "sample-picker-export";

function sanitizeFileSystemName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
}

function padSlotNumber(slotNumber: number): string {
  return String(slotNumber).padStart(3, "0");
}

function clampSlotCounter(slotNumber: number): number {
  if (!Number.isFinite(slotNumber)) {
    return MIN_SLOT_NUMBER;
  }

  return Math.min(MAX_SLOT_NUMBER, Math.max(MIN_SLOT_NUMBER, Math.round(slotNumber)));
}

function createNextDirectoryContextVersion(): number {
  directoryContextVersion += 1;
  return directoryContextVersion;
}

function getAssignedSlotsInRange(
  samples: SampleRecord[],
  rangeStart: number,
  rangeEnd: number,
): { assignedSlots: Set<number>; start: number; end: number } {
  const start = clampSlotCounter(Math.min(rangeStart, rangeEnd));
  const end = clampSlotCounter(Math.max(rangeStart, rangeEnd));
  const assignedInRange = new Set<number>();

  for (const sample of samples) {
    if (sample.slotNumber === null) {
      continue;
    }

    if (sample.slotNumber < start || sample.slotNumber > end) {
      continue;
    }

    assignedInRange.add(sample.slotNumber);
  }

  return {
    assignedSlots: assignedInRange,
    start,
    end,
  };
}

function findFirstFreeSlot(
  assignedSlots: Set<number>,
  start: number,
  end: number,
): number | null {
  for (let slotNumber = start; slotNumber <= end; slotNumber += 1) {
    if (!assignedSlots.has(slotNumber)) {
      return slotNumber;
    }
  }

  return null;
}

function getFirstFreeSlotInRange(
  samples: SampleRecord[],
  rangeStart: number,
  rangeEnd: number,
): number | null {
  const { assignedSlots, start, end } = getAssignedSlotsInRange(
    samples,
    rangeStart,
    rangeEnd,
  );

  return findFirstFreeSlot(assignedSlots, start, end);
}

function getSlotCategoryRange(slotNumber: number): { start: number; end: number } {
  const clampedSlotNumber = clampSlotCounter(slotNumber);

  if (clampedSlotNumber <= 99) {
    return { start: 1, end: 99 };
  }

  const start = Math.floor(clampedSlotNumber / 100) * 100;

  return {
    start,
    end: Math.min(MAX_SLOT_NUMBER, start + 99),
  };
}

function normalizeActiveSlotRangeStart(slotNumber: number): number {
  return getSlotCategoryRange(slotNumber).start;
}

function getActiveSlotMetrics(
  samples: SampleRecord[],
  activeSlotRangeStart: number,
): { rangeStart: number; rangeEnd: number; assignedCount: number; nextFreeSlot: number | null } {
  const { start: categoryRangeStart, end: categoryRangeEnd } =
    getSlotCategoryRange(activeSlotRangeStart);
  const { assignedSlots, start, end } = getAssignedSlotsInRange(
    samples,
    categoryRangeStart,
    categoryRangeEnd,
  );

  return {
    rangeStart: start,
    rangeEnd: end,
    assignedCount: assignedSlots.size,
    nextFreeSlot: findFirstFreeSlot(assignedSlots, start, end),
  };
}

function removeSampleSlotAndCompact(
  samples: SampleRecord[],
  sampleId: string,
): {
  nextSamples: SampleRecord[];
  activeSlotRangeStart: number;
  updates: Array<{ sampleId: string; slotNumber: number | null }>;
} | null {
  const sample = samples.find((entry) => entry.id === sampleId);

  if (!sample || sample.slotNumber === null) {
    return null;
  }

  const removedSlotNumber = sample.slotNumber;
  const { start, end } = getSlotCategoryRange(removedSlotNumber);
  const updates: Array<{ sampleId: string; slotNumber: number | null }> = [];
  const nextSamples = samples.map((entry) => {
    if (entry.slotNumber === null || entry.slotNumber < start || entry.slotNumber > end) {
      return entry;
    }

    if (entry.id === sampleId) {
      updates.push({ sampleId: entry.id, slotNumber: null });
      return { ...entry, slotNumber: null };
    }

    if (entry.slotNumber > removedSlotNumber) {
      const slotNumber = entry.slotNumber - 1;
      updates.push({ sampleId: entry.id, slotNumber });
      return { ...entry, slotNumber };
    }

    return entry;
  });

  return {
    nextSamples,
    activeSlotRangeStart: start,
    updates,
  };
}

function deriveState(nextState: AppState): AppState {
  const previousState = store.getState();
  const shouldRecomputeFilteredSamples =
    nextState.samples !== previousState.samples ||
    nextState.query !== previousState.query ||
    nextState.showAssignedOnly !== previousState.showAssignedOnly;
  const filteredSamples = shouldRecomputeFilteredSamples
    ? filterSamples(
        nextState.samples,
        nextState.query,
        nextState.showAssignedOnly,
      )
    : previousState.filteredSamples;
  let selectedSampleId = nextState.selectedSampleId;

  if (filteredSamples.length === 0) {
    selectedSampleId = null;
  } else if (!selectedSampleId) {
    selectedSampleId = filteredSamples[0].id;
  } else if (
    shouldRecomputeFilteredSamples &&
    !filteredSamples.some((sample) => sample.id === selectedSampleId)
  ) {
    selectedSampleId = filteredSamples[0].id;
  }

  const activeSlotRangeStart = normalizeActiveSlotRangeStart(
    nextState.activeSlotRangeStart,
  );
  const activeSlotMetrics = getActiveSlotMetrics(
    nextState.samples,
    activeSlotRangeStart,
  );

  return {
    ...nextState,
    filteredSamples,
    selectedSampleId,
    activeSlotAssignedCount: activeSlotMetrics.assignedCount,
    activeSlotRangeStart,
  };
}

function commitState(patch: Partial<AppState>): void {
  const preserveSuccess = Object.prototype.hasOwnProperty.call(patch, "success");
  const normalizedPatch = preserveSuccess ? patch : { ...patch, success: null };
  const nextState = deriveState({
    ...store.getState(),
    ...normalizedPatch,
  });

  store.setState(nextState);
}

async function ensureDirectoryPermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "read",
): Promise<boolean> {
  const options = { mode } as const;
  const currentPermission = await handle.queryPermission(options);

  if (currentPermission === "granted") {
    return true;
  }

  return (await handle.requestPermission(options)) === "granted";
}

async function ensureReadPermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  return ensureDirectoryPermission(handle, "read");
}

function buildSlotMap(samples: SampleRecord[]): Map<string, number> {
  return new Map(
    samples
      .filter((sample) => sample.slotNumber !== null)
      .map((sample) => [sample.relativePath, sample.slotNumber!]),
  );
}

function filterSupportedSamples(samples: SampleRecord[]): SampleRecord[] {
  return samples.filter((sample) => isSupportedSampleExtension(sample.extension));
}

async function loadWaveformForSelection(sampleId: string | null): Promise<void> {
  const token = ++waveformRequestToken;

  if (!sampleId || !activeDirectory) {
    commitState({ currentWaveform: null });
    return;
  }

  const sample = store.getState().samples.find((entry) => entry.id === sampleId);

  if (!sample) {
    commitState({ currentWaveform: null });
    return;
  }

  if (!isBrowserAudioExtensionSupported(sample.extension)) {
    commitState({
      currentWaveform: null,
      error: null,
    });
    return;
  }

  commitState({
    currentWaveform: {
      sampleId: sample.id,
      sampleName: sample.name,
      durationSeconds: 0,
      peaks: [],
    },
  });

  try {
    const hasPermission = await ensureReadPermission(activeDirectory.handle);

    if (!hasPermission) {
      throw new Error("Read permission for the waveform was denied.");
    }

    const file = await getFileFromRelativePath(
      activeDirectory.handle,
      sample.relativePath,
    );
    const waveform = await createWaveformPreview(sample.id, sample.name, file);

    if (token !== waveformRequestToken) {
      return;
    }

    commitState({ currentWaveform: waveform });
  } catch (error) {
    if (token !== waveformRequestToken) {
      return;
    }

    const isUnsupportedDecodeError =
      (error instanceof DOMException && error.name === "EncodingError") ||
      (error instanceof Error &&
        error.message.toLowerCase().includes("decode audio data"));

    commitState({
      currentWaveform: null,
      error:
        isUnsupportedDecodeError
          ? null
          : error instanceof Error
            ? error.message
            : "Waveform could not be loaded.",
    });
  }
}

async function runScan(directory: PersistedDirectory): Promise<void> {
  const scanRunId = ++activeScanRunId;
  const previousState = store.getState();
  const isDirectorySwitch = previousState.currentDirectoryId !== directory.id;

  commitState({
    currentDirectoryId: directory.id,
    currentDirectoryName: directory.name,
    isScanning: true,
    scanProgress: {
      phase: "counting",
      discoveredSampleCount: 0,
      totalSampleCount: null,
      scannedSampleCount: 0,
      elapsedMs: 0,
      estimatedRemainingMs: null,
      currentPath: null,
    },
    samples: isDirectorySwitch ? [] : previousState.samples,
    error: null,
  });

  try {
    const hasPermission = await ensureReadPermission(directory.handle);

    if (!hasPermission) {
      throw new Error("Read permission for the folder was not granted.");
    }

    const previousSamples = filterSupportedSamples(
      await getSamplesForDirectory(directory.id),
    );
    const slotMap = buildSlotMap(previousSamples);
    const scannedSamples = await scanDirectory(
      directory.handle,
      directory.id,
      (scanProgress) => {
        if (scanRunId !== activeScanRunId) {
          return;
        }

        commitState({
          scanProgress,
          error: null,
        });
      },
    );

    if (scanRunId !== activeScanRunId) {
      return;
    }

    const mergedSamples = scannedSamples.map((sample) => ({
      ...sample,
      slotNumber: slotMap.get(sample.relativePath) ?? null,
    }));

    await replaceSamplesForDirectory(directory.id, mergedSamples);

    if (scanRunId !== activeScanRunId) {
      return;
    }

    commitState({
      samples: mergedSamples,
      isScanning: false,
      scanProgress: null,
      lastScanAt: Date.now(),
      error: null,
    });
  } catch (error) {
    if (scanRunId !== activeScanRunId) {
      return;
    }

    commitState({
      isScanning: false,
      scanProgress: null,
      error:
        error instanceof Error
          ? error.message
          : "Unknown error while scanning.",
    });
  }
}

async function hydrateFromIndexedDb(): Promise<void> {
  const hydrationDirectoryContextVersion = directoryContextVersion;

  try {
    const directory = await getCurrentDirectory();

    if (!directory) {
      return;
    }

    if (hydrationDirectoryContextVersion !== directoryContextVersion) {
      return;
    }

    const persistedSamples = await getSamplesForDirectory(directory.id);
    const samples = filterSupportedSamples(persistedSamples).map((sample) => ({
      ...sample,
      id: buildSampleRecordId(sample.directoryId, sample.relativePath),
    }));

    const shouldRewriteSamples =
      samples.length !== persistedSamples.length ||
      samples.some((sample, index) => sample.id !== persistedSamples[index]?.id);

    if (shouldRewriteSamples) {
      await replaceSamplesForDirectory(directory.id, samples);
    }

    if (hydrationDirectoryContextVersion !== directoryContextVersion) {
      return;
    }

    activeDirectory = directory;

    commitState({
      currentDirectoryId: directory.id,
      currentDirectoryName: directory.name,
      samples,
      error: null,
    });
  } catch (error) {
    commitState({
      error:
        error instanceof Error
          ? error.message
          : "Could not load saved data.",
    });
  }
}

async function handlePickDirectory(): Promise<void> {
  if (!isFileSystemAccessSupported()) {
    commitState({
      error:
        "This browser does not support the File System Access API well enough.",
    });
    return;
  }

  try {
    const handle = await window.showDirectoryPicker();
    const directory = createPersistedDirectory(handle);
    createNextDirectoryContextVersion();

    audioPreview.stop();
    activeDirectory = directory;

    await saveDirectory(directory);
    await runScan(directory);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }

    commitState({
      error:
        error instanceof Error
          ? error.message
          : "Folder selection failed.",
    });
  }
}

async function handleRefreshScan(): Promise<void> {
  if (!activeDirectory) {
    return;
  }

  audioPreview.stop();
  await runScan(activeDirectory);
}

async function handleResetAssignments(): Promise<void> {
  const previousState = store.getState();

  if (!previousState.currentDirectoryId) {
    return;
  }

  if (!previousState.samples.some((sample) => sample.slotNumber !== null)) {
    return;
  }

  const nextSamples = previousState.samples.map((sample) =>
    sample.slotNumber === null ? sample : { ...sample, slotNumber: null },
  );

  commitState({
    samples: nextSamples,
    error: null,
  });

  try {
    await replaceSamplesForDirectory(previousState.currentDirectoryId, nextSamples);
  } catch (error) {
    commitState({
      samples: previousState.samples,
      error:
        error instanceof Error
          ? error.message
          : "Could not reset assignments.",
    });
  }
}

function buildExportFolderName(
  label: string,
  rangeStart: number,
  rangeEnd: number,
): string {
  const sanitizedLabel = sanitizeFileSystemName(label);

  if (sanitizedLabel.length > 0) {
    return sanitizedLabel;
  }

  return `Slots ${padSlotNumber(rangeStart)}-${padSlotNumber(rangeEnd)}`;
}

function resolveExportCategoryLabel(
  slotNumber: number,
  request: ExportAssignmentsRequest,
): string {
  for (const category of request.categories) {
    const rangeStart = Math.min(category.rangeStart, category.rangeEnd);
    const rangeEnd = Math.max(category.rangeStart, category.rangeEnd);

    if (slotNumber >= rangeStart && slotNumber <= rangeEnd) {
      return buildExportFolderName(category.label, rangeStart, rangeEnd);
    }
  }

  return "Unsorted";
}

async function writeExportFile(
  exportRootHandle: FileSystemDirectoryHandle,
  folderName: string,
  slotNumber: number,
  file: File,
): Promise<void> {
  const folderHandle = await exportRootHandle.getDirectoryHandle(folderName, {
    create: true,
  });
  const baseFileName = file.name.toLowerCase().endsWith(".wav")
    ? file.name.slice(0, -4)
    : file.name;
  const sanitizedBaseName = sanitizeFileSystemName(baseFileName) || "sample";
  const exportFileHandle = await folderHandle.getFileHandle(
    `${padSlotNumber(slotNumber)} - ${sanitizedBaseName}.wav`,
    { create: true },
  );
  const writable = await exportFileHandle.createWritable();
  await writable.write(file);
  await writable.close();
}

async function handleExportAssignments(
  request: ExportAssignmentsRequest,
): Promise<void> {
  const state = store.getState();
  const assignedSamples = [...state.samples]
    .filter((sample) => sample.slotNumber !== null)
    .sort((left, right) => {
      const slotDiff = (left.slotNumber ?? 0) - (right.slotNumber ?? 0);

      if (slotDiff !== 0) {
        return slotDiff;
      }

      return left.normalizedName.localeCompare(right.normalizedName);
    });

  if (assignedSamples.length === 0) {
    commitState({ error: "No assignments available for export." });
    return;
  }

  if (!activeDirectory) {
    commitState({ error: "No sample folder selected for export." });
    return;
  }

  try {
    const hasReadPermission = await ensureReadPermission(activeDirectory.handle);

    if (!hasReadPermission) {
      throw new Error("Read permission for the sample folder was denied.");
    }

    const destinationHandle = await window.showDirectoryPicker();
    const hasWritePermission = await ensureDirectoryPermission(
      destinationHandle,
      "readwrite",
    );

    if (!hasWritePermission) {
      throw new Error("Write permission for the export folder was denied.");
    }

    const exportFolderHandle = await destinationHandle.getDirectoryHandle(
      `${EXPORT_FOLDER_PREFIX}-${new Date()
        .toISOString()
        .replaceAll(":", "-")
        .replaceAll(".", "-")}`,
      { create: true },
    );
    for (const sample of assignedSamples) {
      const slotNumber = sample.slotNumber;

      if (slotNumber === null) {
        continue;
      }

      const folderName = resolveExportCategoryLabel(slotNumber, request);
      const file = await getFileFromRelativePath(
        activeDirectory.handle,
        sample.relativePath,
      );
      await writeExportFile(exportFolderHandle, folderName, slotNumber, file);
    }

    commitState({
      success: `Export complete: ${assignedSamples.length} samples were written as WAV files to the destination folder.`,
      error: null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }

    commitState({
      error:
        error instanceof Error
          ? error.message
          : "Folder export failed.",
    });
  }
}

function handleSearchChange(query: string): void {
  commitState({ query });
}

function handleAssignedOnlyChange(showAssignedOnly: boolean): void {
  commitState({
    showAssignedOnly,
    query: showAssignedOnly ? "" : store.getState().query,
  });
}

function handleSlotCategoryActivate(rangeStart: number, rangeEnd: number): void {
  commitState({
    activeSlotRangeStart: normalizeActiveSlotRangeStart(
      Math.min(rangeStart, rangeEnd),
    ),
  });
}

function handleLoopEnabledChange(loopEnabled: boolean): void {
  audioPreview.setLoopEnabled(loopEnabled);
  commitState({ loopEnabled });
}

function handleAutoplayEnabledChange(autoplayEnabled: boolean): void {
  commitState({ autoplayEnabled });
}

function handleSelectSample(sampleId: string): void {
  const state = store.getState();
  const targetSample = state.samples.find((entry) => entry.id === sampleId);

  if (!targetSample) {
    return;
  }

  if (state.selectedSampleId === sampleId) {
    return;
  }

  const shouldKeepAutoplayPlaybackState =
    state.autoplayEnabled &&
    state.currentAudioId !== null &&
    state.currentAudioId !== sampleId &&
    isBrowserAudioExtensionSupported(targetSample.extension);

  if (
    state.currentAudioId &&
    state.currentAudioId !== sampleId &&
    !shouldKeepAutoplayPlaybackState
  ) {
    audioPreview.stop();
  }

  const nextPatch: Partial<AppState> = {
    selectedSampleId: sampleId,
  };

  if (state.showAssignedOnly && targetSample.slotNumber !== null) {
    nextPatch.activeSlotRangeStart = normalizeActiveSlotRangeStart(
      targetSample.slotNumber,
    );
  }

  if (shouldKeepAutoplayPlaybackState) {
    nextPatch.currentAudioId = sampleId;
  }

  commitState(nextPatch);
}

function handleSelectRandomSample(): string | null {
  const state = store.getState();
  const candidates = state.showAssignedOnly
    ? state.filteredSamples
    : state.filteredSamples.filter((sample) => sample.slotNumber === null);

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    commitState({ error: null });
    handleSelectSample(candidates[0].id);
    return candidates[0].id;
  }

  const currentSelectedSampleId = state.selectedSampleId;
  const pool =
    currentSelectedSampleId === null
      ? candidates
      : candidates.filter((sample) => sample.id !== currentSelectedSampleId);
  const effectivePool = pool.length > 0 ? pool : candidates;
  const randomIndex = Math.floor(Math.random() * effectivePool.length);
  const randomSample = effectivePool[randomIndex];

  if (!randomSample) {
    return null;
  }

  commitState({ error: null });
  handleSelectSample(randomSample.id);
  return randomSample.id;
}

function getRelativeSelectedSampleId(step: -1 | 1): string | null {
  const state = store.getState();
  const candidates = state.filteredSamples;

  if (candidates.length === 0) {
    return null;
  }

  if (state.selectedSampleId === null) {
    return candidates[0].id;
  }

  const currentIndex = candidates.findIndex(
    (sample) => sample.id === state.selectedSampleId,
  );

  if (currentIndex === -1) {
    return candidates[0].id;
  }

  const nextIndex = Math.max(
    0,
    Math.min(candidates.length - 1, currentIndex + step),
  );

  return candidates[nextIndex]?.id ?? null;
}

function handleSelectPreviousSample(): string | null {
  const previousSampleId = getRelativeSelectedSampleId(-1);

  if (!previousSampleId) {
    return null;
  }

  handleSelectSample(previousSampleId);
  return previousSampleId;
}

function handleSelectNextSample(): string | null {
  const nextSampleId = getRelativeSelectedSampleId(1);

  if (!nextSampleId) {
    return null;
  }

  handleSelectSample(nextSampleId);
  return nextSampleId;
}

function handlePlaybackProgress(
  sampleId: string,
  fallbackDurationSeconds: number,
): number | null {
  return audioPreview.getPlayheadProgress(sampleId, fallbackDurationSeconds);
}

async function handleWriteSample(sampleId: string): Promise<void> {
  const previousState = store.getState();
  const previousSamples = previousState.samples;
  const sample = previousSamples.find((entry) => entry.id === sampleId);

  if (!sample) {
    return;
  }

  const activeSlotMetrics = getActiveSlotMetrics(
    previousSamples,
    previousState.activeSlotRangeStart,
  );
  const nextSlotNumber = activeSlotMetrics.nextFreeSlot;

  if (nextSlotNumber === null) {
    commitState({
      error: "This segment is already full.",
    });
    return;
  }

  const nextSamples = previousSamples.map((entry) =>
    entry.id === sampleId
      ? { ...entry, slotNumber: nextSlotNumber }
      : entry,
  );

  commitState({
    samples: nextSamples,
    error: null,
  });

  try {
    await updateSampleSlotNumber(sampleId, nextSlotNumber);
  } catch (error) {
    commitState({
      samples: previousSamples,
      error:
        error instanceof Error
          ? error.message
          : "Could not save the slot assignment.",
    });
  }
}

async function handleRemoveSample(sampleId: string): Promise<void> {
  const previousState = store.getState();

  if (!previousState.currentDirectoryId) {
    return;
  }

  const removal = removeSampleSlotAndCompact(previousState.samples, sampleId);

  if (!removal) {
    return;
  }

  commitState({
    samples: removal.nextSamples,
    activeSlotRangeStart: removal.activeSlotRangeStart,
    error: null,
  });

  try {
    await updateSampleSlotNumbers(removal.updates);
  } catch (error) {
    commitState({
      samples: previousState.samples,
      error:
        error instanceof Error
          ? error.message
          : "Could not remove the slot assignment.",
    });
  }
}

async function handleWriteSelectedSample(): Promise<void> {
  const selectedSampleId = store.getState().selectedSampleId;

  if (!selectedSampleId) {
    return;
  }

  await handleWriteSample(selectedSampleId);
}

async function handleRemoveSelectedSample(): Promise<void> {
  const selectedSampleId = store.getState().selectedSampleId;

  if (!selectedSampleId) {
    return;
  }

  await handleRemoveSample(selectedSampleId);
}

async function playSample(
  sampleId: string,
  mode: "toggle" | "once" | "autoplay",
): Promise<void> {
  if (!activeDirectory) {
    return;
  }

  const sample = store.getState().samples.find((entry) => entry.id === sampleId);

  if (!sample) {
    return;
  }

  handleSelectSample(sample.id);

  if (!isBrowserAudioExtensionSupported(sample.extension)) {
    if (mode !== "autoplay") {
      commitState({
        currentAudioId: null,
        error: `Audio preview for .${sample.extension} is not supported by this browser.`,
      });
    }
    return;
  }

  try {
    const hasPermission = await ensureReadPermission(activeDirectory.handle);

    if (!hasPermission) {
      throw new Error("Read permission for audio preview was denied.");
    }

    if (mode === "once") {
      await audioPreview.playOnce(
        {
          id: sample.id,
        },
        async () =>
          getFileFromRelativePath(activeDirectory!.handle, sample.relativePath),
      );
      return;
    }

    await audioPreview.toggle(
      {
        id: sample.id,
      },
      async () =>
        getFileFromRelativePath(activeDirectory!.handle, sample.relativePath),
    );
  } catch (error) {
    const isUnsupportedMediaError =
      (error instanceof DOMException && error.name === "NotSupportedError") ||
      (error instanceof Error &&
        error.message.toLowerCase().includes("no supported source"));

    commitState({
      currentAudioId: null,
      error:
        isUnsupportedMediaError
          ? `Audio preview for "${sample.name}" could not be played. The file format or codec is not supported by this browser.`
          : error instanceof Error
            ? error.message
            : "Audio preview could not be started.",
    });
  }
}

async function handleTogglePlay(sampleId: string): Promise<void> {
  await playSample(sampleId, "toggle");
}

async function handlePlaySelectedSample(): Promise<void> {
  const selectedSampleId = store.getState().selectedSampleId;

  if (!selectedSampleId) {
    return;
  }

  await playSample(selectedSampleId, "toggle");
}

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("App root #app was not found.");
}

const ui = createUI(appRoot, {
  onPickDirectory: handlePickDirectory,
  onExportAssignments: handleExportAssignments,
  onRefreshScan: handleRefreshScan,
  onResetAssignments: handleResetAssignments,
  onSelectRandomSample: handleSelectRandomSample,
  onSelectPreviousSample: handleSelectPreviousSample,
  onSelectNextSample: handleSelectNextSample,
  onPlaySelectedSample: handlePlaySelectedSample,
  onWriteSelectedSample: handleWriteSelectedSample,
  onRemoveSelectedSample: handleRemoveSelectedSample,
  onSearchChange: handleSearchChange,
  onAssignedOnlyChange: handleAssignedOnlyChange,
  onSlotCategoryActivate: handleSlotCategoryActivate,
  onLoopEnabledChange: handleLoopEnabledChange,
  onAutoplayEnabledChange: handleAutoplayEnabledChange,
  getPlaybackProgress: handlePlaybackProgress,
  onSelectSample: handleSelectSample,
  onWriteSample: handleWriteSample,
  onRemoveSample: handleRemoveSample,
  onTogglePlay: handleTogglePlay,
});

const unsubscribeStore = store.subscribe((state) => {
  ui.render(state);

  if (state.selectedSampleId !== lastSelectedSampleId) {
    lastSelectedSampleId = state.selectedSampleId;
    void loadWaveformForSelection(state.selectedSampleId);

    if (state.autoplayEnabled && state.selectedSampleId) {
      void playSample(state.selectedSampleId, "autoplay");
    }
  }
});

let appDestroyed = false;
const destroyApp = (): void => {
  if (appDestroyed) {
    return;
  }

  appDestroyed = true;
  unsubscribeStore();
  ui.destroy();
  audioPreview.stop();
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    destroyApp();
  });
}

commitState({
  error: isFileSystemAccessSupported()
    ? null
    : "Chrome or Edge on desktop is required for this MVP.",
});

void hydrateFromIndexedDb();
