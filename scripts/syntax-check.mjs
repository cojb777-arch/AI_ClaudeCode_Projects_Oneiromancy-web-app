// scripts/syntax-check.mjs — JavaScript の構文チェック（汎用）
// - .js / .mjs / .cjs ファイル: CommonJS / ES Modules どちらかで合格すれば OK
// - .html ファイル: インラインの <script> ブロックを抽出してチェック
// 使い方: node scripts/syntax-check.mjs
import { execFileSync } from 'node:child_process';
import {
  readdirSync, statSync, readFileSync, writeFileSync,
  copyFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out',
  'test-results', 'playwright-report', '.next', 'coverage',
]);

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (/\.(js|mjs|cjs|html?)$/.test(name) && !/\.min\.js$/.test(name)) out.push(p);
  }
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), 'syntax-'));
let seq = 0;

function nodeCheck(file) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

// CJS → だめなら ESM(.mjs) として再判定。両方失敗なら最初のエラーを返す
function checkJsFile(file) {
  try {
    nodeCheck(file);
    return null;
  } catch (e) {
    const firstError = e.stderr?.toString() || e.message;
    if (!file.endsWith('.cjs')) {
      const alt = join(tmp, `${seq++}-${basename(file)}.mjs`);
      try {
        copyFileSync(file, alt);
        nodeCheck(alt);
        return null;
      } catch {
        return firstError;
      }
    }
    return firstError;
  }
}

// HTML からインライン <script>（src なし）を抜き出してチェック
function checkHtmlFile(file) {
  const html = readFileSync(file, 'utf8');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const failures = [];
  let m;
  let idx = 0;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const code = m[2];
    idx++;
    if (/\bsrc\s*=/i.test(attrs)) continue;            // 外部参照はスキップ
    const type = /\btype\s*=\s*["']?([\w/+-]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') {
      continue;                                        // JSON-LD やテンプレート等はスキップ
    }
    if (!code.trim()) continue;
    const line = html.slice(0, m.index).split('\n').length;
    const isModule = type === 'module';
    const ext = isModule ? '.mjs' : '.js';
    const blob = join(tmp, `${seq++}-${basename(file)}.script${idx}${ext}`);
    writeFileSync(blob, code);
    const err = checkJsFile(blob);
    if (err) failures.push(`  <script> #${idx} (line ~${line}):\n${err}`);
  }
  return failures.length ? failures.join('\n') : null;
}

const files = collect('.');
let checked = 0;
let failed = 0;
for (const f of files) {
  const err = /\.html?$/.test(f) ? checkHtmlFile(f) : checkJsFile(f);
  checked++;
  if (err) {
    failed++;
    console.error(`FAIL ${f}\n${err}`);
  } else {
    console.log(`OK   ${f}`);
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${checked} files checked, ${failed} failed`);
process.exit(failed ? 1 : 0);
