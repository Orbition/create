// A choice made with the keys, in an interactive terminal.
import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor } from 'node:readline';

/**
 * Shows a question and its items, and lets the person choose with the keys:
 * Up and Down (or k and j) move, Space marks an item when several may be chosen,
 * and Enter chooses. An item marked `disabled` is shown with its note but
 * cannot be reached. Once chosen, the list is replaced by one line: the
 * question and `summary(choice)`.
 *
 * Resolves with the chosen index, or with the marked indexes, in item order,
 * when `multiple` (at least one must be marked; `marked` are marked at
 * first). Ctrl+C calls `interrupt`, which is expected to abort `signal`; an
 * aborted `signal` rejects with its reason. The input ending, or Ctrl+D,
 * rejects with `ended()`. The terminal's mode is put back as it was.
 *
 * Keys that arrive together with the Enter that chooses (in the same read,
 * as pasted text does) are dropped. Keys typed after it are kept, and the
 * next list reads them once it is shown, as a terminal's type-ahead does.
 *
 * @param {object} options
 * @param {NodeJS.ReadStream} options.stdin
 * @param {NodeJS.WriteStream} options.stdout
 * @param {string} options.question
 * @param {string} options.hint How to answer, shown after the question.
 * @param {{ label: string, note?: string, disabled?: boolean }[]} options.items
 * @param {boolean} [options.multiple]
 * @param {number[]} [options.marked]
 * @param {number} [options.start] Where the pointer starts, if it can be there.
 * @param {(choice: number | number[]) => string} options.summary
 * @param {AbortSignal} options.signal
 * @param {() => void} options.interrupt
 * @param {() => Error} options.ended
 * @returns {Promise<number | number[]>}
 */
export function choose({
  stdin,
  stdout,
  question,
  hint,
  items,
  multiple = false,
  marked = [],
  start,
  summary,
  signal,
  interrupt,
  ended,
}) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    if (stdin.readableEnded) return reject(ended());

    const reachable = items.flatMap((item, index) => (item.disabled ? [] : [index]));
    let cursor = reachable.includes(start) ? start : reachable[0];
    const marks = new Set(marked.filter((index) => reachable.includes(index)));
    let notice = '';
    // What is on the screen, to erase it: by rows, not lines, since a line
    // wider than the terminal wraps. Counted when erasing, at the terminal's
    // width then, as a terminal that was resized has reflowed its lines. Every
    // character shown takes one column: the text is ASCII but for ❯, and the
    // person's own text is not part of a list.
    let drawn = [];
    const rows = (line) => Math.max(1, Math.ceil([...line].length / Math.max(1, stdout.columns || 80)));
    const width = Math.max(...items.map((item) => item.label.length));

    const erase = () => {
      if (drawn.length === 0) return;
      moveCursor(stdout, 0, -drawn.reduce((sum, line) => sum + rows(line), 0));
      cursorTo(stdout, 0);
      clearScreenDown(stdout);
      drawn = [];
    };
    const draw = () => {
      const lines = [
        `${question} ${hint}`,
        ...items.map((item, index) => {
          const pointer = index === cursor ? '❯' : ' ';
          const box = multiple ? `[${marks.has(index) ? 'x' : ' '}] ` : '';
          const text = item.note ? `${item.label.padEnd(width)}  ${item.note}` : item.label;
          return `  ${pointer} ${box}${text}`;
        }),
      ];
      if (notice) lines.push(`  ${notice}`);
      erase();
      stdout.write(`${lines.join('\n')}\n`);
      drawn = lines;
    };

    const wasRaw = stdin.isRaw === true;
    let settled = false;
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      stdin.off('keypress', onKey);
      stdin.off('end', onEnd);
      signal.removeEventListener('abort', onAbort);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      settle();
    };
    const move = (step) => {
      const at = reachable.indexOf(cursor);
      cursor = reachable[(at + step + reachable.length) % reachable.length];
    };
    function onKey(_text, key) {
      if (settled || key === undefined) return;
      if (key.ctrl && key.name === 'c') return interrupt();
      if (key.ctrl && key.name === 'd') return finish(() => reject(ended()));
      if (key.ctrl || key.meta) return;
      notice = '';
      if (key.name === 'up' || key.name === 'k') move(-1);
      else if (key.name === 'down' || key.name === 'j') move(1);
      else if (multiple && key.name === 'space') {
        if (marks.has(cursor)) marks.delete(cursor);
        else marks.add(cursor);
      } else if (key.name === 'return' || key.name === 'enter') {
        const choice = multiple ? reachable.filter((index) => marks.has(index)) : cursor;
        if (multiple && choice.length === 0) {
          notice = 'Choose at least one: Space marks the one under ❯.';
        } else {
          erase();
          stdout.write(`${question} ${summary(choice)}\n`);
          return finish(() => resolve(choice));
        }
      } else return;
      draw();
    }
    function onEnd() {
      finish(() => reject(ended()));
    }
    function onAbort() {
      finish(() => reject(signal.reason));
    }

    emitKeypressEvents(stdin);
    stdin.on('keypress', onKey);
    stdin.once('end', onEnd);
    signal.addEventListener('abort', onAbort, { once: true });
    stdin.setRawMode?.(true);
    draw();
    stdin.resume();
  });
}
