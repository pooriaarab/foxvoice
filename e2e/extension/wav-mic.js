// A microphone that plays a WAV file, for the E2E test only. It replaces
// navigator.mediaDevices.getUserMedia in the page, so foxvoice records the
// file through the real MediaRecorder path. After the file ends, the stream
// sends silence, as a real microphone does when nobody speaks.
// It captures an <audio> element, not an AudioContext: without an audio
// output device (a Linux runner), an AudioContext never leaves "suspended"
// and plays nothing, while a media element plays on a system clock (H1).
export const wavMic = { calls: 0, url: "", ended: Promise.resolve(), tracks: [] };

/** Make getUserMedia return a stream that plays url once. */
export function useWavMic(url) {
  wavMic.url = url;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    wavMic.calls += 1;
    let ended;
    wavMic.ended = new Promise((resolve) => (ended = resolve));
    if (!constraints?.audio) throw new DOMException("audio only", "TypeError");
    const player = new Audio(wavMic.url);
    player.addEventListener("ended", ended, { once: true });
    const stream = player.mozCaptureStream();
    await player.play();
    if (!stream.getAudioTracks().length) await new Promise((resolve) => stream.addEventListener("addtrack", resolve, { once: true }));
    const [track] = stream.getAudioTracks();
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      player.pause();
    };
    wavMic.tracks.push(track);
    return stream;
  };
}
