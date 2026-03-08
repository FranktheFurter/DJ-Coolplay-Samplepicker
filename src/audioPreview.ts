interface PlaybackSample {
  id: string;
}

export class AudioPreviewController {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private currentSampleId: string | null = null;
  private loopEnabled = false;

  constructor(private readonly onPlaybackChange: (sampleId: string | null) => void) {}

  setLoopEnabled(loopEnabled: boolean): void {
    this.loopEnabled = loopEnabled;

    if (this.audio) {
      this.audio.loop = loopEnabled;
    }
  }

  getPlayheadProgress(
    sampleId: string,
    fallbackDurationSeconds: number,
  ): number | null {
    if (!this.audio || this.currentSampleId !== sampleId || this.audio.paused) {
      return null;
    }

    const duration =
      Number.isFinite(this.audio.duration) && this.audio.duration > 0
        ? this.audio.duration
        : fallbackDurationSeconds;

    if (!Number.isFinite(duration) || duration <= 0) {
      return null;
    }

    const currentTime = this.audio.currentTime;

    if (!Number.isFinite(currentTime) || currentTime < 0) {
      return null;
    }

    return Math.max(0, Math.min(1, (currentTime % duration) / duration));
  }

  async toggle(
    sample: PlaybackSample,
    getFile: () => Promise<File>,
  ): Promise<void> {
    if (
      this.currentSampleId === sample.id &&
      this.audio &&
      !this.audio.paused
    ) {
      this.stop();
      return;
    }

    this.stop();

    const file = await getFile();
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    audio.loop = this.loopEnabled;

    audio.addEventListener("ended", () => {
      this.clear();
    });

    audio.addEventListener("error", () => {
      this.clear();
    });

    this.audio = audio;
    this.objectUrl = url;
    this.currentSampleId = sample.id;
    this.onPlaybackChange(sample.id);

    try {
      await audio.play();
      if (this.audio === audio && this.currentSampleId === sample.id) {
        this.onPlaybackChange(sample.id);
      }
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }

    this.clear();
  }

  private clear(): void {
    if (this.audio) {
      this.audio.src = "";
      this.audio = null;
    }

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    if (this.currentSampleId !== null) {
      this.currentSampleId = null;
      this.onPlaybackChange(null);
    }
  }
}
