import { pack, checksum } from '../server/content.js';
import { validatePack } from '../server/content-model.js';
const release = process.argv.includes('--release');
validatePack(pack, release);
console.log(`内容校验通过：${pack.entries.length} 条答案，${pack.prompts.length} 个常用题面，${pack.commonAnswerIds.length} 条难度参考词；${pack.version}\nSHA256 ${checksum}${release ? '' : '\n本地开发词库，自动清洗不等于人工审核，来源授权仍待确认。'}`);
