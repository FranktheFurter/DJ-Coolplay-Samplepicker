import type { AppState } from "./types";

type Listener = (state: AppState) => void;

export const initialAppState: AppState = {
  samples: [],
  filteredSamples: [],
  selectedSampleId: null,
  loopEnabled: false,
  query: "",
  showStarredOnly: false,
  currentDirectoryId: null,
  currentDirectoryName: null,
  isScanning: false,
  currentAudioId: null,
  currentWaveform: null,
  lastScanAt: null,
  error: null,
};

export function createAppStore(initialState: AppState) {
  let currentState = initialState;
  const listeners = new Set<Listener>();

  return {
    getState(): AppState {
      return currentState;
    },
    setState(nextState: AppState): void {
      currentState = nextState;

      for (const listener of listeners) {
        listener(currentState);
      }
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      listener(currentState);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
