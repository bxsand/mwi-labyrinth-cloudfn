// index.js — 华为云 FunctionGraph 入口（零依赖）
//
// 每次触发做一轮"短任务"：连接 → 收 init → 判定 → 发 0~3 个包 → 断开 → 返回摘要。
// 不依赖浏览器，也不依赖 npm 包：WebSocket 用 node:tls 手写，任何 Node ≥16 都能跑。
//
// 环境变量：
//   MWI_TOKEN       访问令牌（Cookie: accessToken=... 的值）  ※必填，建议用 KMS/加密环境变量
//   MWI_URL         完整握手 URL（含 hash 与版本参数）        ※必填
//   MWI_LIVE        "1" 才真正发包；否则只判定（默认 dry-run）
//   MWI_RESTART_AT_CAP  "0" 表示到停止层不重开（默认 1）
//
// 本地测试：node index.js --handshake ../poc/handshake.json [--live]

import { connectWs } from './wsclient.mjs';
import fs from 'node:fs';

// ---------------------------------------------------------------- 状态
function createState() {
  return {
    labyrinth: null,
    actions: null,
    info: {},
    setting: {},
    resetAt: 0,
    gotInit: false,
    messages: {}
  };
}

function applyFrame(S, o) {
  if (!o || !o.type) return;
  S.messages[o.type] = (S.messages[o.type] || 0) + 1;

  if (o.type === 'labyrinth_reset_cooldown_updated' && o.nextResetTime) {
    const ts = Date.parse(o.nextResetTime);
    if (!isNaN(ts)) S.resetAt = ts;
    return;
  }
  if (o.characterSetting) S.setting = Object.assign(S.setting, o.characterSetting);

  if (o.type === 'init_character_data') {
    S.labyrinth = o.labyrinth || null;
    S.actions = o.characterActions || [];
    S.info = o.characterInfo || {};
    S.setting = o.characterSetting || S.setting;
    S.gotInit = true;
    return;
  }
  if (o.type === 'labyrinth_updated' && o.labyrinth) { S.labyrinth = o.labyrinth; return; }
  if (o.type === 'actions_updated' && o.endCharacterActions) { S.actions = o.endCharacterActions; return; }
  if (o.type === 'character_info_updated' && o.characterInfo) {
    S.info = Object.assign(S.info, o.characterInfo);
  }
}

// ---------------------------------------------------------------- 判定
function snapshot(S) {
  const lab = S.labyrinth || {};
  const acts = S.actions || [];
  const running = acts.some((a) => a && typeof a.actionHrid === 'string'
    && a.actionHrid.indexOf('/actions/labyrinth/') === 0 && !a.isDone);
  const set = Number(S.setting.labyrinthFullAutoFloor) || 0;
  const unlocked = Number(S.info.labyrinthFullAutoLevel) || 0;
  const cap = (set > 0 && unlocked > 0) ? Math.min(set, unlocked) : (set || unlocked);
  return {
    runActive: !!lab.isActive,
    floor: lab.currentFloor != null ? lab.currentFloor : null,
    actionRunning: running,
    cap,
    tickets: S.info.labyrinthEntries != null ? S.info.labyrinthEntries : null,
    restartsAtCap: S.setting.labyrinthFullAutoFloor
  };
}

/**
 * 决定这一轮要发哪些包。
 * 与油猴脚本 v1.2.0 完全一致的三分支，顺序也有意义：
 *   没开 → 开一轮 + 立刻启动房间
 *   开着但没动且未到停止层 → 启动房间
 *   开着但没动且已到停止层 → 结束本轮（下一次触发会自动开新的）
 */
function decide(s, cfg) {
  const plan = [];
  if (!s.runActive) {
    if (s.tickets === 0) {
      plan.push({ type: 'force_refill_labyrinth_entries', why: '入场券为 0，补票' });
    } else {
      plan.push({ type: 'start_labyrinth', startLabyrinthData: {}, why: '开一轮迷宫' });
      plan.push({ type: 'new_character_action', newCharacterActionData: roomAction(), why: '启动房间' });
    }
    return plan;
  }
  if (s.actionRunning) return plan; // 正常，什么都不做

  if (cfg.restartAtCap && s.cap > 0 && s.floor != null && s.floor >= s.cap) {
    plan.push({ type: 'escape_labyrinth', why: '已到停止层 ' + s.floor + '/' + s.cap + '，结束本轮' });
    return plan;
  }
  plan.push({ type: 'new_character_action', newCharacterActionData: roomAction(), why: '启动当前房间' });
  return plan;
}

function roomAction() {
  return {
    actionHrid: '/actions/labyrinth/explore',
    difficultyTier: 0,
    hasMaxCount: false,
    maxCount: 0,
    primaryItemHash: '',
    secondaryItemHash: '',
    enhancingMaxLevel: 0,
    enhancingProtectionMinLevel: 0,
    characterLoadoutId: 0,
    isStartNow: true,
    confirmedActionValueWarning: false
  };
}

// ---------------------------------------------------------------- 一次执行
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 刚结束一轮后，在同一次调用里接着开新的。
 * 不这么做的话，角色要闲到下一次触发（最多 15 分钟）才被重新拉起来。
 */
async function startNextRun(conn, S, cfg) {
  const steps = [];
  const waitFor = async (pred, ms) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await sleep(120);
    return pred();
  };

  // ① 等本轮真正结束
  if (!(await waitFor(() => !snapshot(S).runActive, 5000))) {
    return { ok: false, reason: '本轮未在 5 秒内结束', steps };
  }

  // ② 没票就先补（要过冷却）
  let s = snapshot(S);
  if (s.tickets === 0) {
    if (S.resetAt > Date.now()) {
      return { ok: false, reason: '无入场券且补票冷却中，可用时间 ' + new Date(S.resetAt).toISOString(), steps };
    }
    conn.send({ type: 'force_refill_labyrinth_entries', ts: Date.now() });
    steps.push('补入场券');
    await sleep(1500);
    s = snapshot(S);
    if (!s.tickets) return { ok: false, reason: '补票后仍无入场券', steps };
  }

  // ③ 开新一轮
  conn.send({ type: 'start_labyrinth', startLabyrinthData: {}, ts: Date.now() });
  steps.push('开新一轮');
  if (!(await waitFor(() => snapshot(S).runActive, 5000))) {
    return { ok: false, reason: '开局未在 5 秒内生效', steps };
  }

  // ④ 立刻把房间点起来，否则游戏自带的自动化不会接手
  await sleep(600);
  conn.send({ type: 'new_character_action', newCharacterActionData: roomAction(), ts: Date.now() });
  steps.push('启动房间');
  await sleep(1800);

  const end = snapshot(S);
  return { ok: true, steps, floor: end.floor, actionRunning: end.actionRunning, tickets: end.tickets };
}

export async function runOnce(cfg) {
  const result = { at: new Date().toISOString(), live: cfg.live, steps: [] };
  const S = createState();

  let conn;
  try {
    conn = await connectWs({
      url: cfg.url,
      headers: { Cookie: 'accessToken=' + cfg.token },
      timeoutMs: cfg.connectTimeoutMs || 15000
    });
    result.steps.push('handshake ok');
  } catch (e) {
    result.ok = false;
    result.error = 'handshake failed: ' + e.message;
    return result;
  }

  let closedByServer = false;
  conn.on('message', (raw) => {
    let o = null;
    try { o = JSON.parse(raw); } catch { return; }
    applyFrame(S, o);
  });
  conn.on('close', () => { closedByServer = true; });

  // 等 init_character_data。正常情况下 0.5~2 秒就到，所以超时默认 12 秒即可，
  // 失败时也不会白等满（计费按执行时长算）。
  const waitStart = Date.now();
  const deadline = waitStart + (cfg.initTimeoutMs || 12000);
  while (!S.gotInit && !closedByServer && Date.now() < deadline) {
    // 收到全局广播却等不到角色数据 → 角色已被别处占用，不必等满
    if (S.messages.market_item_values_updated && Date.now() - waitStart > 4000) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!S.gotInit) {
    result.ok = false;
    // 三种失败要分开说，否则会把人误导到"令牌过期"上
    if (S.messages.init_character_data) {
      result.error = 'init 已到但状态机没接住（代码问题）';
    } else if (closedByServer) {
      result.error = '连接被服务端关闭：通常是你正在浏览器里登录该角色（单会话互顶）';
    } else if (S.messages.market_item_values_updated) {
      // 能收到全局广播 = 握手与令牌都正常，只是没拿到角色数据。
      // 实测：服务端在客户端断开后仍保留该角色会话约 1~3 分钟，期间新连接拿不到 init。
      result.error = '握手成功但未收到 init_character_data：多为"影子期"（上次连接后服务端仍保留会话约 1~3 分钟），'
        + '也可能是角色正在别处登录。建议间隔 4 分钟以上再试';
    } else {
      result.error = '未收到 init_character_data 且无任何下行数据：检查 MWI_TOKEN 是否过期 / MWI_URL 是否完整';
    }
    result.messages = S.messages;
    result.closedByServer = closedByServer;
    conn.close();
    return result;
  }

  const before = snapshot(S);
  result.before = before;

  const plan = decide(before, cfg);
  result.plan = plan.map((p) => p.why);

  if (cfg.live) {
    for (const p of plan) {
      const packet = Object.assign({}, p);
      delete packet.why;
      conn.send(Object.assign(packet, { ts: Date.now() }));
      await new Promise((r) => setTimeout(r, cfg.stepDelayMs || 1500));
    }
    // 刚结束了本轮 → 直接接着开新一轮，别让角色闲到下一次触发
    if (plan.some((p) => p.type === 'escape_labyrinth')) {
      result.followUp = await startNextRun(conn, S, cfg);
    }
    // 等一下让服务端回包，便于确认有没有被接受；什么都没发就不用等
    if (plan.length) await new Promise((r) => setTimeout(r, 2000));
    result.after = snapshot(S);
  }

  result.ok = true;
  result.messages = S.messages;
  conn.close();
  return result;
}

// ---------------------------------------------------------------- 入口
export async function handler(event, context) {
  // 自检：只报告"有没有"和取值，不打印密钥本身，用于确认环境变量是否真的送达函数
  const envDiag = {
    hasToken: !!process.env.MWI_TOKEN,
    tokenLen: (process.env.MWI_TOKEN || '').length,
    hasUrl: !!process.env.MWI_URL,
    urlLen: (process.env.MWI_URL || '').length,
    liveVar: process.env.MWI_LIVE == null ? null : JSON.stringify(process.env.MWI_LIVE),
    mwiKeys: Object.keys(process.env).filter((k) => k.indexOf('MWI') >= 0)
  };
  const cfg = {
    token: process.env.MWI_TOKEN || '',
    url: process.env.MWI_URL || '',
    // 默认 live：本环境下环境变量送不进函数（实测 mwiKeys 为空），
    // 又要能一键退回只读，所以约定 MWI_LIVE=0 表示 dry-run，其它情况一律真发包。
    live: process.env.MWI_LIVE ? process.env.MWI_LIVE !== '0' : true,
    restartAtCap: process.env.MWI_RESTART_AT_CAP !== '0',
    initTimeoutMs: Number(process.env.MWI_INIT_TIMEOUT_MS || 20000)
  };
  if (!cfg.token || !cfg.url) {
    return { ok: false, error: '缺少 MWI_TOKEN 或 MWI_URL 环境变量', env: envDiag };
  }
  const res = await runOnce(cfg);
  res.env = envDiag;
  console.log('[mwi] ' + JSON.stringify(res));
  return res;
}

// ---------------------------------------------------------------- 本地 CLI
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const arg = (n, d) => {
    const hit = process.argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
    if (!hit) return d;
    if (hit.includes('=')) return hit.split('=')[1];
    return process.argv[process.argv.indexOf(hit) + 1];
  };
  let token = process.env.MWI_TOKEN;
  let url = process.env.MWI_URL;
  const hsFile = arg('handshake');
  if (hsFile) {
    const hs = JSON.parse(fs.readFileSync(hsFile, 'utf8'));
    url = url || hs.wsUrl;
    const jar = (hs.cookies || []).filter((c) => c.name === 'accessToken');
    token = token || (jar[0] ? jar[0].value : '');
  }
  const cfg = {
    token,
    url,
    live: process.argv.includes('--live'),
    restartAtCap: !process.argv.includes('--no-restart-at-cap')
  };
  const res = await runOnce(cfg);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
