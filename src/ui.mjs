// Terminal görünümü: renk, adım başlıkları, dönen gösterge. Bağımlılık yok.
// Renk yalnız gerçek bir terminalde ve NO_COLOR tanımlı değilken açılır;
// servis logu (launchd/systemd) düz metin kalır.

const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (open, close) => (s) => (useColor() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  green: wrap(32, 39),
  red: wrap(31, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
  violet: wrap('38;5;141', 39),
};

const PAD = '  ';
const IND = '       ';

export const ui = {
  title(text) {
    console.log(`\n${PAD}${c.violet('◆')} ${c.bold(text)}\n`);
  },
  step(n, total, text) {
    console.log(`${PAD}${c.violet(`${n}/${total}`)}  ${c.bold(text)}`);
  },
  line(text = '') {
    console.log(text ? `${IND}${text}` : '');
  },
  ok(text) {
    console.log(`${IND}${c.green('✓')} ${text}`);
  },
  fail(text, hint) {
    console.log(`${IND}${c.red('✗')} ${text}`);
    if (hint) console.log(`${IND}  ${c.dim('→')} ${c.cyan(hint)}`);
  },
  warn(text) {
    console.log(`${IND}${c.yellow('!')} ${text}`);
  },
  code(label, value) {
    console.log(`${IND}${c.dim(label.padEnd(5))} ${c.bold(c.cyan(value))}`);
  },
  gap() {
    console.log('');
  },
  /** "Sırada ne var" kutusu. */
  done(title, lines) {
    const head = c.bold(c.green(`✓ ${title}`));
    const rows = [head, ...lines.map((l) => ` ${l}`)];
    const width = Math.max(...rows.map((r) => strip(r).length)) + 2;
    const edge = (l, r) => c.green(l + '─'.repeat(width + 2) + r);
    console.log(`\n${PAD}${edge('┌', '┐')}`);
    for (const r of rows) console.log(`${PAD}${c.green('│')} ${r}${' '.repeat(width - strip(r).length)} ${c.green('│')}`);
    console.log(`${PAD}${edge('└', '┘')}\n`);
  },
  /** Dönen gösterge; TTY değilse tek satır yazar. */
  spinner(text) {
    if (!process.stdout.isTTY) {
      console.log(`${IND}${text}`);
      return { stop: () => {} };
    }
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const draw = () => process.stdout.write(`\r${IND}${c.violet(frames[i++ % frames.length])} ${c.dim(text)}   `);
    draw();
    const t = setInterval(draw, 90);
    return {
      stop() {
        clearInterval(t);
        process.stdout.write(`\r${' '.repeat(IND.length + text.length + 6)}\r`);
      },
    };
  },
};

export function strip(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** Soru: vurgulu, varsayılan cevap köşeli parantezde, Enter = kabul. */
export async function ask(question, def) {
  if (!process.stdin.isTTY) return def;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`${IND}${c.bold(question)}`);
    const a = (await rl.question(`${IND}${c.violet('›')} ${def ? c.dim(`[${def}] `) : ''}`)).trim();
    return a || def;
  } finally {
    rl.close();
  }
}
