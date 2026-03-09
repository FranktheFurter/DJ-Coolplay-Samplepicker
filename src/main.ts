import { AudioPreviewController } from "./audioPreview";
import { isBrowserAudioExtensionSupported } from "./audioSupport";
import {
  getCurrentDirectory,
  getSamplesForDirectory,
  replaceSamplesForDirectory,
  saveDirectory,
  updateSampleSlotNumber,
} from "./db";
import {
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
  PersistedDirectory,
  RandomizerRequest,
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
const MIN_SLOT_NUMBER = 1;
const MAX_SLOT_NUMBER = 999;
const RANDOMIZER_SLOTS_PER_CATEGORY = 50;

function clampRandomizerStepRatio(stepRatio: number): number {
  if (!Number.isFinite(stepRatio)) {
    return initialAppState.randomizerStepRatio;
  }

  return Math.max(0, Math.min(1, stepRatio));
}

function escapeCsvField(value: string): string {
  const escaped = value.replaceAll('"', '""');
  return `"${escaped}"`;
}

function toRandomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

function getRandomUnusedIndex(
  totalCount: number,
  usedIndices: Set<number>,
): number | null {
  const availableIndices: number[] = [];

  for (let index = 0; index < totalCount; index += 1) {
    if (!usedIndices.has(index)) {
      availableIndices.push(index);
    }
  }

  if (availableIndices.length === 0) {
    return null;
  }

  return availableIndices[toRandomInt(availableIndices.length)] ?? null;
}

function getNeighborIndex(
  previousIndex: number,
  totalCount: number,
  usedIndices: Set<number>,
): number | null {
  const candidates: number[] = [];
  const lowerIndex = previousIndex - 1;
  const upperIndex = previousIndex + 1;

  if (lowerIndex >= 0 && !usedIndices.has(lowerIndex)) {
    candidates.push(lowerIndex);
  }

  if (upperIndex < totalCount && !usedIndices.has(upperIndex)) {
    candidates.push(upperIndex);
  }

  if (candidates.length === 0) {
    return null;
  }

  return candidates[toRandomInt(candidates.length)] ?? null;
}

function clampSlotCounter(slotNumber: number): number {
  if (!Number.isFinite(slotNumber)) {
    return MIN_SLOT_NUMBER;
  }

  return Math.min(MAX_SLOT_NUMBER, Math.max(MIN_SLOT_NUMBER, Math.round(slotNumber)));
}

function getNextSlotInRange(
  samples: SampleRecord[],
  rangeStart: number,
  rangeEnd: number,
): number {
  const start = clampSlotCounter(Math.min(rangeStart, rangeEnd));
  const end = clampSlotCounter(Math.max(rangeStart, rangeEnd));
  const assignedInRange = new Set<number>();
  let highestAssigned = start - 1;

  for (const sample of samples) {
    if (sample.slotNumber === null) {
      continue;
    }

    if (sample.slotNumber < start || sample.slotNumber > end) {
      continue;
    }

    assignedInRange.add(sample.slotNumber);
    highestAssigned = Math.max(highestAssigned, sample.slotNumber);
  }

  const nextAfterHighest = highestAssigned + 1;

  if (nextAfterHighest <= end && !assignedInRange.has(nextAfterHighest)) {
    return nextAfterHighest;
  }

  for (let slotNumber = start; slotNumber <= end; slotNumber += 1) {
    if (!assignedInRange.has(slotNumber)) {
      return slotNumber;
    }
  }

  return end;
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

  return {
    ...nextState,
    filteredSamples,
    selectedSampleId,
  };
}

function commitState(patch: Partial<AppState>): void {
  const nextState = deriveState({
    ...store.getState(),
    ...patch,
  });

  store.setState(nextState);
}

async function ensureReadPermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const options = { mode: "read" } as const;
  const currentPermission = await handle.queryPermission(options);

  if (currentPermission === "granted") {
    return true;
  }

  return (await handle.requestPermission(options)) === "granted";
}

function buildSlotMap(samples: SampleRecord[]): Map<string, number> {
  return new Map(
    samples
      .filter((sample) => sample.slotNumber !== null)
      .map((sample) => [sample.relativePath.toLowerCase(), sample.slotNumber!]),
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
      throw new Error("Leseberechtigung fuer Waveform wurde verweigert.");
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
            : "Waveform konnte nicht geladen werden.",
    });
  }
}

async function runScan(directory: PersistedDirectory): Promise<void> {
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
      throw new Error("Leseberechtigung fuer den Ordner wurde nicht erteilt.");
    }

    const previousSamples = filterSupportedSamples(
      await getSamplesForDirectory(directory.id),
    );
    const slotMap = buildSlotMap(previousSamples);
    const scannedSamples = await scanDirectory(
      directory.handle,
      directory.id,
      (scanProgress) => {
        commitState({
          scanProgress,
          error: null,
        });
      },
    );

    const mergedSamples = scannedSamples.map((sample) => ({
      ...sample,
      slotNumber: slotMap.get(sample.relativePath.toLowerCase()) ?? null,
    }));

    await replaceSamplesForDirectory(directory.id, mergedSamples);

    commitState({
      samples: mergedSamples,
      isScanning: false,
      scanProgress: null,
      lastScanAt: Date.now(),
      error: null,
    });
  } catch (error) {
    commitState({
      isScanning: false,
      scanProgress: null,
      error:
        error instanceof Error
          ? error.message
          : "Unbekannter Fehler beim Scannen.",
    });
  }
}

async function hydrateFromIndexedDb(): Promise<void> {
  try {
    const directory = await getCurrentDirectory();

    if (!directory) {
      return;
    }

    activeDirectory = directory;

    const persistedSamples = await getSamplesForDirectory(directory.id);
    const samples = filterSupportedSamples(persistedSamples);

    if (samples.length !== persistedSamples.length) {
      await replaceSamplesForDirectory(directory.id, samples);
    }

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
          : "Konnte gespeicherte Daten nicht laden.",
    });
  }
}

async function handlePickDirectory(): Promise<void> {
  if (!isFileSystemAccessSupported()) {
    commitState({
      error:
        "Dieser Browser unterstuetzt die File System Access API nicht ausreichend.",
    });
    return;
  }

  try {
    const handle = await window.showDirectoryPicker();
    const directory = createPersistedDirectory(handle);

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
          : "Ordnerauswahl fehlgeschlagen.",
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
    slotCounter: MIN_SLOT_NUMBER,
    error: null,
  });

  try {
    await replaceSamplesForDirectory(previousState.currentDirectoryId, nextSamples);
  } catch (error) {
    commitState({
      samples: previousState.samples,
      slotCounter: previousState.slotCounter,
      error:
        error instanceof Error
          ? error.message
          : "Konnte Zuweisungen nicht zuruecksetzen.",
    });
  }
}

function handleExportAssignments(): void {
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
    commitState({ error: "Keine Zuweisungen fuer Export vorhanden." });
    return;
  }

  const rows = assignedSamples.map((sample) =>
    [String(sample.slotNumber ?? ""), sample.name, sample.relativePath]
      .map(escapeCsvField)
      .join(","),
  );
  const csv = [
    ["slotNumber", "sampleName", "relativePath"]
      .map(escapeCsvField)
      .join(","),
    ...rows,
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `sample-picker-export-${timestamp}.csv`;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
  commitState({ error: null });
}

function handleRandomizerStepRatioChange(stepRatio: number): void {
  commitState({ randomizerStepRatio: clampRandomizerStepRatio(stepRatio) });
}

async function handleRunRandomizer(request: RandomizerRequest): Promise<void> {
  const previousState = store.getState();

  if (!previousState.currentDirectoryId || previousState.samples.length === 0) {
    return;
  }

  const stepRatio = clampRandomizerStepRatio(request.stepRatio);
  const categories = request.categories ?? [];
  const baseSamples = previousState.samples.map((sample) =>
    sample.slotNumber === null ? sample : { ...sample, slotNumber: null },
  );
  const sampleById = new Map(baseSamples.map((sample) => [sample.id, sample]));
  const globallyAssignedSampleIds = new Set<string>();

  for (const category of categories) {
    const rangeStart = clampSlotCounter(
      Math.min(category.rangeStart, category.rangeEnd),
    );
    const rangeEnd = clampSlotCounter(Math.max(category.rangeStart, category.rangeEnd));
    const slotEnd = Math.min(
      rangeEnd,
      rangeStart + RANDOMIZER_SLOTS_PER_CATEGORY - 1,
    );

    if (slotEnd < rangeStart) {
      continue;
    }

    const categoryQuery = category.query.trim();
    const candidates = filterSamples(baseSamples, categoryQuery, false).filter(
      (sample) => !globallyAssignedSampleIds.has(sample.id),
    );

    if (candidates.length === 0) {
      continue;
    }

    const usedIndices = new Set<number>();
    let previousIndex: number | null = null;

    for (let slotNumber = rangeStart; slotNumber <= slotEnd; slotNumber += 1) {
      let nextIndex: number | null = null;

      if (previousIndex === null) {
        nextIndex = toRandomInt(candidates.length);
      } else if (Math.random() < stepRatio) {
        nextIndex = getNeighborIndex(previousIndex, candidates.length, usedIndices);
      }

      if (nextIndex === null || usedIndices.has(nextIndex)) {
        nextIndex = getRandomUnusedIndex(candidates.length, usedIndices);
      }

      if (nextIndex === null) {
        break;
      }

      const selectedSample = candidates[nextIndex];

      if (!selectedSample) {
        break;
      }

      usedIndices.add(nextIndex);
      previousIndex = nextIndex;
      globallyAssignedSampleIds.add(selectedSample.id);

      const sampleEntry = sampleById.get(selectedSample.id);

      if (!sampleEntry) {
        continue;
      }

      sampleEntry.slotNumber = slotNumber;
    }
  }

  commitState({
    samples: baseSamples,
    randomizerStepRatio: stepRatio,
    slotCounter: MIN_SLOT_NUMBER,
    error: null,
  });

  try {
    await replaceSamplesForDirectory(previousState.currentDirectoryId, baseSamples);
  } catch (error) {
    commitState({
      samples: previousState.samples,
      randomizerStepRatio: previousState.randomizerStepRatio,
      slotCounter: previousState.slotCounter,
      error:
        error instanceof Error
          ? error.message
          : "Randomizer-Zuweisungen konnten nicht gespeichert werden.",
    });
  }
}

function handleSearchChange(query: string): void {
  commitState({ query });
}

function handleAssignedOnlyChange(showAssignedOnly: boolean): void {
  commitState({ showAssignedOnly });

  if (!showAssignedOnly) {
    return;
  }

  const nextState = store.getState();
  const selectedSample =
    nextState.selectedSampleId === null
      ? null
      : nextState.samples.find((sample) => sample.id === nextState.selectedSampleId) ??
        null;
  const selectedSlotNumber = selectedSample?.slotNumber ?? null;

  if (selectedSlotNumber !== null && nextState.slotCounter !== selectedSlotNumber) {
    commitState({ slotCounter: selectedSlotNumber });
  }
}

function handleSlotCounterChange(slotNumber: number): void {
  commitState({ slotCounter: clampSlotCounter(slotNumber) });
}

function handleSlotCounterAdjust(delta: number): void {
  if (!Number.isFinite(delta) || delta === 0) {
    return;
  }

  const step = delta > 0 ? 1 : -1;
  const currentCounter = store.getState().slotCounter;
  handleSlotCounterChange(currentCounter + step);
}

function handleSlotCategoryActivate(rangeStart: number, rangeEnd: number): void {
  const slotCounter = getNextSlotInRange(
    store.getState().samples,
    rangeStart,
    rangeEnd,
  );
  commitState({ slotCounter });
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

  const shouldSnapCounterToSelection =
    state.showAssignedOnly &&
    targetSample.slotNumber !== null &&
    state.slotCounter !== targetSample.slotNumber;

  if (state.selectedSampleId === sampleId) {
    if (shouldSnapCounterToSelection && targetSample.slotNumber !== null) {
      commitState({ slotCounter: targetSample.slotNumber });
    }
    return;
  }

  if (state.currentAudioId && state.currentAudioId !== sampleId) {
    audioPreview.stop();
  }

  const nextPatch: Partial<AppState> = {
    selectedSampleId: sampleId,
  };

  if (shouldSnapCounterToSelection && targetSample.slotNumber !== null) {
    nextPatch.slotCounter = targetSample.slotNumber;
  }

  commitState(nextPatch);
}

function handleSelectRandomSample(): string | null {
  const state = store.getState();
  const candidates = state.filteredSamples;

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    handleSelectSample(candidates[0].id);
    return candidates[0].id;
  }

  const currentSelectedSampleId = state.selectedSampleId;
  const pool =
    currentSelectedSampleId === null
      ? candidates
      : candidates.filter((sample) => sample.id !== currentSelectedSampleId);
  const randomIndex = Math.floor(Math.random() * pool.length);
  const randomSample = pool[randomIndex];

  if (!randomSample) {
    return null;
  }

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
  const nextSlotNumber = previousState.slotCounter;
  const sample = previousSamples.find((entry) => entry.id === sampleId);

  if (!sample) {
    return;
  }

  const conflictingSampleId =
    previousSamples.find(
      (entry) => entry.id !== sampleId && entry.slotNumber === nextSlotNumber,
    )?.id ?? null;

  const nextSamples = previousSamples.map((entry) =>
    entry.id === sampleId
      ? { ...entry, slotNumber: nextSlotNumber }
      : conflictingSampleId !== null && entry.id === conflictingSampleId
        ? { ...entry, slotNumber: null }
        : entry,
  );

  commitState({
    samples: nextSamples,
    slotCounter: clampSlotCounter(nextSlotNumber + 1),
    error: null,
  });

  try {
    await updateSampleSlotNumber(sampleId, nextSlotNumber);

    if (conflictingSampleId !== null) {
      await updateSampleSlotNumber(conflictingSampleId, null);
    }
  } catch (error) {
    commitState({
      samples: previousSamples,
      slotCounter: previousState.slotCounter,
      error:
        error instanceof Error
          ? error.message
          : "Konnte Slot-Zuweisung nicht speichern.",
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
        error: `Audio-Preview fuer .${sample.extension} wird von diesem Browser nicht unterstuetzt.`,
      });
    }
    return;
  }

  try {
    const hasPermission = await ensureReadPermission(activeDirectory.handle);

    if (!hasPermission) {
      throw new Error("Leseberechtigung fuer Audio-Preview wurde verweigert.");
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
          ? `Audio-Preview fuer "${sample.name}" kann nicht abgespielt werden. Dateiformat oder Codec werden vom Browser nicht unterstuetzt.`
          : error instanceof Error
            ? error.message
            : "Audio-Preview konnte nicht gestartet werden.",
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

  await playSample(selectedSampleId, "once");
}

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("App-Root #app wurde nicht gefunden.");
}

const ui = createUI(appRoot, {
  onPickDirectory: handlePickDirectory,
  onExportAssignments: handleExportAssignments,
  onRefreshScan: handleRefreshScan,
  onResetAssignments: handleResetAssignments,
  onRunRandomizer: handleRunRandomizer,
  onRandomizerStepRatioChange: handleRandomizerStepRatioChange,
  onSelectRandomSample: handleSelectRandomSample,
  onSelectPreviousSample: handleSelectPreviousSample,
  onSelectNextSample: handleSelectNextSample,
  onPlaySelectedSample: handlePlaySelectedSample,
  onWriteSelectedSample: handleWriteSelectedSample,
  onSearchChange: handleSearchChange,
  onAssignedOnlyChange: handleAssignedOnlyChange,
  onSlotCounterChange: handleSlotCounterChange,
  onSlotCounterAdjust: handleSlotCounterAdjust,
  onSlotCategoryActivate: handleSlotCategoryActivate,
  onLoopEnabledChange: handleLoopEnabledChange,
  onAutoplayEnabledChange: handleAutoplayEnabledChange,
  getPlaybackProgress: handlePlaybackProgress,
  onSelectSample: handleSelectSample,
  onWriteSample: handleWriteSample,
  onTogglePlay: handleTogglePlay,
});

store.subscribe((state) => {
  ui.render(state);

  if (state.selectedSampleId !== lastSelectedSampleId) {
    lastSelectedSampleId = state.selectedSampleId;
    void loadWaveformForSelection(state.selectedSampleId);

    if (state.autoplayEnabled && state.selectedSampleId) {
      void playSample(state.selectedSampleId, "autoplay");
    }
  }
});

commitState({
  error: isFileSystemAccessSupported()
    ? null
    : "Chrome oder Edge auf dem Desktop wird fuer diesen MVP benoetigt.",
});

void hydrateFromIndexedDb();
