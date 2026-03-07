export class AudioPreviewController {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private currentSampleId: string | null = null;

  constructor(
    private readonly onPlaybackChange: (sampleId: string | null) => void,
  ) {}

  async toggle(
    sampleId: string,
    getFile: () => Promise<File>,
  ): Promise<void> {
    if (this.currentSampleId === sampleId && this.audio && !this.audio.paused) {
      this.stop();
      return;
    }

    this.stop();

    const file = await getFile();
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);

    audio.addEventListener("ended", () => {
      this.clear();
    });

    audio.addEventListener("error", () => {
      this.clear();
    });

    this.audio = audio;
    this.objectUrl = url;
    this.currentSampleId = sampleId;
    this.onPlaybackChange(sampleId);

    try {
      await audio.play();
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

