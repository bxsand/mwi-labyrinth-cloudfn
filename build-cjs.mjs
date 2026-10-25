// build-cjs.mjs — 由 ESM 源生成 CommonJS 版本
// 目的：FunctionGraph 的 Node 运行时不一定尊重 package.json 的 type=module，
// 若它用 require() 加载入口，ESM 会直接抛 ERR_REQUIRE_ESM。所以两版都准备好。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'dist-cjs');
fs.mkdirSync(OUT, { recursive: true });

// ---------- wsclient: ESM → CJS
let ws = fs.readFileSync(path.join(HERE, 'wsclient.mjs'), 'utf8');
ws = ws.replace(/^import tls from 'node:tls';$/m, "const tls = require('node:tls');")
       .replace(/^import crypto from 'node:crypto';$/m, "const crypto = require('node:crypto');")
       .replace(/^export function connectWs\(/m, 'function connectWs(');
if (!/module\.exports/.test(ws)) ws += '\nmodule.exports = { connectWs };\n';
fs.writeFileSync(path.join(OUT, 'wsclient.js'), ws, 'utf8');

// ---------- index: ESM → CJS
let idx = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
idx = idx
  .replace(/^import \{ connectWs \} from '\.\/wsclient\.mjs';$/m, "const { connectWs } = require('./wsclient.js');")
  .replace(/^import fs from 'node:fs';$/m, "const fs = require('node:fs');")
  .replace(/^export async function runOnce\(/m, 'async function runOnce(')
  .replace(/^export async function handler\(/m, 'async function handler(');

// 顶层 await（本地 CLI 那段）在 CJS 里不合法，整体包成 async IIFE
const cliMark = '// ---------------------------------------------------------------- 本地 CLI';
const cut = idx.indexOf(cliMark);
if (cut < 0) throw new Error('找不到本地 CLI 段落');
const head = idx.slice(0, cut);
const tail = idx.slice(cut);
const wrappedTail = tail
  .replace(/^if \(process\.argv\[1\].*$/m, 'if (require.main === module) {\n  (async () => {')
  .replace(/\n\}\s*$/, '\n  })();\n}\n');

idx = head + wrappedTail + '\nexports.handler = handler;\n';
fs.writeFileSync(path.join(OUT, 'index.js'), idx, 'utf8');

// CommonJS 包不需要 type=module
fs.writeFileSync(path.join(OUT, 'package.json'),
  JSON.stringify({ name: 'mwi-cloudfn', version: '0.1.0', private: true, main: 'index.js' }, null, 2) + '\n',
  'utf8');

// ---------- 单文件版：把 wsclient 内联进 index.js
// 用途：控制台「上传代码」走原生文件对话框，CDP 抓不到；而在线编辑器里只有一个 index.js，
// 所以把两个文件合成一个，直接写进编辑器即可。
let single = ws.replace(/\nmodule\.exports = \{ connectWs \};\s*$/, '\n');
single = single.replace(/^const tls = require\('node:tls'\);$/m, "const tls = require('node:tls');");
const idxNoRequire = idx.replace(/^const \{ connectWs \} = require\('\.\/wsclient\.js'\);$/m, '');
single = '// ===== mwi-cloudfn 单文件构建（wsclient + index）=====\n'
  + single + '\n// ===== 入口与逻辑 =====\n' + idxNoRequire;
const singleDir = path.join(HERE, 'dist-single');
fs.mkdirSync(singleDir, { recursive: true });
fs.writeFileSync(path.join(singleDir, 'index.js'), single, 'utf8');
// 关键：上层 package.json 是 type=module，这里必须自带一个 CJS 的声明
fs.writeFileSync(path.join(singleDir, 'package.json'),
  JSON.stringify({ name: 'mwi-cloudfn', version: '0.1.0', private: true, main: 'index.js' }, null, 2) + '\n',
  'utf8');
execFileSync(process.execPath, ['--check', path.join(singleDir, 'index.js')], { stdio: 'inherit' });
console.log('语法 OK: dist-single/index.js  (' + single.length + ' 字节)');

// ---------- 语法校验
for (const f of ['wsclient.js', 'index.js']) {
  execFileSync(process.execPath, ['--check', path.join(OUT, f)], { stdio: 'inherit' });
  console.log('语法 OK:', f);
}
console.log('输出目录:', OUT);
