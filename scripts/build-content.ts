import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildContent, type SourceManifest, type Overrides } from './lib/build-content.js';
import { sha256, type IdiomEntry } from '../server/content-model.js';

const root = new URL('../content/', import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const manifest = read('sources/chinese-xinhua/manifest.json') as SourceManifest;
for (const file of manifest.files) {
  const bytes = readFileSync(new URL(`sources/chinese-xinhua/${file.local}`, root));
  assert.equal(sha256(bytes), file.sha256, `原始文件已变更：${file.local}`);
  assert.equal(bytes.length, file.bytes, `原始文件大小不符：${file.local}`);
}
const { pack, report } = buildContent(
  read('sources/chinese-xinhua/idiom.json'), manifest,
  read('idioms.v0.1.json') as { entries: IdiomEntry[] },
  read('idioms.seed.json'), read('idioms.overrides.json') as Overrides,
);
const output = `${JSON.stringify(pack)}\n`;
if (process.argv.includes('--check')) {
  assert.equal(readFileSync(new URL('idioms.generated.json', root), 'utf8'), output, '生成题包已过期，请运行 npm run content:build');
  assert.equal(readFileSync(new URL('import-report.json', root), 'utf8'), `${JSON.stringify(report, null, 2)}\n`, '导入报告已过期，请运行 npm run content:build');
} else {
  const temp = new URL('idioms.generated.json.tmp', root);
  writeFileSync(temp, output); renameSync(temp, new URL('idioms.generated.json', root));
  writeFileSync(new URL('import-report.json', root), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`题包 ${pack.version}：${report.rawRecords} 条原始记录 → ${report.total} 条答案；${report.excludedCount} 条排除，${report.duplicates} 条重复；${report.common} 条常用词支持 ${report.prompts} 个题面。`);
console.log(`生成文件 ${(Buffer.byteLength(output) / 1024 / 1024).toFixed(2)} MiB；SHA256 ${pack.checksum}`);
