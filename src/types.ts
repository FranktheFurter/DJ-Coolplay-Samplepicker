export interface SampleRecord {
  id: string;
  directoryId: string;
  name: string;
  normalizedName: string;
  relativePath: string;
  extension: string;
  size: number;
  lastModified: number;
  slotNumber: number | null;
}

export interface PersistedDirectory {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  selectedAt: number;
}

export interface WaveformPreview {
  sampleId: string;
  sampleName: string;
  durationSeconds: number;
  peaks: number[];
}

export interface ScanProgress {
  phase: "counting" | "scanning";
  discoveredSampleCount: number;
  totalSampleCount: number | null;
  scannedSampleCount: number;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
  currentPath: string | null;
}

export interface AppState {
  samples: SampleRecord[];
  filteredSamples: SampleRecord[];
  selectedSampleId: string | null;
  slotCounter: number;
  randomizerStepRatio: number;
  loopEnabled: boolean;
  autoplayEnabled: boolean;
  query: string;
  showAssignedOnly: boolean;
  currentDirectoryId: string | null;
  currentDirectoryName: string | null;
  isScanning: boolean;
  scanProgress: ScanProgress | null;
  currentAudioId: string | null;
  currentWaveform: WaveformPreview | null;
  lastScanAt: number | null;
  error: string | null;
}

export interface RandomizerCategoryConfig {
  rangeStart: number;
  rangeEnd: number;
  query: string;
}

export interface RandomizerRequest {
  stepRatio: number;
  categories: RandomizerCategoryConfig[];
}
