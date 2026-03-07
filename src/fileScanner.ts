import type { CategoryGuess, SampleRecord } from "./types";

const CATEGORY_RULES: Array<{
  category: CategoryGuess;
  pattern: RegExp;
}> = [
  { category: "kick", pattern: /\b(kick|bd)\b/ },
  { category: "snare", pattern: /\b(snare|sd)\b/ },
  { category: "hat", pattern: /\b(hihat|hi hat|hat|hh)\b/ },
  { category: "clap", pattern: /\b(clap)\b/ },
  { category: "perc", pattern: /\b(perc|percussion|tom|rim|shaker)\b/ },
  { category: "fx", pattern: /\b(fx|sfx|impact|riser|sweep|texture)\b/ },
  { category: "loop", pattern: /\b(loop|toploop|top loop)\b/ },
  { category: "bass", pattern: /\b(bass|sub)\b/ },
];

const AUDIO_EXTENSIONS = new Set(["wav", "aif", "aiff", "mp3", "flac"]);

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

function guessCategory(value: string): CategoryGuess {
  const normalizedValue = normalizeText(value);

  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(normalizedValue)) {
      return rule.category;
    }
  }

  return "unknown";
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

export async function scanDirectory(
  handle: FileSystemDirectoryHandle,
  directoryId: string,
): Promise<SampleRecord[]> {
  const samples: SampleRecord[] = [];

  async function walk(
    currentHandle: FileSystemDirectoryHandle,
    currentPath: string[],
  ): Promise<void> {
    for await (const [entryName, entry] of currentHandle.entries()) {
      if (entry.kind === "directory") {
        await walk(entry, [...currentPath, entryName]);
        continue;
      }

      const extension = getExtension(entryName);

      if (!AUDIO_EXTENSIONS.has(extension)) {
        continue;
      }

      const file = await entry.getFile();
      const relativePath = [...currentPath, entry.name].join("/");

      samples.push({
        id: `${directoryId}:${relativePath.toLowerCase()}`,
        directoryId,
        name: entry.name,
        normalizedName: normalizeText(entry.name),
        relativePath,
        extension,
        size: file.size,
        lastModified: file.lastModified,
        categoryGuess: guessCategory(relativePath),
        starred: false,
      });
    }
  }

  await walk(handle, []);

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
    throw new Error("Leerer Dateipfad.");
  }

  let currentDirectory = rootHandle;

  for (const segment of segments.slice(0, -1)) {
    currentDirectory = await currentDirectory.getDirectoryHandle(segment);
  }

  const fileHandle = await currentDirectory.getFileHandle(segments.at(-1)!);
  return fileHandle.getFile();
}

