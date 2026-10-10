// Fakes for the browser media APIs, so the microphone code runs in Node.
// They copy only the parts foxvoice uses: tracks that stop and end, a
// recorder that gives one Blob at stop, and getUserMedia.

export class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  kind = "audio";
  stop() {
    this.readyState = "ended";
  }
  /** The device went away: Firefox fires "ended" and the track is ended. */
  unplug() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

export class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

export class FakeRecorder extends EventTarget {
  static last: FakeRecorder | undefined;
  /** Bytes the recorder gives at stop. Empty means no audio came. */
  static bytes = 1000;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/ogg";
  constructor(readonly stream: FakeStream) {
    super();
    FakeRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    queueMicrotask(() => {
      const event = Object.assign(new Event("dataavailable"), { data: new Blob([new Uint8Array(FakeRecorder.bytes)]) });
      this.dispatchEvent(event);
      this.dispatchEvent(new Event("stop"));
    });
  }
}

/** 16 kHz audio: a 440 Hz tone at the given level, or silence at level 0. */
export function tone(ms: number, level = 0.3): Float32Array {
  const samples = new Float32Array(Math.round((ms * 16000) / 1000));
  for (let i = 0; i < samples.length; i++) samples[i] = level * Math.sin((2 * Math.PI * 440 * i) / 16000);
  return samples;
}

/** The media hooks openMic takes, with a getUserMedia that records each call. */
export function fakeMedia(audio: Float32Array = tone(1000)) {
  const streams: FakeStream[] = [];
  const media = {
    getUserMedia: async (_constraints: MediaStreamConstraints) => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream as unknown as MediaStream;
    },
    MediaRecorder: FakeRecorder as unknown as typeof MediaRecorder,
    decode: async (_blob: Blob) => audio,
  };
  return { media, streams };
}

/** A getUserMedia that fails with the DOMException name a browser uses. */
export function refusing(name: string) {
  return async () => {
    throw new DOMException(`fake ${name}`, name);
  };
}
