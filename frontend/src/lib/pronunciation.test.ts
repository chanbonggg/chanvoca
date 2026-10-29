import assert from "node:assert/strict";
import test from "node:test";
import { createPronunciation, selectEnglishVoice } from "./pronunciation";
const voice = (lang: string, isDefault = false) => ({ lang, default: isDefault }) as SpeechSynthesisVoice;
test("selects US English only and prefers the default US voice", () => {
  const selected = voice("en_US", true);
  assert.equal(selectEnglishVoice([voice("ko-KR", true), voice("en-US"), selected]), selected);
  assert.equal(selectEnglishVoice([voice("en-GB")]), undefined);
});
function fixture() {
  let voices = [voice("en-US")];
  const spoken: SpeechSynthesisUtterance[] = [];
  const states: [boolean, string][] = [];
  let cancels = 0;
  let fail = false;
  const synth = { getVoices: () => voices, cancel: () => { cancels++; }, speak: (u: SpeechSynthesisUtterance) => { if (fail) throw Error("failed"); spoken.push(u); } } as unknown as SpeechSynthesis;
  const player = createPronunciation(synth, (text) => ({ text }) as SpeechSynthesisUtterance, (active, message) => states.push([active, message]));
  return { player, spoken, states, cancels: () => cancels, voices: (next: SpeechSynthesisVoice[]) => { voices = next; }, fail: (value: boolean) => { fail = value; } };
}
test("empty or unavailable voice never speaks; later voices require another click", () => {
  const f = fixture(); f.voices([]); f.player.play("apple");
  assert.equal(f.spoken.length, 0);
  f.voices([voice("en-US")]); assert.equal(f.spoken.length, 0);
  f.player.play(" apple "); assert.equal(f.spoken[0].text, "apple"); assert.equal(f.spoken[0].lang, "en-US");
});
test("replay cancels and ignores stale callbacks; stop invalidates active callbacks", () => {
  const f = fixture(); f.player.play("one"); const old = f.spoken[0];
  f.player.play("two"); const current = f.spoken[1];
  current.onstart?.({} as SpeechSynthesisEvent); old.onerror?.({} as SpeechSynthesisErrorEvent);
  assert.deepEqual(f.states.at(-1), [true, ""]); assert.equal(f.cancels(), 1);
  f.player.stop(); current.onstart?.({} as SpeechSynthesisEvent);
  assert.deepEqual(f.states.at(-1), [false, ""]); assert.equal(f.cancels(), 2);
});
test("errors allow retry and normal completion resets state", () => {
  const f = fixture(); f.fail(true); f.player.play("one"); assert.ok(f.states.at(-1)?.[1]);
  f.fail(false); f.player.play("two"); f.spoken[0].onerror?.({} as SpeechSynthesisErrorEvent); assert.ok(f.states.at(-1)?.[1]);
  f.player.play("three"); f.spoken[1].onend?.({} as SpeechSynthesisEvent); assert.deepEqual(f.states.at(-1), [false, ""]);
  f.player.play(" "); assert.equal(f.spoken.length, 2);
});
