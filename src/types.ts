export type CategoryGuess =
  | "kick"
  | "snare"
  | "hat"
  | "clap"
  | "perc"
  | "fx"
  | "loop"
  | "bass"
  | "unknown";

export interface SampleRecord {
  id: string;
  directoryId: string;
  name: string;
  normalizedName: string;
  relativePath: string;
  extension: string;
  size: number;
  lastModified: number;
  categoryGuess: CategoryGuess;
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

export interface AppState {
  samples: SampleRecord[];
  filteredSamples: SampleRecord[];
  selectedSampleId: string | null;
  loopEnabled: boolean;
  query: string;
  showAssignedOnly: boolean;
  currentDirectoryId: string | null;
  currentDirectoryName: string | null;
  isScanning: boolean;
  currentAudioId: string | null;
  currentWaveform: WaveformPreview | null;
  lastScanAt: number | null;
  error: string | null;
}
