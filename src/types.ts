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
  starred: boolean;
}

export interface PersistedDirectory {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  selectedAt: number;
}

export interface AppState {
  samples: SampleRecord[];
  filteredSamples: SampleRecord[];
  query: string;
  showStarredOnly: boolean;
  currentDirectoryId: string | null;
  currentDirectoryName: string | null;
  isScanning: boolean;
  currentAudioId: string | null;
  lastScanAt: number | null;
  error: string | null;
}

