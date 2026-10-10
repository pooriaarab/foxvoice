// Records every speechSynthesis.speak call, so the test can assert what was
// said. foxvoice's speak() uses a new hidden iframe for each text, so this
// watches each iframe that the page appends.
export const said = [];

export function spyOnSpeech() {
  const append = document.body.append.bind(document.body);
  document.body.append = (...nodes) => {
    append(...nodes);
    for (const node of nodes) {
      const synth = node instanceof HTMLIFrameElement ? node.contentWindow?.speechSynthesis : undefined;
      if (!synth) continue;
      const real = synth.speak.bind(synth);
      synth.speak = (utterance) => {
        said.push({ text: utterance.text, voice: utterance.voice?.name, lang: utterance.lang });
        real(utterance);
      };
    }
  };
}
