import { readFileSync } from 'node:fs';
import { validatePack, type ContentPack } from './content-model.js';

// Loaded once per process: rebuilding the file cannot change an ongoing match.
export const pack: ContentPack = JSON.parse(readFileSync(new URL('../content/idioms.generated.json', import.meta.url), 'utf8'));
export const checksum = pack.checksum;

export function createContentIndex(content: ContentPack) {
  validatePack(content);
  const byText = new Map<string, ContentPack['entries'][number]>();
  const commonIds = new Set(content.commonAnswerIds);
  const promptAnswers = new Map(content.prompts.map(prompt => [prompt, new Set<string>()]));
  const commonPromptAnswers = new Map(content.prompts.map(prompt => [prompt, new Set<string>()]));
  for (const entry of content.entries) {
    for (const text of [entry.text, ...entry.aliases]) byText.set(text, entry);
    for (const char of new Set(entry.text)) {
      promptAnswers.get(char)?.add(entry.answerId);
      if (commonIds.has(entry.answerId)) commonPromptAnswers.get(char)?.add(entry.answerId);
    }
  }
  function choosePrompt(used: Set<string>, recent: string[], random = Math.random): string | undefined {
    // Rare entries remain valid answers but cannot make a hard prompt eligible.
    const available = [...commonPromptAnswers].filter(([, ids]) => {
      let remaining = 0;
      for (const id of ids) if (!used.has(id) && ++remaining >= 8) return true;
      return false;
    }).map(([prompt]) => prompt);
    const fresh = available.filter(p => !recent.slice(-3).includes(p));
    const candidates = fresh.length ? fresh : available;
    return candidates.length ? candidates[Math.floor(random() * candidates.length)] : undefined;
  }
  function validateAnswer(raw: string, prompt: string, used: Set<string>) {
    const answer = raw.trim().normalize('NFC');
    if (!/^\p{Script=Han}{4}$/u.test(answer)) return { errorCode: 'ANSWER_FORMAT' };
    const entry = byText.get(answer);
    if (!entry) return { errorCode: 'NOT_INCLUDED' };
    if (!entry.text.includes(prompt)) return { errorCode: 'PROMPT_MISMATCH' };
    if (used.has(entry.answerId)) return { errorCode: 'ALREADY_USED' };
    return { entry };
  }
  return { promptAnswers, commonPromptAnswers, choosePrompt, validateAnswer };
}
export const { promptAnswers, commonPromptAnswers, choosePrompt, validateAnswer } = createContentIndex(pack);
export const contentSummary = { version: pack.version, answerCount: pack.entries.length, promptCount: pack.prompts.length, status: pack.status };
