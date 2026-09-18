import assert from 'node:assert/strict';
import { packChecksum, sha256, validatePack, type ContentPack, type IdiomEntry } from '../../server/content-model.js';

export interface Overrides {
  additions: IdiomEntry[];
  aliases: { text: string; aliases: string[]; reason: string }[];
  exclude: { text: string; reason: string }[];
  requiredAnswers: string[];
}
export interface SourceManifest {
  sourceId: string; repository: string; revision: string; retrievedAt: string;
  repositoryLicense: string; dataRightsStatus: 'pending-review' | 'approved';
  files: { path: string; local: string; url: string; sha256: string; bytes: number }[];
}
export function buildContent(raw: unknown, manifest: SourceManifest, seed: { entries: IdiomEntry[] }, commonGroups: Record<string, string[]>, overrides: Overrides) {
  assert(Array.isArray(raw), '来源数据必须是数组');
  const rawFile = manifest.files.find(f => f.path === 'data/idiom.json');
  assert(rawFile, '缺少来源文件校验和');
  const seedByText = new Map(seed.entries.map(e => [e.text, e]));
  const entries = new Map<string, IdiomEntry>();
  const excluded: { text: string; reason: string }[] = [];
  const denied = new Map<string, string>();
  for (const entry of overrides.exclude) {
    assert(entry.text && entry.reason && !denied.has(entry.text), '排除规则必须包含唯一文本与原因');
    denied.set(entry.text, entry.reason);
  }
  let duplicates = 0;
  for (const row of raw) {
    assert(row && typeof row.word === 'string', '上游记录缺少 word');
    const text = row.word.trim().normalize('NFC');
    if (!/^\p{Script=Han}{4}$/u.test(text)) { excluded.push({ text, reason: 'not_four_han_characters' }); continue; }
    if (denied.has(text)) { excluded.push({ text, reason: denied.get(text)! }); continue; }
    if (entries.has(text)) { duplicates++; continue; }
    entries.set(text, {
      answerId: seedByText.get(text)?.answerId ?? `idiom-${sha256(text).slice(0, 20)}`,
      text, aliases: [], initials: typeof row.abbreviation === 'string' && /^[a-z]{4}$/.test(row.abbreviation) ? row.abbreviation : null,
      tags: ['imported'], source: `${manifest.sourceId}@${manifest.revision}`, license: 'pending-review', reviewStatus: 'pending',
    });
  }
  let retainedSeed = 0;
  for (const entry of seed.entries) if (!entries.has(entry.text) && !denied.has(entry.text)) {
    entries.set(entry.text, structuredClone(entry)); retainedSeed++;
  }
  for (const entry of overrides.additions) {
    assert(!entries.has(entry.text) && !denied.has(entry.text), `补词冲突：${entry.text}`);
    entries.set(entry.text, structuredClone(entry));
  }
  const aliasTargets = new Set<string>();
  for (const rule of overrides.aliases) {
    assert(rule.reason && !aliasTargets.has(rule.text), '别名规则缺少原因或重复'); aliasTargets.add(rule.text);
    const entry = entries.get(rule.text); assert(entry, `别名的标准词不存在：${rule.text}`);
    for (const alias of rule.aliases) assert(!denied.has(alias), `别名被排除：${alias}`);
    entry.aliases = [...entry.aliases, ...rule.aliases];
  }
  for (const text of overrides.requiredAnswers) assert(entries.has(text), `必备成语缺失：${text}`);
  const commonIds = new Set<string>();
  for (const [prompt, words] of Object.entries(commonGroups)) {
    assert(new Set(words).size === words.length && words.length >= 12, `题面 ${prompt} 需要至少 12 个不重复的常用词`);
    for (const text of words) {
      const entry = entries.get(text); assert(entry && text.includes(prompt), `题面 ${prompt} 的常用词 ${text} 无效`);
      commonIds.add(entry.answerId);
      if (!entry.tags.includes('common')) entry.tags.push('common');
    }
  }
  const payload = {
    schemaVersion: 2 as const, packId: 'idiom-local', status: 'draft' as const,
    sources: [
      { sourceId: manifest.sourceId, revision: manifest.revision, sha256: rawFile.sha256, dataRightsStatus: manifest.dataRightsStatus },
      { sourceId: 'local-seed', revision: '0.1.0-draft', sha256: sha256(JSON.stringify(seed)), dataRightsStatus: 'pending-review' as const },
      { sourceId: 'local-overrides', revision: sha256(JSON.stringify(overrides)).slice(0, 12), sha256: sha256(JSON.stringify(overrides)), dataRightsStatus: 'pending-review' as const },
    ],
    prompts: Object.keys(commonGroups), commonAnswerIds: [...commonIds].sort(),
    entries: [...entries.values()].sort((a, b) => a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
  };
  const version = `0.2.0-local.${sha256(JSON.stringify(payload)).slice(0, 12)}`;
  const pack: ContentPack = { ...payload, version, checksum: '' }; pack.checksum = packChecksum(pack);
  validatePack(pack);
  return { pack, report: { version, sourceRevision: manifest.revision, rawRecords: raw.length,
    importedFourCharacter: entries.size - retainedSeed - overrides.additions.length, duplicates,
    retainedSeed, additions: overrides.additions.length, total: pack.entries.length, common: commonIds.size,
    prompts: pack.prompts.length, excludedCount: excluded.length, excluded,
  } };
}
