export function selectEnglishVoice(voices: SpeechSynthesisVoice[]) {
  const english = voices.filter((voice) => voice.lang.replaceAll("_", "-").toLowerCase() === "en-us");
  return english.find((voice) => voice.default) ?? english[0];
}

export function createPronunciation(synth: SpeechSynthesis, make: (text: string) => SpeechSynthesisUtterance, update: (speaking: boolean, message: string) => void) {
  let current: SpeechSynthesisUtterance | undefined;
  const stop = () => {
    const active = current;
    current = undefined;
    if (active) synth.cancel();
    update(false, "");
  };
  return {
    stop,
    play(term: string) {
      stop();
      try {
        const text = term.replace(/\p{N}+/gu, " ").replace(/^[\s.,:;()\-]+|[\s.,:;()\-]+$/g, "").replace(/\s+/g, " ");
        if (!/[a-z]/i.test(text)) { update(false, "재생할 영어 단어가 없어요."); return; }
        const voices = synth.getVoices();
        const voice = selectEnglishVoice(voices);
        if (!voice) {
          update(false, voices.length ? "미국 영어 음성을 사용할 수 없어요. 기기의 음성 설정을 확인해 주세요." : "음성을 준비하지 못했어요. 잠시 후 다시 눌러 주세요.");
          return;
        }
        const utterance = make(text);
        current = utterance;
        utterance.voice = voice;
        utterance.lang = "en-US";
        utterance.onstart = () => { if (current === utterance) update(true, ""); };
        utterance.onend = () => { if (current === utterance) { current = undefined; update(false, ""); } };
        utterance.onerror = () => { if (current === utterance) { current = undefined; update(false, "발음을 재생하지 못했어요. 다시 눌러 주세요."); } };
        synth.speak(utterance);
      } catch {
        current = undefined;
        update(false, "발음을 재생하지 못했어요. 다시 눌러 주세요.");
      }
    },
  };
}
