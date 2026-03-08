import { AudioPreviewController } from "./audioPreview";
import {
  getCurrentDirectory,
  getSamplesForDirectory,
  replaceSamplesForDirectory,
  saveDirectory,
  updateSampleStar,
} from "./db";
import {
  createPersistedDirectory,
  getFileFromRelativePath,
  isFileSystemAccessSupported,
  scanDirectory,
} from "./fileScanner";
import { filterSamples } from "./search";
import { createAppStore, initialAppState } from "./state";
import "./styles.css";
import type { AppState, PersistedDirectory, SampleRecord } from "./types";
import { createUI } from "./ui";
import { createWaveformPreview } from "./waveform";

const store = createAppStore(initialAppState);
const audioPreview = new AudioPreviewController((sampleId) => {
  commitState({ currentAudioId: sampleId });
});

let activeDirectory: PersistedDirectory | null = null;
let waveformRequestToken = 0;
let lastSelectedSampleId: string | null = null;

function deriveState(nextState: AppState): AppState {
  const filteredSamples = filterSamples(
    nextState.samples,
    nextState.query,
    nextState.showStarredOnly,
  );
  let selectedSampleId = nextState.selectedSampleId;

  if (filteredSamples.length === 0) {
    selectedSampleId = null;
  } else if (!selectedSampleId) {
    selectedSampleId = filteredSamples[0].id;
  } else if (!filteredSamples.some((sample) => sample.id === selectedSampleId)) {
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

function buildStarMap(samples: SampleRecord[]): Map<string, boolean> {
  return new Map(
    samples.map((sample) => [sample.relativePath.toLowerCase(), sample.starred]),
  );
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

    commitState({
      currentWaveform: null,
      error:
        error instanceof Error
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
    samples: isDirectorySwitch ? [] : previousState.samples,
    error: null,
  });

  try {
    const hasPermission = await ensureReadPermission(directory.handle);

    if (!hasPermission) {
      throw new Error("Leseberechtigung fuer den Ordner wurde nicht erteilt.");
    }

    const previousSamples = await getSamplesForDirectory(directory.id);
    const starMap = buildStarMap(previousSamples);
    const scannedSamples = await scanDirectory(directory.handle, directory.id);

    const mergedSamples = scannedSamples.map((sample) => ({
      ...sample,
      starred: starMap.get(sample.relativePath.toLowerCase()) ?? false,
    }));

    await replaceSamplesForDirectory(directory.id, mergedSamples);

    commitState({
      samples: mergedSamples,
      isScanning: false,
      lastScanAt: Date.now(),
      error: null,
    });
  } catch (error) {
    commitState({
      isScanning: false,
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

    const samples = await getSamplesForDirectory(directory.id);
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

function handleSearchChange(query: string): void {
  commitState({ query });
}

function handleStarredOnlyChange(showStarredOnly: boolean): void {
  commitState({ showStarredOnly });
}

function handleSelectSample(sampleId: string): void {
  if (store.getState().selectedSampleId === sampleId) {
    return;
  }

  commitState({ selectedSampleId: sampleId });
}

async function handleToggleStar(sampleId: string): Promise<void> {
  const previousSamples = store.getState().samples;
  const sample = previousSamples.find((entry) => entry.id === sampleId);

  if (!sample) {
    return;
  }

  const nextStarredValue = !sample.starred;
  const nextSamples = previousSamples.map((entry) =>
    entry.id === sampleId ? { ...entry, starred: nextStarredValue } : entry,
  );

  commitState({ samples: nextSamples });

  try {
    await updateSampleStar(sampleId, nextStarredValue);
  } catch (error) {
    commitState({
      samples: previousSamples,
      error:
        error instanceof Error
          ? error.message
          : "Konnte Merker nicht speichern.",
    });
  }
}

async function handleTogglePlay(sampleId: string): Promise<void> {
  if (!activeDirectory) {
    return;
  }

  const sample = store.getState().samples.find((entry) => entry.id === sampleId);

  if (!sample) {
    return;
  }

  handleSelectSample(sample.id);

  try {
    const hasPermission = await ensureReadPermission(activeDirectory.handle);

    if (!hasPermission) {
      throw new Error("Leseberechtigung fuer Audio-Preview wurde verweigert.");
    }

    await audioPreview.toggle(
      {
        id: sample.id,
      },
      async () =>
        getFileFromRelativePath(activeDirectory!.handle, sample.relativePath),
    );
  } catch (error) {
    commitState({
      currentAudioId: null,
      error:
        error instanceof Error
          ? error.message
          : "Audio-Preview konnte nicht gestartet werden.",
    });
  }
}

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("App-Root #app wurde nicht gefunden.");
}

const ui = createUI(appRoot, {
  onPickDirectory: handlePickDirectory,
  onRefreshScan: handleRefreshScan,
  onSearchChange: handleSearchChange,
  onStarredOnlyChange: handleStarredOnlyChange,
  onSelectSample: handleSelectSample,
  onToggleStar: handleToggleStar,
  onTogglePlay: handleTogglePlay,
});

store.subscribe((state) => {
  ui.render(state);

  if (state.selectedSampleId !== lastSelectedSampleId) {
    lastSelectedSampleId = state.selectedSampleId;
    void loadWaveformForSelection(state.selectedSampleId);
  }
});

commitState({
  error: isFileSystemAccessSupported()
    ? null
    : "Chrome oder Edge auf dem Desktop wird fuer diesen MVP benoetigt.",
});

void hydrateFromIndexedDb();
