/**
 * Microphone capture (§12.1). MVP records with MediaRecorder (Opus/WebM, AAC/MP4 on Safari);
 * see docs/adr/0004-mediarecorder-for-mvp.md for why not AudioWorklet + WebCodecs yet.
 */

export const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
];

export function pickRecordingMime(isSupported: (t: string) => boolean): string | null {
  return RECORDING_MIME_CANDIDATES.find((t) => isSupported(t)) ?? null;
}

export type MicError = "denied" | "not_found" | "insecure" | "unsupported" | "busy";

export function classifyMicError(e: unknown): MicError {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "not_found";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  return "unsupported";
}

export async function openMicrophone(opts: { headphones: boolean }): Promise<MediaStream> {
  if (typeof window !== "undefined" && !window.isSecureContext)
    throw Object.assign(new Error("insecure"), { name: "SecurityError" });
  if (!navigator.mediaDevices?.getUserMedia)
    throw Object.assign(new Error("unsupported"), { name: "TypeError" });
  return navigator.mediaDevices.getUserMedia({
    audio: {
      // with headphones the bed can't leak into the mic, so keep the voice untouched
      echoCancellation: !opts.headphones,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
}

export interface Take {
  blob: Blob;
  mime: string;
  /** performance.now() when the recorder actually started delivering audio */
  startedAt: number;
  durationMs: number;
}

export class TakeRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  readonly mime: string;

  constructor(private readonly stream: MediaStream) {
    const mime = pickRecordingMime((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) throw new Error("MediaRecorder: no supported audio format");
    this.mime = mime;
  }

  /** Resolves when recording has started; `startedAt` is taken at the onstart event. */
  start(): Promise<number> {
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, { mimeType: this.mime, audioBitsPerSecond: 48_000 });
    this.rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    return new Promise((resolve) => {
      this.rec!.onstart = () => {
        this.startedAt = performance.now();
        resolve(this.startedAt);
      };
      this.rec!.start(250);
    });
  }

  stop(): Promise<Take> {
    const rec = this.rec;
    if (!rec) return Promise.reject(new Error("not recording"));
    return new Promise((resolve) => {
      rec.onstop = () => {
        const mime = rec.mimeType || this.mime;
        resolve({
          blob: new Blob(this.chunks, { type: mime.split(";")[0] }),
          mime,
          startedAt: this.startedAt,
          durationMs: performance.now() - this.startedAt,
        });
      };
      rec.stop();
    });
  }

  get recording() {
    return this.rec?.state === "recording";
  }
}

/** Live input level 0..1 for the meter and the "we can't hear you" hint. */
export class LevelMeter {
  private analyser: AnalyserNode;
  private data: Float32Array<ArrayBuffer>;
  private source: MediaStreamAudioSourceNode;

  constructor(ctx: AudioContext, stream: MediaStream) {
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.data = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
  }

  level(): number {
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (const v of this.data) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.data.length) * 5);
  }

  dispose() {
    this.source.disconnect();
    this.analyser.disconnect();
  }
}
