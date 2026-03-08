import type { SampleRecord } from "./types";

function normalizeQuery(value: string): string {
  return value.toLowerCase().trim();
}

export function filterSamples(
  samples: SampleRecord[],
  query: string,
  showAssignedOnly: boolean,
): SampleRecord[] {
  const normalizedQuery = normalizeQuery(query);

  return samples.filter((sample) => {
    if (showAssignedOnly && sample.slotNumber === null) {
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
