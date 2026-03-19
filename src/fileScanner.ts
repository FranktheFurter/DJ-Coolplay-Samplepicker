import type { SampleRecord, ScanProgress } from "./types";
import { isSupportedSampleExtension } from "./sampleFormats";

const MACOS_METADATA_DIRECTORIES = new Set(["__macosx"]);
const SCAN_PROGRESS_REPORT_INTERVAL_MS = 100;
const SCAN_PROGRESS_YIELD_INTERVAL_MS = 32;

function shouldSkipEntry(
  entryName: string,
  entryKind: FileSystemHandleKind,
): boolean {
  const normalizedName = entryName.toLowerCase();

  if (normalizedName.startsWith("._")) {
    return true;
  }

  if (entryKind === "directory" && MACOS_METADATA_DIRECTORIES.has(normalizedName)) {
    return true;
  }

  return false;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_\-./\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getExtension(fileName: string): string {
  const segments = fileName.split(".");
  return segments.length > 1 ? segments.at(-1)!.toLowerCase() : "";
}

export function buildSampleRecordId(
  directoryId: string,
  relativePath: string,
): string {
  return `${directoryId}:${relativePath}`;
}

export function createPersistedDirectory(
  handle: FileSystemDirectoryHandle,
): {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  selectedAt: number;
} {
  return {
    id: crypto.randomUUID(),
    name: handle.name,
    handle,
    selectedAt: Date.now(),
  };
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

async function yieldToUiThread(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function createEtaMs(
  processedCount: number,
  totalCount: number,
  startedAt: number,
): number | null {
  if (processedCount <= 0 || totalCount <= processedCount) {
    return totalCount <= processedCount ? 0 : null;
  }

  const elapsedMs = Date.now() - startedAt;

  if (elapsedMs <= 0) {
    return null;
  }

  const remainingCount = totalCount - processedCount;
  return Math.round((elapsedMs / processedCount) * remainingCount);
}

export async function scanDirectory(
  handle: FileSystemDirectoryHandle,
  directoryId: string,
  onProgress?: (progress: ScanProgress) => void,
): Promise<SampleRecord[]> {
  const samples: SampleRecord[] = [];
  const scanStartedAt = Date.now();
  let lastProgressReportAt = 0;
  let lastUiYieldAt = 0;

  async function reportProgress(progress: ScanProgress, force = false): Promise<void> {
    const now = Date.now();

    if (!force && now - lastProgressReportAt < SCAN_PROGRESS_REPORT_INTERVAL_MS) {
      if (now - lastUiYieldAt >= SCAN_PROGRESS_YIELD_INTERVAL_MS) {
        lastUiYieldAt = now;
        await yieldToUiThread();
      }
      return;
    }

    onProgress?.(progress);
    lastProgressReportAt = now;

    if (now - lastUiYieldAt >= SCAN_PROGRESS_YIELD_INTERVAL_MS) {
      lastUiYieldAt = now;
      await yieldToUiThread();
    }
  }

  let countedSamples = 0;

  async function countSupportedFiles(
    currentHandle: FileSystemDirectoryHandle,
    currentPath: string[],
  ): Promise<void> {
    for await (const [entryName, entry] of currentHandle.entries()) {
      if (shouldSkipEntry(entryName, entry.kind)) {
        continue;
      }

      if (entry.kind === "directory") {
        await countSupportedFiles(entry, [...currentPath, entryName]);
        continue;
      }

      const extension = getExtension(entryName);

      if (!isSupportedSampleExtension(extension)) {
        continue;
      }

      countedSamples += 1;
      const relativePath = [...currentPath, entry.name].join("/");
      await reportProgress(
        {
          phase: "counting",
          discoveredSampleCount: countedSamples,
          totalSampleCount: null,
          scannedSampleCount: 0,
          elapsedMs: Date.now() - scanStartedAt,
          estimatedRemainingMs: null,
          currentPath: relativePath,
        },
        countedSamples === 1,
      );
    }
  }

  async function walk(
    currentHandle: FileSystemDirectoryHandle,
    currentPath: string[],
    totalSampleCount: number,
    phaseStartedAt: number,
  ): Promise<void> {
    for await (const [entryName, entry] of currentHandle.entries()) {
      if (shouldSkipEntry(entryName, entry.kind)) {
        continue;
      }

      if (entry.kind === "directory") {
        await walk(entry, [...currentPath, entryName], totalSampleCount, phaseStartedAt);
        continue;
      }

      const extension = getExtension(entryName);

      if (!isSupportedSampleExtension(extension)) {
        continue;
      }

      const file = await entry.getFile();
      const relativePath = [...currentPath, entry.name].join("/");

      samples.push({
        id: buildSampleRecordId(directoryId, relativePath),
        directoryId,
        name: entry.name,
        normalizedName: normalizeText(entry.name),
        relativePath,
        extension,
        size: file.size,
        lastModified: file.lastModified,
        slotNumber: null,
      });

      await reportProgress(
        {
          phase: "scanning",
          discoveredSampleCount: totalSampleCount,
          totalSampleCount,
          scannedSampleCount: samples.length,
          elapsedMs: Date.now() - scanStartedAt,
          estimatedRemainingMs: createEtaMs(
            samples.length,
            totalSampleCount,
            phaseStartedAt,
          ),
          currentPath: relativePath,
        },
        samples.length === 1 || samples.length === totalSampleCount,
      );
    }
  }

  await reportProgress(
    {
      phase: "counting",
      discoveredSampleCount: 0,
      totalSampleCount: null,
      scannedSampleCount: 0,
      elapsedMs: 0,
      estimatedRemainingMs: null,
      currentPath: null,
    },
    true,
  );
  await countSupportedFiles(handle, []);

  const totalSampleCount = countedSamples;
  const scanPhaseStartedAt = Date.now();

  await reportProgress(
    {
      phase: "scanning",
      discoveredSampleCount: totalSampleCount,
      totalSampleCount,
      scannedSampleCount: 0,
      elapsedMs: Date.now() - scanStartedAt,
      estimatedRemainingMs: totalSampleCount === 0 ? 0 : null,
      currentPath: null,
    },
    true,
  );
  await walk(handle, [], totalSampleCount, scanPhaseStartedAt);

  return samples.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, undefined, {
      sensitivity: "base",
    }),
  );
}

export async function getFileFromRelativePath(
  rootHandle: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<File> {
  const segments = relativePath.split("/").filter(Boolean);

  if (segments.length === 0) {
    throw new Error("Empty file path.");
  }

  let currentDirectory = rootHandle;

  for (const segment of segments.slice(0, -1)) {
    currentDirectory = await currentDirectory.getDirectoryHandle(segment);
  }

  const fileHandle = await currentDirectory.getFileHandle(segments.at(-1)!);
  return fileHandle.getFile();
}
