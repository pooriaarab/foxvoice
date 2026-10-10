// A microphone that plays a WAV file, for the E2E test only. It replaces
// navigator.mediaDevices.getUserMedia in the page, so foxvoice records the
// file through the real MediaRecorder path. After the file ends, the stream
// sends silence, as a real microphone does when nobody speaks.
export const wavMic = { calls: 0, url: "", ended: Promise.resolve(), tracks: [] };

/** Make getUserMedia return a stream that plays url once. */
export function useWavMic(url) {
  wavMic.url = url;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    wavMic.calls += 1;
    if (!constraints?.audio) throw new DOMException("audio only", "TypeError");
    const context = new AudioContext();
    const buffer = await context.decodeAudioData(await (await fetch(wavMic.url)).arrayBuffer());
    const source = context.createBufferSource();
    source.buffer = buffer;
    const sink = context.createMediaStreamDestination();
    source.connect(sink);
    wavMic.ended = new Promise((resolve) => (source.onended = resolve));
    source.start();
    const [track] = sink.stream.getAudioTracks();
    track.addEventListener("ended", () => context.close());
    const stop = track.stop.bind(track);
    // MediaStreamTrack.stop() fires no "ended" event, so close the context here too.
    track.stop = () => {
      stop();
      void context.close();
    };
    wavMic.tracks.push(track);
    return sink.stream;
  };
}
