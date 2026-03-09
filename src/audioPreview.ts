interface PlaybackSample {
  id: string;
}

export class AudioPreviewController {
  private readonly audio: HTMLAudioElement;
  private objectUrl: string | null = null;
  private currentSampleId: string | null = null;
  private loopEnabled = false;
  private playbackRequestId = 0;

  constructor(private readonly onPlaybackChange: (sampleId: string | null) => void) {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.addEventListener("ended", () => {
      this.resetPlayback();
    });
    this.audio.addEventListener("error", () => {
      this.resetPlayback();
    });
  }

  setLoopEnabled(loopEnabled: boolean): void {
    this.loopEnabled = loopEnabled;
    this.audio.loop = loopEnabled;
  }

  getPlayheadProgress(
    sampleId: string,
    fallbackDurationSeconds: number,
  ): number | null {
    if (this.currentSampleId !== sampleId || this.audio.paused) {
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
    await this.start(sample, getFile, this.loopEnabled, true);
  }

  async playOnce(
    sample: PlaybackSample,
    getFile: () => Promise<File>,
  ): Promise<void> {
    await this.start(sample, getFile, false, false);
  }

  stop(): void {
    this.playbackRequestId += 1;
    this.resetPlayback();
  }

  private revokeObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private resetPlayback(): void {
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio.loop = this.loopEnabled;
    this.audio.src = "";
    this.revokeObjectUrl();

    if (this.currentSampleId !== null) {
      this.currentSampleId = null;
      this.onPlaybackChange(null);
    }
  }

  private async start(
    sample: PlaybackSample,
    getFile: () => Promise<File>,
    loopEnabled: boolean,
    allowToggleStop: boolean,
  ): Promise<void> {
    if (
      allowToggleStop &&
      this.currentSampleId === sample.id &&
      !this.audio.paused
    ) {
      this.stop();
      return;
    }

    const requestId = ++this.playbackRequestId;
    this.resetPlayback();

    const file = await getFile();

    if (requestId !== this.playbackRequestId) {
      return;
    }

    const url = URL.createObjectURL(file);
    this.revokeObjectUrl();
    this.objectUrl = url;
    this.audio.src = url;
    this.audio.currentTime = 0;
    this.audio.loop = loopEnabled;
    this.currentSampleId = sample.id;
    this.onPlaybackChange(sample.id);

    try {
      await this.audio.play();

      if (
        requestId === this.playbackRequestId &&
        this.currentSampleId === sample.id
      ) {
        this.onPlaybackChange(sample.id);
      }
    } catch (error) {
      if (requestId !== this.playbackRequestId) {
        return;
      }

      this.resetPlayback();
      throw error;
    }
  }
}
