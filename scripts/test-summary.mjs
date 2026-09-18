// Compact node:test reporter for remote CI inspection. Exit status remains node:test's.
import { inspect } from 'node:util';
export default async function* report(events) {
  let passed = 0;
  let failed = 0;
  let shown = 0;
  for await (const event of events) {
    if (event.type === 'test:pass') passed++;
    if (event.type === 'test:fail') {
      failed++;
      if (shown++ < 12) {
        const { name, file, line, details } = event.data;
        yield `FAIL ${name}\n${file || ''}:${line || ''}\n${inspect(details?.error, { depth: 4, colors: false, maxStringLength: 1800 }).slice(0, 2400)}\n`;
      }
    }
  }
  yield `RESULT passed=${passed} failed=${failed}${failed > 12 ? ' (only first 12 failures displayed)' : ''}\n`;
}
