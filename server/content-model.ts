import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

export interface IdiomEntry {
  answerId: string;
  text: string;
  aliases: string[];
  initials: string | null;
  tags: string[];
  source: string;
  license: string;
  reviewStatus: 'pending' | 'approved';
}
export interface ContentPack {
  schemaVersion: 2;
  packId: string;
  version: string;
  status: 'draft' | 'approved';
  checksum: string;
  sources: { sourceId: string; revision: string; sha256: string; dataRightsStatus: 'pending-review' | 'approved' }[];
  prompts: string[];
  commonAnswerIds: string[];
  entries: IdiomEntry[];
}
export const sha256 = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
export function packChecksum(pack: Omit<ContentPack, 'checksum'> | ContentPack) {
  const { checksum: _, ...payload } = pack as ContentPack;
  return sha256(JSON.stringify(payload));
}
export function validatePack(pack: ContentPack, release = false) {
  assert.equal(pack.schemaVersion, 2, '不支持的题包格式');
  assert(pack.packId && pack.version, '缺少题包身份或版本');
  assert.equal(pack.checksum, packChecksum(pack), '题包校验和不符，请重新构建');
  assert(pack.sources.length > 0, '缺少来源');
  const ids = new Set<string>(), texts = new Set<string>();
  for (const source of pack.sources) {
    assert(source.sourceId && source.revision && /^[a-f0-9]{64}$/.test(source.sha256), '来源记录不完整');
    if (release) assert.equal(source.dataRightsStatus, 'approved', '发布被阻止：数据来源授权尚未确认');
  }
  for (const entry of pack.entries) {
    assert(entry.answerId && !ids.has(entry.answerId), `重复 ID：${entry.answerId}`); ids.add(entry.answerId);
    for (const text of [entry.text, ...entry.aliases]) {
      assert(/^\p{Script=Han}{4}$/u.test(text), `非法答案：${text}`);
      assert(!texts.has(text), `答案或别名冲突：${text}`); texts.add(text);
    }
    assert(entry.source && entry.license, `缺少来源或授权信息：${entry.text}`);
    assert(entry.initials === null || /^[a-z]{4}$/.test(entry.initials), `无效首字母：${entry.text}`);
    if (release) assert(entry.reviewStatus === 'approved' && entry.license !== 'pending-review', '发布被阻止：内容尚未完成人工复核与授权确认');
  }
  const common = new Set(pack.commonAnswerIds);
  assert.equal(common.size, pack.commonAnswerIds.length, '常用答案 ID 重复');
  for (const id of common) assert(ids.has(id), `常用答案不存在：${id}`);
  assert.equal(new Set(pack.prompts).size, pack.prompts.length, '题面重复');
  for (const prompt of pack.prompts) {
    assert(/^\p{Script=Han}$/u.test(prompt), `非法题面：${prompt}`);
    const available = pack.entries.filter(e => common.has(e.answerId) && e.text.includes(prompt));
    assert(available.length >= 12, `题面 ${prompt} 不足 12 个常用答案`);
  }
  assert(pack.prompts.length >= (release ? 30 : 10), '题面数量不足');
  assert(pack.entries.length >= (release ? 500 : 120), '词条数量不足');
  if (release) assert.equal(pack.status, 'approved', '题包尚未审核');
}
