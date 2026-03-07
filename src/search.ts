import type { SampleRecord } from "./types";

function normalizeQuery(value: string): string {
  return value.toLowerCase().trim();
}

export function filterSamples(
  samples: SampleRecord[],
  query: string,
  showStarredOnly: boolean,
): SampleRecord[] {
  const normalizedQuery = normalizeQuery(query);

  return samples.filter((sample) => {
    if (showStarredOnly && !sample.starred) {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    return (
      sample.normalizedName.includes(normalizedQuery) ||
      sample.relativePath.toLowerCase().includes(normalizedQuery)
    );
  });
}

