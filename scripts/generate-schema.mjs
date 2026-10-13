import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { configSchema } from '../src/config.ts';

const file = new URL('../schemas/config-v1.schema.json', import.meta.url);
const schema = z.toJSONSchema(configSchema, { io: 'input', target: 'draft-2020-12' });
const output = JSON.stringify(schema, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8') !== output) {
    console.error('Config input schema is stale. Run npm run schema:generate and review the diff.');
    process.exitCode = 1;
  }
} else {
  await writeFile(file, output);
}
