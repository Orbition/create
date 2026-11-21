// The key-driven list (src/menu.js) on its own, with a stand-in terminal.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { choose } from '../src/menu.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';

/** A raw-mode terminal stand-in, and a list shown in it. */
function list({ columns = 80, ...options } = {}) {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: (mode) => Object.assign(stdin, { isRaw: mode }),
  });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns });
  let written = '';
  stdout.on('data', (chunk) => (written += chunk));
  const stopped = new AbortController();
  const chosen = choose({
    stdin,
    stdout,
    question: 'Pick?',
    hint: '(keys)',
    items: [{ label: 'One' }, { label: 'Two', note: 'later', disabled: true }, { label: 'Three' }],
    summary: (choice) => JSON.stringify(choice),
    signal: stopped.signal,
    interrupt: () => stopped.abort(new Error('interrupted')),
    ended: () => new Error('ended'),
    ...options,
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return { stdin, stdout, chosen, written: () => written, tick, stopped };
}

test('a choice: disabled items are skipped, and the list leaves one line and no listener', async () => {
  const shown = list();
  assert.equal(shown.stdin.isRaw, true);
  shown.stdin.write(DOWN);
  await shown.tick();
  shown.stdin.write('\r');
  assert.equal(await shown.chosen, 2);
  assert.match(shown.written(), /Pick\? 2\n$/);
  assert.equal(shown.stdin.isRaw, false);
  assert.equal(shown.stdin.listenerCount('keypress'), 0);
  assert.equal(shown.stdin.listenerCount('end'), 0);
});

test('keys that arrive with the choosing Enter are dropped, not kept for the next list', async () => {
  const first = list();
  first.stdin.write(`${DOWN}\r\r${UP}`);
  assert.equal(await first.chosen, 2);
  // The same input, read by a second list: nothing typed earlier answers it.
  const second = choose({
    stdin: first.stdin,
    stdout: first.stdout,
    question: 'Next?',
    hint: '',
    items: [{ label: 'A' }, { label: 'B' }],
    summary: String,
    signal: first.stopped.signal,
    interrupt: () => {},
    ended: () => new Error('ended'),
  });
  let settled = false;
  second.then(() => (settled = true));
  await first.tick();
  await first.tick();
  assert.equal(settled, false);
  first.stdin.write('\r');
  assert.equal(await second, 0);
});

test('keys typed after the choosing Enter, in a read of their own, answer the next list once it is shown', async () => {
  const first = list();
  first.stdin.write('\r');
  assert.equal(await first.chosen, 0);
  // Typed before the next list exists: kept, not dropped.
  first.stdin.write(DOWN);
  first.stdin.write('\r');
  await first.tick();
  const second = choose({
    stdin: first.stdin,
    stdout: first.stdout,
    question: 'Next?',
    hint: '',
    items: [{ label: 'A' }, { label: 'B' }],
    summary: String,
    signal: first.stopped.signal,
    interrupt: () => {},
    ended: () => new Error('ended'),
  });
  assert.equal(await second, 1);
  // The list was shown before the kept keys answered it.
  assert.ok(first.written().includes('Next? \n  ❯ A\n    B\n'));
  assert.ok(first.written().endsWith('Next? 1\n'));
});

test('a redraw goes back over every row: a line exactly as wide as the terminal takes one', async () => {
  // "Pick? (keys)" is 12 characters; "  ❯ One" 7; "    Two    later" 16; "    Three" 9.
  const exact = list({ columns: 12 });
  const before = exact.written().length;
  exact.stdin.write(DOWN);
  await exact.tick();
  // 1 + 1 + 2 + 1 rows.
  assert.ok(exact.written().slice(before).startsWith('\x1b[5A'), JSON.stringify(exact.written().slice(before)));
  exact.stdin.write('\r');
  await exact.chosen;
});

test('a terminal resized between keys is erased at its new width', async () => {
  const shown = list({ columns: 80 });
  shown.stdout.columns = 8;
  const before = shown.written().length;
  shown.stdin.write(DOWN);
  await shown.tick();
  // At 8 columns: 12 → 2 rows, 7 → 1, 16 → 2, 9 → 2.
  assert.ok(shown.written().slice(before).startsWith('\x1b[7A'), JSON.stringify(shown.written().slice(before)));
  shown.stdin.write('\r');
  await shown.chosen;
});

test('Ctrl+C interrupts, Ctrl+D and the input ending end it; each leaves the terminal as it was', async () => {
  const interrupted = list();
  interrupted.stdin.write('\x03');
  await assert.rejects(interrupted.chosen, /interrupted/);
  const ctrlD = list();
  ctrlD.stdin.write('\x04');
  await assert.rejects(ctrlD.chosen, /ended/);
  const ended = list();
  ended.stdin.end();
  await assert.rejects(ended.chosen, /ended/);
  for (const shown of [interrupted, ctrlD, ended]) {
    assert.equal(shown.stdin.isRaw, false);
    assert.equal(shown.stdin.listenerCount('keypress'), 0);
    assert.equal(shown.stdin.listenerCount('end'), 0);
  }
});

test('several: at least one must be marked', async () => {
  const shown = list({ multiple: true, marked: [0] });
  shown.stdin.write(' ');
  await shown.tick();
  shown.stdin.write('\r');
  await shown.tick();
  assert.match(shown.written(), /Choose at least one/);
  shown.stdin.write(DOWN);
  await shown.tick();
  shown.stdin.write(' ');
  await shown.tick();
  shown.stdin.write('\r');
  assert.deepEqual(await shown.chosen, [2]);
});
