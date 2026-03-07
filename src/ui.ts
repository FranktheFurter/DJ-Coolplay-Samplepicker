import type { AppState, SampleRecord } from "./types";

interface UIHandlers {
  onPickDirectory: () => void | Promise<void>;
  onRefreshScan: () => void | Promise<void>;
  onSearchChange: (query: string) => void;
  onStarredOnlyChange: (showStarredOnly: boolean) => void;
  onToggleStar: (sampleId: string) => void | Promise<void>;
  onTogglePlay: (sampleId: string) => void | Promise<void>;
}

interface UIController {
  render: (state: AppState) => void;
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

function createRow(
  sample: SampleRecord,
  currentAudioId: string | null,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "sample-row";

  const name = document.createElement("div");
  name.className = "sample-name";
  name.textContent = sample.name;

  const path = document.createElement("div");
  path.className = "sample-path";
  path.title = sample.relativePath;
  path.textContent = sample.relativePath;

  const category = document.createElement("div");
  const categoryBadge = document.createElement("span");
  categoryBadge.className = "category-badge";
  categoryBadge.textContent = sample.categoryGuess;
  category.append(categoryBadge);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const playButton = document.createElement("button");
  playButton.className =
    sample.id === currentAudioId ? "row-button active" : "row-button";
  playButton.type = "button";
  playButton.dataset.action = "play";
  playButton.dataset.id = sample.id;
  playButton.textContent = sample.id === currentAudioId ? "Stop" : "Play";

  const starButton = document.createElement("button");
  starButton.className = sample.starred
    ? "row-button active"
    : "row-button";
  starButton.type = "button";
  starButton.dataset.action = "star";
  starButton.dataset.id = sample.id;
  starButton.textContent = sample.starred ? "Gemerkt" : "Merken";

  actions.append(playButton, starButton);
  row.append(name, path, category, actions);

  return row;
}

export function createUI(root: HTMLElement, handlers: UIHandlers): UIController {
  root.innerHTML = `
    <main class="app-shell">
      <section class="topbar">
        <div class="headline">
          <h1>Sample Picker</h1>
          <p>
            Lokaler Desktop-MVP fuer schnelles Browsen, Vorhoeren und Merken von
            Kicks, Snares, Hats und anderem Sample-Material.
          </p>
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
              <input type="checkbox" data-role="starred-only" />
              Nur gemerkte
            </label>
          </div>
        </div>
      </section>

      <div class="statusbar">
        <div data-role="status"></div>
        <div data-role="count"></div>
      </div>

      <div class="error-box" data-role="error" hidden></div>

      <section class="results">
        <div class="results-header">
          <div>Name</div>
          <div>Pfad</div>
          <div>Kategorie</div>
          <div>Aktionen</div>
        </div>
        <div class="results-body" data-role="results-body"></div>
      </section>
    </main>
  `;

  const pickDirectoryButton = root.querySelector<HTMLButtonElement>(
    '[data-role="pick-directory"]',
  );
  const refreshScanButton = root.querySelector<HTMLButtonElement>(
    '[data-role="refresh-scan"]',
  );
  const searchInput = root.querySelector<HTMLInputElement>('[data-role="search"]');
  const starredOnlyInput = root.querySelector<HTMLInputElement>(
    '[data-role="starred-only"]',
  );
  const statusElement = root.querySelector<HTMLDivElement>('[data-role="status"]');
  const countElement = root.querySelector<HTMLDivElement>('[data-role="count"]');
  const errorElement = root.querySelector<HTMLDivElement>('[data-role="error"]');
  const resultsBody = root.querySelector<HTMLDivElement>(
    '[data-role="results-body"]',
  );

  if (
    !pickDirectoryButton ||
    !refreshScanButton ||
    !searchInput ||
    !starredOnlyInput ||
    !statusElement ||
    !countElement ||
    !errorElement ||
    !resultsBody
  ) {
    throw new Error("UI konnte nicht initialisiert werden.");
  }

  pickDirectoryButton.addEventListener("click", () => {
    void handlers.onPickDirectory();
  });

  refreshScanButton.addEventListener("click", () => {
    void handlers.onRefreshScan();
  });

  searchInput.addEventListener("input", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    handlers.onSearchChange(target.value);
  });

  starredOnlyInput.addEventListener("change", (event) => {
    const target = event.currentTarget as HTMLInputElement;
    handlers.onStarredOnlyChange(target.checked);
  });

  resultsBody.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button[data-action]");

    if (!button) {
      return;
    }

    const sampleId = button.dataset.id;

    if (!sampleId) {
      return;
    }

    const action = button.dataset.action;

    if (action === "play") {
      void handlers.onTogglePlay(sampleId);
      return;
    }

    if (action === "star") {
      void handlers.onToggleStar(sampleId);
    }
  });

  return {
    render(state) {
      pickDirectoryButton.disabled = state.isScanning;
      refreshScanButton.disabled =
        state.isScanning || state.currentDirectoryId === null;
      searchInput.value = state.query;
      starredOnlyInput.checked = state.showStarredOnly;

      statusElement.textContent = formatStatus(state);
      countElement.textContent = formatCount(state.filteredSamples.length);

      if (state.error) {
        errorElement.hidden = false;
        errorElement.textContent = state.error;
      } else {
        errorElement.hidden = true;
        errorElement.textContent = "";
      }

      resultsBody.replaceChildren();

      if (state.filteredSamples.length === 0) {
        const emptyState = document.createElement("div");
        emptyState.className = "empty-state";
        emptyState.textContent = state.currentDirectoryId
          ? "Keine passenden Samples gefunden."
          : "Waehle einen lokalen Sample-Ordner, um den ersten Scan zu starten.";
        resultsBody.append(emptyState);
        return;
      }

      const fragment = document.createDocumentFragment();

      for (const sample of state.filteredSamples) {
        fragment.append(createRow(sample, state.currentAudioId));
      }

      resultsBody.append(fragment);
    },
  };
}
