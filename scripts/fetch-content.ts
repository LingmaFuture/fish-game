import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import assert from 'node:assert/strict';
import { sha256 } from '../server/content-model.js';
import type { SourceManifest } from './lib/build-content.js';

const root = new URL('../content/sources/chinese-xinhua/', import.meta.url);
const manifest: SourceManifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
assert.match(manifest.revision, /^[a-f0-9]{40}$/);
for (const file of manifest.files) {
  assert(['idiom.json', 'LICENSE', 'README.md'].includes(file.local));
  assert.equal(file.url, `https://raw.githubusercontent.com/pwxcoo/chinese-xinhua/${manifest.revision}/${file.path}`);
  const response = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `下载失败：${file.local} HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(bytes), file.sha256, `校验失败：${file.local}`);
  assert.equal(bytes.length, file.bytes, `大小不符：${file.local}`);
  const temp = new URL(`${file.local}.tmp`, root);
  writeFileSync(temp, bytes); renameSync(temp, new URL(file.local, root));
  console.log(`已恢复 ${file.local}，SHA256 校验通过`);
}
