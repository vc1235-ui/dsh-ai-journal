#!/usr/bin/env node
/**
 * 自检 dsh-ai-journal 是否已在运行中的 DSH Web 里生效（只读；仅用合成 key 做 dismiss→restore 往返，结束时恢复原状）。
 *
 * 检查项：
 *   1. GET /ai-journal/api?kind=meta              → Host 半区路由已挂载、数据服务在位
 *   2. GET /ai-journal/api?kind=daily&…           → 日报 JSON 形状正确
 *   3. GET /ai-journal/api?kind=weekly&…          → 周报 JSON 形状正确且 days 为 7 天
 *   4. GET /ai-journal/api 带跨站 Origin          → 被 403 拒绝（本机同源 fence）
 *   5. POST /ai-journal/api                       → 405（只读接口，仅 /followups 支持 POST）
 *   6. POST /ai-journal/api/followups             → dismiss/restore 往返；非法 action 400、非 JSON 415
 *   6. GET /                                      → 浏览器启动图包含插件；需要浏览器登录
 *                                                  cookie，CLI 拿不到时记为 SKIP 而不是 FAIL
 *   7. 启动图里的 /plugins 组合脚本可下载          → 同上，依赖第 6 项
 *
 * 用法：node scripts/ai-journal-verify.mjs [--url http://127.0.0.1:3080]
 * 任一 FAIL 时退出码为 1；SKIP 不影响退出码，但会在结尾列出。
 */

const argv = process.argv.slice(2);
const urlIndex = argv.indexOf('--url');
const BASE = (urlIndex >= 0 ? argv[urlIndex + 1] : process.env.DSH_WEB_URL) || 'http://127.0.0.1:3080';
/** 与 BASE 同源的 Origin，用于通过 Host 半区的同源 fence。 */
const ORIGIN = new URL(BASE).origin;

const results = [];
function record(name, status, evidence) {
  results.push({ name, status, evidence });
  console.log(`${status.padEnd(4)}  ${name}`);
  if (evidence !== undefined) {
    for (const line of String(evidence).split('\n').slice(0, 6)) console.log(`      ${line}`);
  }
}

async function getJson(path, init) {
  const response = await fetch(new URL(path, BASE), { headers: { accept: 'application/json' }, ...init });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status} 非 JSON：${text.slice(0, 200)}`);
  }
  return { status: response.status, body };
}

function hasShape(report, expectedKind) {
  const problems = [];
  if (report?.ok !== true) problems.push('ok !== true');
  if (report?.kind !== expectedKind) problems.push(`kind !== ${expectedKind}`);
  if (typeof report?.summary !== 'string') problems.push('summary 不是字符串');
  if (typeof report?.stats !== 'object' || report.stats === null) problems.push('stats 不是对象');
  for (const key of ['blocks', 'todos', 'days', 'followups']) {
    if (!Array.isArray(report?.[key])) problems.push(`${key} 不是数组`);
  }
  if (typeof report?.stats?.followups !== 'number') problems.push('stats.followups 不是数字');
  else if (report.stats.followups !== (Array.isArray(report.followups) ? report.followups.length : -1)) {
    problems.push('stats.followups 与 followups 数组长度不一致');
  }
  for (const [index, followup] of (Array.isArray(report?.followups) ? report.followups : []).entries()) {
    if (followup?.kind !== 'followup') problems.push(`followups[${index}].kind 非法`);
    if (typeof followup?.text !== 'string' || followup.text === '') problems.push(`followups[${index}].text 为空`);
    if (typeof followup?.sessionId !== 'string' || followup.sessionId === '') problems.push(`followups[${index}].sessionId 为空`);
    if (typeof followup?.suggestedPrompt !== 'string' || followup.suggestedPrompt === '') {
      problems.push(`followups[${index}].suggestedPrompt 缺失`);
    }
    if (typeof followup?.cwd !== 'string') problems.push(`followups[${index}].cwd 不是字符串`);
  }
  for (const [index, block] of (Array.isArray(report?.blocks) ? report.blocks : []).entries()) {
    for (const key of ['actions', 'results', 'todos']) {
      if (!Array.isArray(block?.[key])) problems.push(`blocks[${index}].${key} 不是数组`);
    }
    if (typeof block?.title !== 'string' || block.title === '') problems.push(`blocks[${index}].title 为空`);
    if (block?.label !== '目标' && block?.label !== '项目') problems.push(`blocks[${index}].label 非法`);
  }
  if (typeof report?.stats?.deliverables !== 'number') problems.push('stats.deliverables 不是数字');
  for (const [blockIndex, block] of (Array.isArray(report?.blocks) ? report.blocks : []).entries()) {
    for (const [resultIndex, result] of (Array.isArray(block?.results) ? block.results : []).entries()) {
      if (result?.kind !== 'deliverable') continue;
      if (typeof result.path !== 'string' || result.path === '') problems.push(`blocks[${blockIndex}].results[${resultIndex}].path 为空`);
      if (typeof result.openUrl !== 'string' || !result.openUrl.startsWith('/api/present.open?')) {
        problems.push(`blocks[${blockIndex}].results[${resultIndex}].openUrl 形状非法`);
      }
    }
  }
  for (const [index, todo] of (Array.isArray(report?.todos) ? report.todos : []).entries()) {
    if (typeof todo?.suggestedPrompt !== 'string' || todo.suggestedPrompt === '') {
      problems.push(`todos[${index}].suggestedPrompt 缺失`);
    }
    if (todo?.kind !== 'todo' && todo?.kind !== 'goal') problems.push(`todos[${index}].kind 非法`);
  }
  if (typeof report?.range?.startMs !== 'number' || typeof report?.range?.endMs !== 'number') {
    problems.push('range.startMs/endMs 不是数字');
  } else if (!(report.range.startMs < report.range.endMs)) {
    problems.push('range 起点不早于终点');
  }
  return problems;
}

/** 当前时区的 YYYY-MM-DD（插件按请求时区切窗口，这里用同一时区避免边界歧义）。 */
function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function checkMeta() {
  const { status, body } = await getJson('/ai-journal/api?kind=meta');
  const ok = status === 200
    && body.ok === true
    && body.services?.sessionController === true
    && body.services?.sessionQuery === true;
  record('Host 路由已挂载（meta）', ok ? 'PASS' : 'FAIL',
    `HTTP ${status} · plugin=${body.plugin ?? '-'} · services=${JSON.stringify(body.services ?? {})} · today=${body.today ?? '-'}`);
}

async function checkDaily() {
  const date = todayIn('Asia/Singapore');
  const { status, body } = await getJson(`/ai-journal/api?kind=daily&date=${date}&tz=Asia%2FSingapore`);
  const problems = status === 200 ? hasShape(body, 'daily') : [`HTTP ${status}`];
  record('日报接口形状', problems.length === 0 ? 'PASS' : 'FAIL',
    `HTTP ${status} · date=${date} · empty=${body.empty} · sessions=${body.stats?.sessions} · blocks=${body.blocks?.length} · todos=${body.todos?.length} · followups=${body.stats?.followups} · deliverables=${body.stats?.deliverables}`
    + (problems.length ? `\n问题：${problems.join('；')}` : ''));
}

async function checkWeekly() {
  const date = todayIn('Asia/Singapore');
  const { status, body } = await getJson(`/ai-journal/api?kind=weekly&date=${date}&tz=Asia%2FSingapore`);
  const problems = status === 200 ? hasShape(body, 'weekly') : [`HTTP ${status}`];
  if (status === 200 && body.days?.length !== 7) problems.push(`days 长度 ${body.days?.length} ≠ 7`);
  record('周报接口形状', problems.length === 0 ? 'PASS' : 'FAIL',
    `HTTP ${status} · range=${body.range?.label ?? '-'} · sessions=${body.stats?.sessions} · blocks=${body.blocks?.length} · days=${body.days?.length} · followups=${body.stats?.followups} · deliverables=${body.stats?.deliverables}`
    + (problems.length ? `\n问题：${problems.join('；')}` : ''));
}

async function checkFence() {
  const response = await fetch(new URL('/ai-journal/api?kind=meta', BASE), {
    headers: { origin: 'http://evil.example.com' },
  });
  const ok = response.status === 403;
  record('跨站 Origin 被拒绝', ok ? 'PASS' : 'FAIL', `HTTP ${response.status}（期望 403）`);
}

async function checkReadOnly() {
  const response = await fetch(new URL('/ai-journal/api?kind=meta', BASE), { method: 'POST' });
  const ok = response.status === 405;
  record('非 GET 请求被拒绝', ok ? 'PASS' : 'FAIL', `HTTP ${response.status}（期望 405）`);
}

/** 忽略接口：dismiss → restore 往返（用不会出现在报告里的合成 key，避免脏数据）。 */
async function checkFollowupDismiss() {
  const key = 'f'.repeat(40);
  const post = (body) => fetch(new URL(`/ai-journal/api/followups`, BASE), {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    const dismissed = await post({ action: 'dismiss', key, sessionId: 'synthetic', text: 'verify' });
    const dismissBody = await dismissed.json().catch(() => ({}));
    if (dismissed.status !== 200 || dismissBody.ok !== true) {
      record('待跟进忽略接口', 'FAIL', `dismiss HTTP ${dismissed.status}`);
      return;
    }
    const restored = await post({ action: 'restore', key });
    const restoreBody = await restored.json().catch(() => ({}));
    const bad = await post({ action: 'nope', key });
    const plain = await fetch(new URL('/ai-journal/api/followups', BASE), {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'text/plain' },
      body: 'x',
    });
    const ok = restored.status === 200 && restoreBody.removed === true && bad.status === 400 && plain.status === 415;
    record('待跟进忽略接口', ok ? 'PASS' : 'FAIL',
      `dismiss=${dismissed.status} restore=${restored.status} bad-action=${bad.status} non-json=${plain.status}`);
  } catch (error) {
    record('待跟进忽略接口', 'FAIL', error instanceof Error ? error.message : String(error));
  }
}

/** 返回启动图 HTML；未登录时返回 undefined 并记 SKIP。 */
async function checkBootGraph() {
  const response = await fetch(new URL('/', BASE));
  if (response.status === 401) {
    record('浏览器启动图包含插件', 'SKIP',
      'HTTP 401：DSH 首页需要浏览器登录 cookie，CLI 无法读取启动图。\n请在浏览器刷新 GUI 后人工确认左侧栏「AI 日报」入口。');
    return undefined;
  }
  const html = await response.text();
  const index = html.indexOf('dsh-ai-journal');
  const ok = response.ok && index >= 0;
  const snippet = index >= 0 ? html.slice(Math.max(0, index - 120), index + 160) : '未在 HTML 中找到 dsh-ai-journal';
  record('浏览器启动图包含插件', ok ? 'PASS' : 'FAIL', `HTTP ${response.status} · ${snippet.replace(/\s+/g, ' ')}`);
  return html;
}

async function checkBundle(html) {
  if (typeof html !== 'string') {
    record('客户端 bundle 可下载', 'SKIP', '依赖上一步的启动图；未登录时无法检查。');
    return;
  }
  const match = html.match(/["']([^"']*\/plugins[^"']*dsh-ai-journal[^"']*)["']/);
  if (match === null) {
    record('客户端 bundle 可下载', 'FAIL', '启动图里没有找到含 dsh-ai-journal 的 /plugins 地址');
    return;
  }
  const path = match[1].replaceAll('\\u0026', '&').replaceAll('&amp;', '&');
  const response = await fetch(new URL(path, BASE));
  const text = await response.text();
  const ok = response.ok && text.includes('dsh-ai-journal');
  record('客户端 bundle 可下载', ok ? 'PASS' : 'FAIL',
    `HTTP ${response.status} · ${path.slice(0, 120)} · bytes=${text.length} · 含模块 id=${text.includes('dsh-ai-journal')}`);
}

const checks = [
  ['meta', checkMeta],
  ['daily', checkDaily],
  ['weekly', checkWeekly],
  ['fence', checkFence],
  ['readonly', checkReadOnly],
  ['followup-dismiss', checkFollowupDismiss],
];

for (const [name, run] of checks) {
  try {
    await run();
  } catch (error) {
    record(name, 'FAIL', error instanceof Error ? error.message : String(error));
  }
}

let html;
try {
  html = await checkBootGraph();
} catch (error) {
  record('浏览器启动图包含插件', 'FAIL', error instanceof Error ? error.message : String(error));
}
try {
  await checkBundle(html);
} catch (error) {
  record('客户端 bundle 可下载', 'FAIL', error instanceof Error ? error.message : String(error));
}

const failed = results.filter((item) => item.status === 'FAIL').length;
const skipped = results.filter((item) => item.status === 'SKIP').length;
const passed = results.length - failed - skipped;
console.log(`\n${passed}/${results.length} 项通过${failed > 0 ? `，${failed} 项失败` : ''}${skipped > 0 ? `，${skipped} 项跳过` : ''}。`);
if (failed > 0) process.exitCode = 1;
