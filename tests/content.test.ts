import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pack, validateAnswer, choosePrompt, promptAnswers, commonPromptAnswers, createContentIndex } from '../server/content.js';
import { packChecksum, validatePack, type IdiomEntry } from '../server/content-model.js';
import { buildContent, type SourceManifest, type Overrides } from '../scripts/lib/build-content.js';

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const seed = json('../content/idioms.v0.1.json') as { entries: IdiomEntry[] };
const common = json('../content/idioms.seed.json') as Record<string, string[]>;
const source = json('../content/sources/chinese-xinhua/manifest.json') as SourceManifest;
const emptyOverrides = (): Overrides => ({ additions: [], aliases: [], exclude: [], requiredAnswers: [] });

test('expanded dictionary accepts reported missing words under every matching prompt', () => {
  assert.ok(pack.entries.length > 29_000);
  for (const [word, prompts] of [['不拘一格', ['不', '一']], ['水天一色', ['水', '天', '一']]] as const) {
    const entry = validateAnswer(word, prompts[0], new Set()).entry!;
    assert.ok(entry, word);
    assert.ok(!pack.commonAnswerIds.includes(entry.answerId), 'valid answers need not be in the difficulty list');
    for (const prompt of prompts) {
      assert.equal(validateAnswer(word, prompt, new Set()).entry?.answerId, entry.answerId);
      assert.ok(promptAnswers.get(prompt)?.has(entry.answerId));
      assert.equal(validateAnswer(word, prompt, new Set([entry.answerId])).errorCode, 'ALREADY_USED');
    }
  }
  assert.equal(validateAnswer('不拘一格', '水', new Set()).errorCode, 'PROMPT_MISMATCH');
});
test('common existing answers and IDs survive the import', () => {
  for (const entry of seed.entries) {
    const current = pack.entries.find(e => e.text === entry.text)!;
    assert.equal(current.answerId, entry.answerId, entry.text);
  }
  assert.equal(validateAnswer('心想事成', '心', new Set()).entry?.text, '心想事成');
});
test('rare answer volume cannot keep an exhausted common prompt in rotation', () => {
  const commonIds = new Set(pack.commonAnswerIds);
  assert.ok([...promptAnswers.get('水')!].filter(id => !commonIds.has(id)).length > 100);
  assert.equal(choosePrompt(commonIds, []), undefined);
  for (const [prompt, ids] of commonPromptAnswers) {
    assert.ok(ids.size >= 12, prompt);
    const used = new Set([...ids].slice(0, ids.size - 7));
    for (const p of pack.prompts) if (p !== prompt) for (const id of commonPromptAnswers.get(p)!) used.add(id);
    assert.notEqual(choosePrompt(used, [], () => 0), prompt);
  }
});
test('cleaning removes non-four-character entries and deduplicates deterministically', () => {
  const rows = [{ word: '水天一色', abbreviation: 'stys' }, { word: ' 不拘一格 ' }, { word: '水天一色' }, { word: '哀莫大于心死' }, { word: '测试，词语' }];
  const result = buildContent(rows, source, seed, common, emptyOverrides());
  assert.equal(result.report.duplicates, 1); assert.equal(result.report.excludedCount, 2);
  const a = result.pack.entries.find(e => e.text === '不拘一格')!;
  const reversed = buildContent([...rows].reverse(), source, seed, common, emptyOverrides());
  assert.equal(reversed.pack.entries.find(e => e.text === a.text)?.answerId, a.answerId);
  const deterministicRows = [rows[0], rows[1]];
  assert.deepEqual(buildContent(deterministicRows, source, seed, common, emptyOverrides()).pack,
    buildContent([...deterministicRows].reverse(), source, seed, common, emptyOverrides()).pack);
});
test('local additions persist, exclusions take precedence, alias IDs prevent repeated scoring', () => {
  const overrides = emptyOverrides();
  overrides.additions.push({ answerId: 'local-test', text: '不拘一格', aliases: [], initials: 'bjyg', tags: ['local'], source: 'test-fixture', license: 'pending-review', reviewStatus: 'pending' });
  overrides.exclude.push({ text: '水天一色', reason: 'test-only exclusion' });
  overrides.aliases.push({ text: '马到成功', aliases: ['馬到成功'], reason: 'test-only explicit alias' });
  const result = buildContent([{ word: '水天一色' }], source, seed, common, overrides);
  const index = createContentIndex(result.pack);
  assert.equal(index.validateAnswer('不拘一格', '不', new Set()).entry?.answerId, 'local-test');
  assert.equal(index.validateAnswer('水天一色', '水', new Set()).errorCode, 'NOT_INCLUDED');
  const canonical = index.validateAnswer('马到成功', '马', new Set()).entry!;
  assert.equal(index.validateAnswer('馬到成功', '马', new Set()).entry?.answerId, canonical.answerId);
  assert.equal(index.validateAnswer('馬到成功', '马', new Set([canonical.answerId])).errorCode, 'ALREADY_USED');
});
test('conflicting overrides and missing required words fail the build', () => {
  const aliases = emptyOverrides(); aliases.aliases.push({ text: '马到成功', aliases: ['一马当先'], reason: 'test conflict' });
  assert.throws(() => buildContent([], source, seed, common, aliases), /冲突/);
  const required = emptyOverrides(); required.requiredAnswers.push('水天一色');
  assert.throws(() => buildContent([], source, seed, common, required), /必备成语缺失/);
});
test('tampering fails checksum verification; changed data gets a new version', () => {
  const changed = structuredClone(pack); changed.entries[0].text = '测试篡改';
  assert.throws(() => validatePack(changed), /校验和/);
  const a = buildContent([], source, seed, common, emptyOverrides()).pack;
  const b = buildContent([{ word: '水天一色' }], source, seed, common, emptyOverrides()).pack;
  assert.notEqual(a.version, b.version); assert.notEqual(a.checksum, b.checksum);
  assert.equal(packChecksum(a), a.checksum);
});
test('an imported dictionary is still blocked from release until reviewed', () => {
  assert.throws(() => validatePack(pack, true), /授权尚未确认/);
  assert.ok(pack.entries.filter(e => e.tags.includes('imported')).every(e => e.reviewStatus === 'pending'));
});
