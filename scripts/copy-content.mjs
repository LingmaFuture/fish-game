import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('dist/content', { recursive: true });
copyFileSync('content/idioms.generated.json', 'dist/content/idioms.generated.json');
