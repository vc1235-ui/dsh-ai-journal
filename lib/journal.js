import { createHash } from 'node:crypto';

/**
 * AI 日报的纯聚合层：把「会话日志快照」折叠成日报/周报 JSON。
 *
 * 这一层不碰任何 Host 服务、不读文件、不访问网络，只接收已经取好的
 * `facts`（由 index.js 从 sessionQuery 得到的会话头部 + 事件数组提取），
 * 因此可以用合成数据完整离线测试。
 *
 * 口径见同目录上一级的 API-CONTRACT.md：
 * - 做了哪些事 = 窗口内有活动的会话，以及窗口内的人类输入摘要；
 * - 归属目标 = 会话最新 goal/change 的 objective，没有目标时按项目（cwd）归组；
 * - 未完成 = 最新待办清单里的 pending / in_progress 项，以及进行中/受阻的目标。
 *
 * @module dsh-ai-journal/journal
 */

/** 默认时区：无法从请求取得时使用。 */
export const DEFAULT_TZ = 'Asia/Singapore';

/** 会话标题缺失时的兜底标题。 */
const UNTITLED = '未命名会话';

/** 每日人类输入摘录的最大长度（Unicode 字符）。 */
const EXCERPT_MAX = 80;

/** 单个会话最多保留的输入摘录条数。 */
const PROMPT_KEEP = 3;

/** 目标阶段的中文文案。 */
const GOAL_PHASE_LABEL = {
  active: '进行中',
  completed: '已完成',
  blocked: '受阻',
  paused: '已暂停',
};

/* ------------------------------------------------------------------ */
/* 时区与日期工具                                                       */
/* ------------------------------------------------------------------ */

/**
 * 校验并归一化 IANA 时区名。
 * @param {unknown} tz - 请求携带的时区名。
 * @returns {string} 合法时区名，非法时回落到默认时区。
 */
export function normalizeTimeZone(tz) {
  if (typeof tz !== 'string' || tz.trim() === '') return DEFAULT_TZ;
  try {
    // 构造成功即认为可用；顺带排除 "__proto__" 之类的伪时区。
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** 缓存的格式化器，避免逐事件构造。 */
const dayFormatCache = new Map();

function dayFormatter(tz) {
  let formatter = dayFormatCache.get(tz);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatCache.set(tz, formatter);
  }
  return formatter;
}

/**
 * 时间戳在指定时区下的日期键（YYYY-MM-DD）。
 * @param {number} ms - Unix 毫秒。
 * @param {string} tz - IANA 时区。
 * @returns {string} 日期键。
 */
export function dayKey(ms, tz = DEFAULT_TZ) {
  const parts = dayFormatter(tz).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 时区偏移（毫秒），正数表示当地比 UTC 快。 */
function tzOffsetMs(tz, ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - ms;
}

/**
 * 指定时区里某天 00:00 对应的 Unix 毫秒。
 * @param {string} dateKey - YYYY-MM-DD。
 * @param {string} tz - IANA 时区。
 * @returns {number} 当天起点毫秒；日期非法时返回 NaN。
 */
export function dayStartMs(dateKey, tz = DEFAULT_TZ) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return Number.NaN;
  const naive = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(naive)) return Number.NaN;
  // 用两次迭代解出「当地 00:00」对应的 UTC 时刻（跨 DST 时也能收敛）。
  let guess = naive;
  for (let i = 0; i < 3; i += 1) {
    const next = naive - tzOffsetMs(tz, guess);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** 日期键加减天数。 */
export function addDaysKey(dateKey, days) {
  const base = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(base)) return dateKey;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** 日期键所在周的周一（周一为一周第一天）。 */
export function weekStartKey(dateKey) {
  const base = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(base)) return dateKey;
  const weekday = new Date(base).getUTCDay(); // 0=周日
  const diff = weekday === 0 ? -6 : 1 - weekday;
  return addDaysKey(dateKey, diff);
}

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 中文日期文案：11月5日 周三。 */
export function dayLabelZh(dateKey) {
  const base = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(base)) return dateKey;
  const date = new Date(base);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${WEEKDAY_ZH[date.getUTCDay()]}`;
}

/* ------------------------------------------------------------------ */
/* 文本工具                                                             */
/* ------------------------------------------------------------------ */

function truncate(text, max) {
  const chars = Array.from(String(text ?? '').trim());
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max).join('')}…`;
}

/** 把用户消息的文本块拼成一行。 */
function messageText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/** cwd → 项目标签。 */
export function projectLabel(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return '无工作目录';
  const path = cwd.replace(/\/+$/, '');
  if (path === '' || path === '/') return '根目录';
  if (/^\/(private\/)?tmp(\/|$)/.test(path) || /\/var\/folders\//.test(path)) return '临时目录';
  if (path === homeDirectory()) return '主目录';
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base === '') return '主目录';
  return base;
}

/** 当前进程的 home 目录（用于把 home 识别成「主目录」，不绑定具体用户名）。 */
function homeDirectory() {
  const home = process.env?.HOME;
  return typeof home === 'string' && home !== '' ? home.replace(/\/+$/, '') : '';
}

/** 路径最后一段（用于交付物标题）。 */
function basename(path) {
  const normalized = String(path ?? '').replace(/[\\/]+$/, '');
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/**
 * 交付物的浏览器跳转地址：DSH 的 `present.open` 路由按
 * sessionId + 事件 seq + files 下标定位；GET 返回可打开的应用列表，
 * POST 才会真正在宿主桌面打开文件。
 */
function presentOpenUrl(sessionId, seq, index) {
  const query = new URLSearchParams({ sessionId, seq: String(seq), index: String(index) });
  return `/api/present.open?${query.toString()}`;
}

/** 目标状态 → 中文。 */
function goalPhaseLabel(phase) {
  return GOAL_PHASE_LABEL[phase] ?? (phase || '未知状态');
}

/* ------------------------------------------------------------------ */
/* 会话事实提取                                                         */
/* ------------------------------------------------------------------ */

/**
 * 从一个会话的完整事件数组提取聚合所需事实。
 *
 * @param {object} input - 会话输入。
 * @param {string} input.sessionId - 会话 id。
 * @param {string} [input.cwd] - 会话工作目录。
 * @param {Array<object>} input.events - 原始会话事件（seq 升序）。
 * @param {string|null} [input.error] - 读取失败时的错误文案。
 * @returns {object} 会话事实。
 */
export function extractSessionFacts({ sessionId, cwd, events, error = null }) {
  const facts = {
    sessionId,
    cwd: typeof cwd === 'string' && cwd !== '' ? cwd : null,
    project: projectLabel(cwd),
    title: '',
    titleFallback: '',
    prompts: [],
    activityTimes: [],
    turns: [],
    toolCalls: [],
    todos: null,
    todosTime: null,
    deliverables: [],
    goal: null,
    goalTime: null,
    eventCount: 0,
    error,
  };
  const list = Array.isArray(events) ? events : [];
  for (const event of list) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
    facts.eventCount += 1;
    const time = typeof event.time === 'number' ? event.time : null;
    if (time !== null) facts.activityTimes.push(time);
    const data = event.data;
    if (event.type === 'session/title') {
      const title = typeof data?.title === 'string' ? data.title.trim() : '';
      if (title !== '') facts.title = title;
      continue;
    }
    if (event.type === 'user/message') {
      // 只有 source.kind === 'user' 是人类输入；runtime-context / goal / cron 是注入内容。
      if (data?.source?.kind !== 'user') continue;
      const text = messageText(data);
      if (text === '') continue;
      facts.prompts.push({ time: time ?? 0, text });
      if (facts.titleFallback === '') facts.titleFallback = truncate(text, 40);
      continue;
    }
    if (event.type === 'turn/start') {
      if (time !== null) facts.turns.push(time);
      continue;
    }
    if (event.type === 'tool/call') {
      if (time !== null) facts.toolCalls.push(time);
      continue;
    }
    if (event.type === 'todo/write') {
      const items = Array.isArray(data?.todos) ? data.todos : null;
      if (items === null) continue;
      facts.todos = items
        .filter((item) => item && typeof item.content === 'string' && item.content.trim() !== '')
        .map((item) => ({
          content: item.content.trim(),
          status: item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending',
        }));
      facts.todosTime = time;
      continue;
    }
    if (event.type === 'deliverables/presented') {
      // 模型用 present 工具交付的文件；seq/index 是宿主「打开交付物」路由的坐标。
      const files = Array.isArray(data?.files) ? data.files : [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (!file || typeof file.path !== 'string' || file.path.trim() === '') continue;
        facts.deliverables.push({
          path: file.path.trim(),
          description: typeof file.description === 'string' ? file.description.trim() : '',
          seq: event.seq,
          index,
          time: time ?? 0,
        });
      }
      continue;
    }
    if (event.type === 'goal/change') {
      if (!data || typeof data !== 'object') continue;
      if (data.operation === 'clear') {
        facts.goal = null;
        facts.goalTime = time;
        continue;
      }
      const goal = data.goal;
      if (!goal || typeof goal !== 'object') continue;
      const objective = typeof goal.objective === 'string' ? goal.objective.trim() : '';
      if (objective === '') continue;
      facts.goal = {
        id: typeof goal.id === 'string' ? goal.id : null,
        objective,
        phase: typeof goal.phase === 'string' ? goal.phase : 'active',
      };
      facts.goalTime = time;
    }
  }
  if (facts.title === '') facts.title = facts.titleFallback || UNTITLED;
  return facts;
}

/* ------------------------------------------------------------------ */
/* 日报 / 周报                                                          */
/* ------------------------------------------------------------------ */

/** 单块最多展示的行动条目。 */
const ACTIONS_MAX = 6;
/** 单块最多展示的结果条目。 */
const RESULTS_MAX = 8;
/** 行动文案最大长度。 */
const ACTION_TEXT_MAX = 48;
/** 待办文案最大长度。 */
const TODO_TEXT_MAX = 120;
/** 建议提示词里引用的待办/目标最大长度。 */
const PROMPT_TEXT_MAX = 80;

/** 未完成事项的展示顺序：目标 → 受阻目标 → 进行中 → 待办。 */
const STATUS_ORDER = { active: 0, blocked: 1, in_progress: 2, pending: 3 };

/** 按 key 去重并保持顺序。 */
function uniqueBy(list, keyOf) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * 生成「新开对话」时预填到输入框的建议提示词。
 * 文案保持一段话，不做模型调用。
 */
function suggestedPrompt({ kind, content, goal, project, sessionTitle, phase }) {
  if (kind === 'goal') {
    return `继续推进目标：${truncate(goal ?? content, PROMPT_TEXT_MAX)}。`
      + `先回顾最近进展和卡点（当前${goalPhaseLabel(phase)}），再给出下一步计划并开始执行；完成后更新目标状态。`;
  }
  const parts = [`继续完成待办：${truncate(content, PROMPT_TEXT_MAX)}。`];
  if (goal) parts.push(`所属目标：${truncate(goal, PROMPT_TEXT_MAX)}。`);
  else if (project) parts.push(`所属项目：${project}。`);
  if (sessionTitle) parts.push(`来自会话「${truncate(sessionTitle, 40)}」。`);
  parts.push('先确认当前进展和相关文件，再给出简短计划并开始执行；完成后更新待办。');
  return parts.join('');
}

/** 块内一句话总结：目标/项目 + 会话轮次 + 主要行动 + 收尾情况。 */
function blockSummary({ kind, title, phase, sessions, turns, actions, completed, open }) {
  const head = kind === 'goal'
    ? `目标「${truncate(title, 40)}」${phase ? `（${goalPhaseLabel(phase)}）` : ''}`
    : `项目 ${truncate(title, 40)}`;
  const actionText = actions.length === 0
    ? ''
    : `：${actions.slice(0, 2).map((action) => action.text).join('、')}${actions.length > 2 ? ` 等 ${actions.length} 项` : ''}`;
  const tail = open > 0 ? `还有 ${open} 项待办` : '没有遗留待办';
  return `${head}，${sessions} 个会话 ${turns} 轮${actionText}；完成 ${completed} 项，${tail}。`;
}

/** 每个会话最多提取的「待跟进」条数。 */
const FOLLOWUPS_PER_SESSION = 4;
/** 整份报告最多返回的「待跟进」条数。 */
const FOLLOWUPS_TOTAL_MAX = 12;
/** 单条「待跟进」文案的最大长度（Unicode 字符）。 */
const FOLLOWUP_TEXT_MAX = 110;

/** 明确的「以后再说/还没处理」措辞。 */
const FOLLOWUP_STRONG = /(待回复|待确认|待跟进|待处理|待定|未回复|没回复|别忘了|提醒我|再聊|回头再|下次再|之后再|后续再|改天再|晚点再|稍后再)/;
/** 「后续 + 动作」的松散措辞，避免只命中「后续」两个字。 */
const FOLLOWUP_WEAK = /后续[^。！？!?；;\n]{0,12}(再|继续|处理|聊|谈|看|确认|补|做|跟进|安排)/;

/**
 * 从一条人类输入里找出带「后续/待跟进」语义的句子。
 * 这是启发式：只认措辞，不做模型判断。
 * @param {string} text - 原始输入文本。
 * @returns {string[]} 截断后的句子列表。
 */
function followupSentences(text) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized === '') return [];
  const out = [];
  for (const raw of normalized.split(/[。！？!?；;\n]/)) {
    const sentence = raw.trim();
    if (sentence === '') continue;
    if (!FOLLOWUP_STRONG.test(sentence) && !FOLLOWUP_WEAK.test(sentence)) continue;
    out.push(truncate(sentence, FOLLOWUP_TEXT_MAX));
  }
  return out;
}

/**
 * 「待跟进」条目的稳定标识：会话 id + 归一化文案的 sha1。
 * 用于「这不是待办」的忽略记录，刷新/换窗口后仍然对应同一条。
 * @param {string} sessionId - 来源会话 id。
 * @param {string} text - 截断后的句子。
 * @returns {string} 16 进制摘要。
 */
export function followupKey(sessionId, text) {
  return createHash('sha1')
    .update(String(sessionId ?? ''))
    .update('\u0000')
    .update(String(text ?? '').replace(/\s+/g, ' ').trim())
    .digest('hex');
}

/** 「待跟进」条目的建议提示词：新开对话时预填。 */
function followupPrompt(text, project, sessionTitle) {
  const parts = [`继续跟进之前提到的事项：${truncate(text, PROMPT_TEXT_MAX)}。`];
  if (project) parts.push(`所属项目：${project}。`);
  if (sessionTitle) parts.push(`来自会话「${truncate(sessionTitle, 40)}」。`);
  parts.push('先确认当前状态和相关文件，再给出简短计划并开始执行；如果这件事已经不需要处理，请明确说明原因。');
  return parts.join('');
}

/**
 * 生成日报或周报。
 *
 * 输出结构以「目标/项目 → 行动 → 结果 → 待办」为主：
 * - blocks[]：一个目标（没有目标时按项目）一个大块，内含 actions / results / todos；
 * - todos[]：跨块汇总的全部未完成待办（含目标），每条带 suggestedPrompt 供「新开对话」预填。
 *
 * @param {object} input - 聚合输入。
 * @param {'daily'|'weekly'} [input.kind] - 报告类型。
 * @param {string} input.dateKey - 日报日期或周报所在周的任意一天。
 * @param {string} [input.tz] - IANA 时区。
 * @param {Array<object>} [input.facts] - extractSessionFacts 的结果数组。
 * @param {number} [input.now] - 生成时刻。
 * @returns {object} 符合 API-CONTRACT.md 的响应对象。
 */
export function buildReport({ kind = 'daily', dateKey, tz = DEFAULT_TZ, facts = [], now = Date.now() }) {
  const reportKind = kind === 'weekly' ? 'weekly' : 'daily';
  const zone = normalizeTimeZone(tz);
  const startKey = reportKind === 'weekly' ? weekStartKey(dateKey) : dateKey;
  const dayKeys = reportKind === 'weekly'
    ? Array.from({ length: 7 }, (_, index) => addDaysKey(startKey, index))
    : [startKey];
  const startMs = dayStartMs(dayKeys[0], zone);
  const endMs = dayStartMs(addDaysKey(dayKeys[dayKeys.length - 1], 1), zone);
  const safeFacts = Array.isArray(facts) ? facts.filter((item) => item && typeof item.sessionId === 'string') : [];
  const failures = safeFacts
    .filter((item) => item.error)
    .map((item) => ({ sessionId: item.sessionId, message: item.error }));

  /* 1. 窗口内有活动的会话 */
  const sessions = [];
  for (const item of safeFacts) {
    if (item.error) continue;
    const times = (item.activityTimes ?? []).filter((time) => time >= startMs && time < endMs);
    if (times.length === 0) continue;
    const prompts = (item.prompts ?? []).filter((prompt) => prompt.time >= startMs && prompt.time < endMs);
    // 窗口内没有人类输入时，用窗口前最后一条输入作为「这件事是什么」的上下文。
    const lastBefore = prompts.length === 0
      ? [...(item.prompts ?? [])].filter((prompt) => prompt.time < startMs).at(-1)
      : undefined;
    const excerpt = truncate(prompts[0]?.text ?? lastBefore?.text ?? '', EXCERPT_MAX);
    sessions.push({
      sessionId: item.sessionId,
      title: item.title || excerpt || UNTITLED,
      project: item.project || projectLabel(item.cwd),
      cwd: item.cwd ?? null,
      goal: item.goal?.objective ?? null,
      goalPhase: item.goal?.phase ?? null,
      turns: (item.turns ?? []).filter((time) => time >= startMs && time < endMs).length,
      humanMessages: prompts.length,
      toolCalls: (item.toolCalls ?? []).filter((time) => time >= startMs && time < endMs).length,
      firstTime: Math.min(...times),
      lastTime: Math.max(...times),
      todos: Array.isArray(item.todos) ? item.todos : [],
      prompts,
      deliverables: (item.deliverables ?? []).filter(
        (deliverable) => deliverable.time >= startMs && deliverable.time < endMs,
      ),
      excerpt,
    });
  }
  sessions.sort((left, right) => right.lastTime - left.lastTime);

  /* 2. 按目标归块；没有目标的会话按项目归块 */
  const blockMap = new Map();
  for (const session of sessions) {
    const key = session.goal !== null
      ? `goal:${session.goal}`
      : session.cwd !== null
        ? `project:${session.cwd}`
        : 'project:none';
    let block = blockMap.get(key);
    if (block === undefined) {
      block = {
        kind: session.goal !== null ? 'goal' : 'project',
        key,
        title: session.goal ?? (session.cwd !== null ? session.project : '未归类'),
        phase: session.goal !== null ? session.goalPhase : null,
        sessions: [],
      };
      blockMap.set(key, block);
    }
    block.sessions.push(session);
    if (session.goalPhase === 'completed') block.phase = 'completed';
  }

  const blocks = [];
  for (const block of blockMap.values()) {
    const label = block.kind === 'goal' ? '目标' : '项目';
    const turns = block.sessions.reduce((sum, session) => sum + session.turns, 0);

    /* 行动：会话标题就是「做了什么」的现成概括，去重后每块最多 6 条 */
    const actions = uniqueBy(
      block.sessions.map((session) => ({
        text: truncate(session.title, ACTION_TEXT_MAX),
        time: session.lastTime,
        sessionId: session.sessionId,
      })),
      (action) => action.text,
    ).slice(0, ACTIONS_MAX);

    /* 结果：交付物（可用链接打开）+ 已完成待办 + 目标完成；没有可核实结果时为空 */
    const deliverableResults = [];
    for (const session of block.sessions) {
      for (const deliverable of session.deliverables) {
        deliverableResults.push({
          kind: 'deliverable',
          text: deliverable.description || basename(deliverable.path),
          path: deliverable.path,
          openUrl: presentOpenUrl(session.sessionId, deliverable.seq, deliverable.index),
          time: deliverable.time,
          sessionId: session.sessionId,
        });
      }
    }
    const doneTodos = [];
    for (const session of block.sessions) {
      for (const todo of session.todos) {
        if (todo.status !== 'completed') continue;
        doneTodos.push({
          kind: 'todo',
          text: truncate(todo.content, TODO_TEXT_MAX),
          time: session.lastTime,
          sessionId: session.sessionId,
        });
      }
    }
    // 交付物按路径去重；完成项按文案去重。
    const results = uniqueBy(deliverableResults, (result) => result.path)
      .concat(uniqueBy(doneTodos, (result) => result.text))
      .slice(0, RESULTS_MAX);
    if (block.kind === 'goal' && block.phase === 'completed') {
      results.unshift({
        kind: 'goal',
        text: `目标已完成：${truncate(block.title, TODO_TEXT_MAX)}`,
        time: block.sessions[0].lastTime,
        sessionId: null,
      });
    }

    /* 待办：块内所有 pending / in_progress 条目，条目全量返回 */
    const todos = [];
    for (const session of block.sessions) {
      for (const todo of session.todos) {
        if (todo.status === 'completed') continue;
        todos.push({
          kind: 'todo',
          content: truncate(todo.content, TODO_TEXT_MAX),
          status: todo.status,
          project: session.project,
          cwd: session.cwd,
          sessionId: session.sessionId,
          sessionTitle: session.title,
          goal: session.goal,
          suggestedPrompt: suggestedPrompt({
            kind: 'todo',
            content: todo.content,
            goal: session.goal,
            project: session.project,
            sessionTitle: session.title,
          }),
        });
      }
    }
    const openTodos = uniqueBy(todos, (todo) => `${todo.sessionId}\u0000${todo.content}`);
    // 进行中/受阻的目标本身也算未完成事项，排在待办前面。
    if (block.kind === 'goal' && (block.phase === 'active' || block.phase === 'blocked')) {
      const latest = block.sessions[0];
      openTodos.unshift({
        kind: 'goal',
        content: truncate(block.title, TODO_TEXT_MAX),
        status: block.phase,
        project: latest.project,
        cwd: latest.cwd,
        sessionId: latest.sessionId,
        sessionTitle: latest.title,
        goal: block.title,
        suggestedPrompt: suggestedPrompt({
          kind: 'goal',
          goal: block.title,
          phase: block.phase,
          project: latest.project,
          sessionTitle: latest.title,
        }),
      });
    }
    const completedCount = results.filter((result) => result.kind === 'todo').length;
    // 目标条目固定排最前，其余按「进行中 → 待办」排序。
    const goalEntry = openTodos[0]?.kind === 'goal' ? openTodos[0] : undefined;
    const orderedTodos = (goalEntry === undefined ? openTodos : openTodos.slice(1))
      .slice()
      .sort((left, right) => (STATUS_ORDER[left.status] ?? 9) - (STATUS_ORDER[right.status] ?? 9));

    blocks.push({
      kind: block.kind,
      key: block.key,
      label,
      title: block.title,
      phase: block.phase,
      summary: blockSummary({
        kind: block.kind,
        title: block.title,
        phase: block.phase,
        sessions: block.sessions.length,
        turns,
        actions,
        completed: completedCount,
        open: openTodos.length,
      }),
      actions,
      results,
      todos: goalEntry === undefined ? orderedTodos : [goalEntry, ...orderedTodos],
      sessionIds: block.sessions.map((session) => session.sessionId),
      projects: uniqueBy(block.sessions.map((session) => session.project), (project) => project),
      firstTime: Math.min(...block.sessions.map((session) => session.firstTime)),
      lastTime: Math.max(...block.sessions.map((session) => session.lastTime)),
      stats: {
        sessions: block.sessions.length,
        turns,
        humanMessages: block.sessions.reduce((sum, session) => sum + session.humanMessages, 0),
        toolCalls: block.sessions.reduce((sum, session) => sum + session.toolCalls, 0),
        todosCompleted: completedCount,
        todosOpen: goalEntry === undefined ? orderedTodos.length : orderedTodos.length + 1,
        deliverables: results.filter((result) => result.kind === 'deliverable').length,
      },
    });
  }
  // 目标块在前；同类块按最近活动时间排序。
  blocks.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'goal' ? -1 : 1;
    return right.lastTime - left.lastTime;
  });

  /* 2.5 会话中提到的「后续/待跟进」（启发式，只看人类输入，不猜 AI 回复） */
  const followups = [];
  const seenFollowup = new Set();
  for (const session of sessions) {
    let taken = 0;
    for (const prompt of session.prompts) {
      if (taken >= FOLLOWUPS_PER_SESSION) break;
      for (const sentence of followupSentences(prompt.text)) {
        const key = sentence.replace(/\s+/g, '');
        if (seenFollowup.has(key)) continue;
        seenFollowup.add(key);
        followups.push({
          kind: 'followup',
          key: followupKey(session.sessionId, sentence),
          text: sentence,
          time: prompt.time,
          sessionId: session.sessionId,
          sessionTitle: session.title,
          project: session.project,
          cwd: session.cwd,
          suggestedPrompt: followupPrompt(sentence, session.project, session.title),
        });
        taken += 1;
        if (taken >= FOLLOWUPS_PER_SESSION) break;
      }
    }
  }
  followups.sort((left, right) => right.time - left.time);
  const cappedFollowups = followups.slice(0, FOLLOWUPS_TOTAL_MAX);

  /* 3. 指标 */
  const stats = {
    sessions: sessions.length,
    turns: sessions.reduce((sum, session) => sum + session.turns, 0),
    humanMessages: sessions.reduce((sum, session) => sum + session.humanMessages, 0),
    toolCalls: sessions.reduce((sum, session) => sum + session.toolCalls, 0),
    projects: new Set(sessions.map((session) => session.project)).size,
    blocks: blocks.length,
    todosCompleted: blocks.reduce((sum, block) => sum + block.stats.todosCompleted, 0),
    deliverables: blocks.reduce((sum, block) => sum + block.stats.deliverables, 0),
    todosInProgress: blocks.reduce(
      (sum, block) => sum + block.todos.filter((todo) => todo.kind === 'todo' && todo.status === 'in_progress').length,
      0,
    ),
    todosPending: blocks.reduce(
      (sum, block) => sum + block.todos.filter((todo) => todo.kind === 'todo' && todo.status === 'pending').length,
      0,
    ),
    followups: cappedFollowups.length,
    goalsActive: blocks.filter((block) => block.kind === 'goal' && block.phase === 'active').length,
    goalsCompleted: blocks.filter((block) => block.kind === 'goal' && block.phase === 'completed').length,
  };

  /* 4. 跨块汇总的未完成待办：目标 → 进行中 → 待办 */
  const todos = blocks
    .flatMap((block) => block.todos)
    .sort((left, right) => (STATUS_ORDER[left.status] ?? 9) - (STATUS_ORDER[right.status] ?? 9));

  /* 5. 每天分布（周报必填；日报返回单元素） */
  const days = dayKeys.map((key) => {
    const dayStart = dayStartMs(key, zone);
    const dayEnd = dayStartMs(addDaysKey(key, 1), zone);
    let daySessions = 0;
    let dayTurns = 0;
    let dayOpenTodos = 0;
    for (const session of sessions) {
      if (session.lastTime < dayStart || session.lastTime >= dayEnd) continue;
      daySessions += 1;
      dayTurns += session.turns;
      dayOpenTodos += session.todos.filter((todo) => todo.status !== 'completed').length;
    }
    return {
      date: key,
      label: dayLabelZh(key),
      sessions: daySessions,
      turns: dayTurns,
      activityCount: daySessions,
      unfinishedCount: dayOpenTodos,
    };
  });

  /* 6. 摘要 */
  const activeDays = days.filter((day) => day.activityCount > 0).length;
  const empty = sessions.length === 0;
  let summary;
  if (empty) {
    summary = reportKind === 'daily'
      ? '这一天没有记录到 AI 会话活动。'
      : '这一周没有记录到 AI 会话活动。';
  } else if (reportKind === 'daily') {
    summary = `今天 ${stats.sessions} 个会话、${stats.turns} 轮，围绕 ${blocks.length} 个${stats.goalsActive + stats.goalsCompleted > 0 ? '目标/项目' : '项目'}展开；`
      + `完成 ${stats.todosCompleted} 项待办，还有 ${todos.length} 项未完成。`;
  } else {
    summary = `本周 ${activeDays} 天有记录，共 ${stats.sessions} 个会话、${stats.turns} 轮，围绕 ${blocks.length} 个${stats.goalsActive + stats.goalsCompleted > 0 ? '目标/项目' : '项目'}展开；`
      + `完成 ${stats.todosCompleted} 项待办，还有 ${todos.length} 项未完成。`;
  }

  const rangeLabel = reportKind === 'weekly' ? `${dayKeys[0]} ~ ${dayKeys[dayKeys.length - 1]}` : dayKeys[0];

  return {
    ok: true,
    kind: reportKind,
    tz: zone,
    range: { startMs, endMs, label: rangeLabel, days: dayKeys },
    generatedAt: now,
    empty,
    summary,
    stats,
    blocks,
    todos,
    followups: cappedFollowups,
    days,
    failures,
  };
}
