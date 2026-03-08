import type { WaveformPreview } from "./types";

const WAVEFORM_POINT_COUNT = 960;

function createWaveformPeaks(
  audioBuffer: AudioBuffer,
  pointCount: number,
): number[] {
  const sampleCount = audioBuffer.length;

  if (sampleCount === 0) {
    return Array.from({ length: pointCount }, () => 0);
  }

  const blockSize = Math.max(1, Math.floor(sampleCount / pointCount));
  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) =>
    audioBuffer.getChannelData(index),
  );
  const peaks = new Array<number>(pointCount).fill(0);

  for (let i = 0; i < pointCount; i += 1) {
    const start = i * blockSize;

    if (start >= sampleCount) {
      break;
    }

    const end =
      i === pointCount - 1
        ? sampleCount
        : Math.min(sampleCount, start + blockSize);
    let maxPeak = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      for (const channel of channels) {
        const amplitude = Math.abs(channel[sampleIndex] ?? 0);

        if (amplitude > maxPeak) {
          maxPeak = amplitude;
        }
      }
    }

    peaks[i] = maxPeak;
  }

  const globalPeak = Math.max(...peaks);

  if (globalPeak > 0) {
    return peaks.map((value) => Math.min(1, value / globalPeak));
  }

  return peaks;
}

export async function createWaveformPreview(
  sampleId: string,
  sampleName: string,
  file: File,
): Promise<WaveformPreview> {
  let audioContext: AudioContext | null = null;

  try {
    audioContext = new AudioContext();
    const encodedBuffer = await file.arrayBuffer();
    const decodedBuffer = await audioContext.decodeAudioData(encodedBuffer.slice(0));

    return {
      sampleId,
      sampleName,
      durationSeconds: decodedBuffer.duration,
      peaks: createWaveformPeaks(decodedBuffer, WAVEFORM_POINT_COUNT),
    };
  } finally {
    if (audioContext) {
      void audioContext.close();
    }
  }
}
