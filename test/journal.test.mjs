/**
 * lib/journal.js 的离线测试：全部使用合成会话事件，不读取真实会话数据。
 *
 * 运行：node --test plugins/dsh-ai-journal/test/journal.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDaysKey,
  buildReport,
  dayKey,
  dayLabelZh,
  dayStartMs,
  extractSessionFacts,
  normalizeTimeZone,
  projectLabel,
  weekStartKey,
} from '../lib/journal.js';

const TZ = 'Asia/Singapore';

/** 某天某时（当地时区）的 Unix 毫秒。 */
function at(dateKey, hour, minute = 0) {
  return dayStartMs(dateKey, TZ) + hour * 3_600_000 + minute * 60_000;
}

let seq = 0;
function event(type, time, data) {
  seq += 1;
  return { type, seq, time, data };
}

function userMessage(time, text) {
  return event('user/message', time, {
    id: `m-${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
}

function injectedMessage(time, text, kind = 'runtime-context') {
  return event('user/message', time, {
    id: `m-${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  });
}

function turnStart(time) {
  return event('turn/start', time, { turn: 1 });
}

function toolCall(time) {
  return event('tool/call', time, { turn: 1, step: 1, callId: `c-${seq}`, name: 'bash', arguments: '{}' });
}

function todosWrite(time, todos) {
  return event('todo/write', time, { todos });
}

function goalCreate(time, { id = 'goal-1', objective, phase = 'active' }) {
  return event('goal/change', time, {
    kind: 'goal/change',
    version: 1,
    operation: 'create',
    goal: { id, objective, phase, maxGoalRounds: 10, revision: 1 },
    roundsStarted: 0,
    createdAt: time,
    updatedAt: time,
  });
}

function goalClear(time, id = 'goal-1') {
  return event('goal/change', time, {
    kind: 'goal/change',
    version: 1,
    operation: 'clear',
    cleared: { id, revision: 2 },
    clearedAt: time,
  });
}

function title(time, text) {
  return event('session/title', time, { title: text, messageSeqs: [], source: 'llm' });
}

function presented(time, files) {
  return event('deliverables/presented', time, { turn: 1, callId: `call-${seq}`, files });
}

/** 造一个会话事实。 */
function sessionFacts({ sessionId = 's1', cwd = '/Users/sunxx/Documents/个人AI', events }) {
  return extractSessionFacts({ sessionId, cwd, events });
}

/* ------------------------------------------------------------------ */
/* 时区与日期                                                          */
/* ------------------------------------------------------------------ */

test('时区：新加坡当地 00:00 等于 UTC 前一天 16:00', () => {
  assert.equal(dayStartMs('2026-11-05', TZ), Date.parse('2026-11-04T16:00:00Z'));
  assert.equal(dayStartMs('2026-11-05', TZ), 1_793_808_000_000);
});

test('时区：dayKey 按当地日期归类，边界两侧不同天', () => {
  const start = dayStartMs('2026-11-05', TZ);
  assert.equal(dayKey(start, TZ), '2026-11-05');
  assert.equal(dayKey(start - 1, TZ), '2026-11-04');
  assert.equal(dayKey(start, 'UTC'), '2026-11-04');
});

test('时区：周报按周一起算，跨周边界正确', () => {
  assert.equal(weekStartKey('2026-11-05'), '2026-11-02');
  assert.equal(weekStartKey('2026-11-02'), '2026-11-02');
  assert.equal(weekStartKey('2026-11-08'), '2026-11-02');
  assert.equal(addDaysKey('2026-11-02', 6), '2026-11-08');
  assert.equal(dayLabelZh('2026-11-05'), '11月5日 周四');
});

test('时区：非法时区回落到 Asia/Singapore', () => {
  assert.equal(normalizeTimeZone('Not/AZone'), TZ);
  assert.equal(normalizeTimeZone(''), TZ);
  assert.equal(normalizeTimeZone(undefined), TZ);
  assert.equal(normalizeTimeZone('UTC'), 'UTC');
});

test('项目标签：临时目录、主目录、普通目录', () => {
  assert.equal(projectLabel('/tmp/abc'), '临时目录');
  assert.equal(projectLabel('/private/tmp/x'), '临时目录');
  assert.equal(projectLabel('/Users/sunxx'), '主目录');
  assert.equal(projectLabel('/Users/sunxx/Documents/个人AI'), '个人AI');
  assert.equal(projectLabel(undefined), '无工作目录');
});

/* ------------------------------------------------------------------ */
/* 事实提取                                                             */
/* ------------------------------------------------------------------ */

test('事实提取：只把人类输入当输入，取最新标题/待办/目标', () => {
  const day = '2026-11-05';
  const facts = sessionFacts({
    events: [
      userMessage(at(day, 9), '帮我做一个 AI 日报插件'),
      injectedMessage(at(day, 9, 1), 'AGENTS.md 内容', 'runtime-context'),
      injectedMessage(at(day, 9, 2), '目标续跑轮次', 'goal'),
      turnStart(at(day, 9, 3)),
      turnStart(at(day, 10)),
      toolCall(at(day, 10, 1)),
      title(at(day, 10, 2), 'AI 日报插件'),
      todosWrite(at(day, 10, 3), [
        { content: '实现 Host 半区', status: 'completed' },
        { content: '实现 Client 半区', status: 'in_progress' },
      ]),
      goalCreate(at(day, 10, 4), { objective: '做一个带左侧栏入口的 DSH 插件' }),
    ],
  });

  assert.equal(facts.title, 'AI 日报插件');
  assert.equal(facts.project, '个人AI');
  assert.deepEqual(facts.prompts.map((prompt) => prompt.text), ['帮我做一个 AI 日报插件']);
  assert.equal(facts.turns.length, 2);
  assert.equal(facts.toolCalls.length, 1);
  assert.deepEqual(facts.todos, [
    { content: '实现 Host 半区', status: 'completed' },
    { content: '实现 Client 半区', status: 'in_progress' },
  ]);
  assert.equal(facts.goal?.objective, '做一个带左侧栏入口的 DSH 插件');
  assert.equal(facts.goal?.phase, 'active');
});

test('事实提取：记录 present 工具交付的文件及定位坐标', () => {
  const day = '2026-11-05';
  const facts = sessionFacts({
    events: [
      userMessage(at(day, 9), '把日报导出成文件'),
      title(at(day, 9, 1), '导出日报'),
      presented(at(day, 9, 2), [
        { path: 'docs/日报-2026-11-05.md', description: '11 月 5 日日报' },
        { path: 'docs/周报-2026-W45.md' },
        { path: '' },
      ]),
    ],
  });
  assert.equal(facts.deliverables.length, 2);
  assert.equal(facts.deliverables[0].path, 'docs/日报-2026-11-05.md');
  assert.equal(facts.deliverables[0].description, '11 月 5 日日报');
  assert.equal(facts.deliverables[0].index, 0);
  assert.equal(facts.deliverables[1].description, '');
  assert.equal(facts.deliverables[1].index, 1);
  assert.ok(Number.isInteger(facts.deliverables[0].seq));
});

test('事实提取：清空目标后 goal 为空；无标题时退回首条输入', () => {
  const day = '2026-11-05';
  const longPrompt = '修复检索代理故障，需要检查 httpx 客户端是否把系统代理用到了发往 Ollama 的请求上，并确认 NO_PROXY 已经生效';
  const facts = sessionFacts({
    sessionId: 's2',
    cwd: '/tmp/work',
    events: [
      userMessage(at(day, 8), longPrompt),
      goalCreate(at(day, 8, 1), { objective: '临时目标' }),
      goalClear(at(day, 8, 2)),
    ],
  });
  assert.equal(facts.goal, null);
  assert.equal(Array.from(facts.title).length, 41); // 40 个字符 + 省略号
  assert.equal(facts.title, `${Array.from(longPrompt).slice(0, 40).join('')}…`);
});

/* ------------------------------------------------------------------ */
/* 日报：目标-行动-结果-待办                                             */
/* ------------------------------------------------------------------ */

test('日报：一个目标一个大块，含行动/结果/待办', () => {
  const day = '2026-11-05';
  const facts = [
    sessionFacts({
      sessionId: 's1',
      events: [
        userMessage(at(day, 9), '帮我做一个 AI 日报插件'),
        turnStart(at(day, 9, 1)),
        turnStart(at(day, 10)),
        toolCall(at(day, 10, 1)),
        title(at(day, 10, 2), '实现 Host 半区'),
        todosWrite(at(day, 10, 3), [
          { content: '实现 Host 半区', status: 'completed' },
          { content: '实现 Client 半区', status: 'in_progress' },
        ]),
        goalCreate(at(day, 10, 4), { objective: '做一个带左侧栏入口的 DSH 插件' }),
      ],
    }),
    sessionFacts({
      sessionId: 's2',
      events: [
        userMessage(at(day, 11), '把面板样式改成继承全局字体'),
        turnStart(at(day, 11, 1)),
        title(at(day, 11, 2), '调整面板字体与布局'),
        todosWrite(at(day, 11, 3), [
          { content: '去掉自定义字号', status: 'completed' },
          { content: '补上新开对话链接', status: 'pending' },
          { content: '更新离线测试', status: 'pending' },
        ]),
        goalCreate(at(day, 11, 4), { objective: '做一个带左侧栏入口的 DSH 插件' }),
      ],
    }),
  ];

  const report = buildReport({ kind: 'daily', dateKey: day, tz: TZ, facts, now: at(day, 23) });

  assert.equal(report.empty, false);
  assert.equal(report.blocks.length, 1);
  const block = report.blocks[0];
  assert.equal(block.kind, 'goal');
  assert.equal(block.label, '目标');
  assert.equal(block.title, '做一个带左侧栏入口的 DSH 插件');
  assert.equal(block.phase, 'active');
  assert.deepEqual(block.sessionIds.sort(), ['s1', 's2']);
  assert.equal(block.stats.sessions, 2);
  assert.equal(block.stats.turns, 3);

  // 行动：会话标题去重后作为概括
  assert.deepEqual(block.actions.map((action) => action.text), ['调整面板字体与布局', '实现 Host 半区']);
  // 结果：已完成待办
  assert.deepEqual(block.results.map((result) => result.text), ['去掉自定义字号', '实现 Host 半区']);
  // 待办：块内全量，目标条目排最前
  assert.equal(block.todos[0].kind, 'goal');
  assert.equal(block.todos[0].status, 'active');
  assert.deepEqual(
    block.todos.filter((todo) => todo.kind === 'todo').map((todo) => todo.content),
    ['实现 Client 半区', '补上新开对话链接', '更新离线测试'],
  );
  // 每条待办都有建议提示词，且提示词里带上了待办内容/目标
  for (const todo of block.todos) {
    assert.equal(typeof todo.suggestedPrompt, 'string');
    assert.ok(todo.suggestedPrompt.length > 20);
  }
  const clientTodo = block.todos.find((todo) => todo.content === '实现 Client 半区');
  assert.match(clientTodo.suggestedPrompt, /实现 Client 半区/);
  assert.match(clientTodo.suggestedPrompt, /做一个带左侧栏入口的 DSH 插件/);
  assert.equal(clientTodo.cwd, '/Users/sunxx/Documents/个人AI');

  assert.match(block.summary, /目标「做一个带左侧栏入口的 DSH 插件」（进行中）/);
  assert.match(block.summary, /2 个会话 3 轮/);
  assert.match(report.summary, /^今天 2 个会话、3 轮/);
});

test('日报：结果里的交付物带可打开的链接，并按路径去重', () => {
  const day = '2026-11-05';
  const facts = [
    sessionFacts({
      sessionId: 's9',
      events: [
        userMessage(at(day, 9), '把日报导出成文件'),
        title(at(day, 9, 1), '导出日报'),
        todosWrite(at(day, 9, 2), [{ content: '导出 Markdown', status: 'completed' }]),
        presented(at(day, 9, 3), [
          { path: 'docs/日报-2026-11-05.md', description: '11 月 5 日日报' },
          { path: 'docs/日报-2026-11-05.md' },
        ]),
      ],
    }),
  ];
  const report = buildReport({ kind: 'daily', dateKey: day, tz: TZ, facts, now: at(day, 23) });
  const block = report.blocks[0];
  const deliverables = block.results.filter((result) => result.kind === 'deliverable');
  assert.equal(deliverables.length, 1);
  assert.equal(deliverables[0].text, '11 月 5 日日报');
  assert.equal(deliverables[0].path, 'docs/日报-2026-11-05.md');
  assert.match(deliverables[0].openUrl, /^\/api\/present\.open\?/);
  assert.match(deliverables[0].openUrl, /sessionId=s9/);
  assert.match(deliverables[0].openUrl, /seq=\d+/);
  assert.equal(report.stats.deliverables, 1);
  // 交付物排在已完成待办前面
  assert.equal(block.results[0].kind, 'deliverable');
  assert.equal(block.results[1].kind, 'todo');
});

test('待跟进：人类输入里的「后续再聊」类措辞会被识别，并给出建议提示词', () => {
  const day = '2026-11-05';
  const facts = [
    sessionFacts({
      sessionId: 's11',
      events: [
        userMessage(at(day, 10), '飞书待回复轮询这个后续再聊，先做记忆导入。'),
        title(at(day, 10, 1), 'Hermes 迁移'),
        userMessage(at(day, 11), '今天把面板改完。'),
      ],
    }),
  ];
  const report = buildReport({ kind: 'daily', dateKey: day, tz: TZ, facts, now: at(day, 23) });
  assert.equal(report.followups.length, 1);
  const followup = report.followups[0];
  assert.equal(followup.kind, 'followup');
  assert.match(followup.key, /^[0-9a-f]{40}$/, 'followup must carry a stable sha1 key');
  assert.equal(followup.text, '飞书待回复轮询这个后续再聊，先做记忆导入');
  assert.equal(followup.sessionId, 's11');
  assert.match(followup.suggestedPrompt, /飞书待回复轮询这个后续再聊/);
  assert.match(followup.suggestedPrompt, /Hermes 迁移/);
  assert.equal(report.stats.followups, 1);
  // 启发式条目不计入结构化待办
  assert.equal(report.todos.length, 0);
});

test('待跟进：不按 AI 回复/注入上下文识别，窗口外与重复句会被过滤', () => {
  const day = '2026-11-05';
  const facts = [
    sessionFacts({
      sessionId: 's12',
      events: [
        // 注入上下文/目标续跑不算人类输入
        injectedMessage(at(day, 9), '飞书待回复轮询后续再聊', 'runtime-context'),
        injectedMessage(at(day, 9, 1), '飞书待回复轮询后续再聊', 'goal'),
        // 窗口外
        userMessage(at('2026-11-04', 20), '这个待跟进回头再看'),
        // 同一句重复两次只留一条
        userMessage(at(day, 10), '发布前记得提醒我检查待确认项'),
        userMessage(at(day, 10, 5), '发布前记得提醒我检查待确认项'),
        title(at(day, 10, 6), '发布检查'),
      ],
    }),
  ];
  const report = buildReport({ kind: 'daily', dateKey: day, tz: TZ, facts, now: at(day, 23) });
  assert.equal(report.followups.length, 1);
  assert.equal(report.followups[0].text, '发布前记得提醒我检查待确认项');
});

test('待跟进：每个会话最多 4 条、整份报告最多 12 条', () => {
  const day = '2026-11-05';
  const manyFor = (sessionId, offset) =>
    Array.from({ length: 8 }, (_, index) => ({
      ...userMessage(at(day, 9, index), `${sessionId} 的第 ${index + 1} 件事后续再聊`),
      seq: offset + index * 2,
    }));
  const facts = ['a', 'b', 'c', 'd'].map((sessionId, index) =>
    sessionFacts({
      sessionId,
      events: [
        userMessage(at(day, 9), '开工'),
        title(at(day, 9, 1), `会话 ${sessionId.toUpperCase()}`),
        ...manyFor(sessionId, 100 * (index + 1)),
      ],
    })
  );
  const report = buildReport({ kind: 'daily', dateKey: day, tz: TZ, facts, now: at(day, 23) });
  assert.ok(report.followups.length <= 12, 'total follow-ups must be capped at 12');
  assert.equal(report.followups.length, 12);
});

test('日报：窗口外的交付物不进入结果', () => {
  const facts = [
    sessionFacts({
      sessionId: 's10',
      events: [
        userMessage(at('2026-11-04', 23), '昨天的导出'),
        presented(at('2026-11-04', 23, 10), [{ path: 'docs/old.md' }]),
        userMessage(at('2026-11-05', 9), '今天的活'),
        title(at('2026-11-05', 9, 1), '今天的活'),
      ],
    }),
  ];
  const report = buildReport({ kind: 'daily', dateKey: '2026-11-05', tz: TZ, facts, now: at('2026-11-05', 23) });
  assert.deepEqual(report.blocks[0].results, []);
  assert.equal(report.stats.deliverables, 0);
});

test('日报：待办全量返回，不截断', () => {
  const day = '2026-11-05';
  const many = Array.from({ length: 12 }, (_, index) => ({
    content: `待办事项 ${index + 1}`,
    status: index % 3 === 0 ? 'in_progress' : 'pending',
  }));
  const facts = [
    sessionFacts({
      events: [
        userMessage(at(day, 9), '列一下还有哪些没做'),
        title(at(day, 9, 1), '盘点剩余待办'),
        todosWrite(at(day, 9, 2), many),
      ],
    }),
  ];
  const report = buildReport({ kind: 'daily', dateKey: day, tz: TZ, facts, now: at(day, 23) });
  assert.equal(report.blocks.length, 1);
  assert.equal(report.blocks[0].todos.length, 12);
  assert.equal(report.todos.length, 12);
  assert.equal(report.todos.filter((todo) => todo.status === 'in_progress').length, 4);
});

test('日报：没有目标的会话按项目归块，没有完成项时结果为空', () => {
  const day = '2026-11-05';
  const facts = [
    sessionFacts({
      sessionId: 'p1',
      cwd: '/Users/sunxx/Documents/个人AI',
      events: [userMessage(at(day, 9), '整理文档'), title(at(day, 9, 1), '整理文档')],
    }),
    sessionFacts({
      sessionId: 'p2',
      cwd: '/Users/sunxx/Documents/lute-ios',
      events: [userMessage(at(day, 10), '查一个崩溃'), title(at(day, 10, 1), '查崩溃')],
    }),
  ];
  const report = buildReport({ kind: 'daily', dateKey: day, tz: TZ, facts, now: at(day, 23) });
  assert.equal(report.blocks.length, 2);
  assert.deepEqual(report.blocks.map((block) => block.kind), ['project', 'project']);
  assert.deepEqual(report.blocks.map((block) => block.title).sort(), ['lute-ios', '个人AI'].sort());
  for (const block of report.blocks) {
    assert.equal(block.label, '项目');
    assert.equal(block.phase, null);
    assert.deepEqual(block.results, []);
    assert.deepEqual(block.todos, []);
  }
  assert.equal(report.stats.goalsActive, 0);
});

test('日报：目标已完成时结果里给出完成项', () => {
  const day = '2026-11-05';
  const facts = [
    sessionFacts({
      events: [
        userMessage(at(day, 9), '把插件收尾'),
        title(at(day, 9, 1), '插件收尾'),
        goalCreate(at(day, 9, 2), { objective: '发版 AI 日报', phase: 'completed' }),
      ],
    }),
  ];
  const report = buildReport({ kind: 'daily', dateKey: day, tz: TZ, facts, now: at(day, 23) });
  assert.equal(report.blocks[0].phase, 'completed');
  assert.equal(report.blocks[0].results[0].kind, 'goal');
  assert.match(report.blocks[0].results[0].text, /目标已完成：发版 AI 日报/);
  assert.equal(report.stats.goalsCompleted, 1);
  // 已完成目标不再出现在待办里
  assert.equal(report.todos.filter((todo) => todo.kind === 'goal').length, 0);
});

test('日报：窗口内没有人类输入时，行动标题回退到窗口前的输入', () => {
  const day = '2026-11-05';
  const facts = [
    sessionFacts({
      sessionId: 's3',
      events: [
        userMessage(at('2026-11-04', 22), '帮我跑一遍回归测试'),
        turnStart(at(day, 0, 30)),
        toolCall(at(day, 1)),
      ],
    }),
  ];
  const report = buildReport({ kind: 'daily', dateKey: day, tz: TZ, facts, now: at(day, 12) });
  assert.equal(report.stats.sessions, 1);
  assert.equal(report.stats.humanMessages, 0);
  assert.equal(report.blocks[0].title, '个人AI');
  assert.equal(report.blocks[0].actions[0].text, '帮我跑一遍回归测试');
});

/* ------------------------------------------------------------------ */
/* 周报                                                                 */
/* ------------------------------------------------------------------ */

test('周报：7 天范围、每日分布与多天活动', () => {
  const thursday = '2026-11-05';
  const monday = '2026-11-02';
  const facts = [
    sessionFacts({
      sessionId: 'w1',
      events: [
        userMessage(at(monday, 9), '周一：规划插件'),
        turnStart(at(monday, 9, 1)),
        title(at(monday, 9, 2), '规划插件'),
        goalCreate(at(monday, 9, 3), { objective: 'AI 日报插件' }),
      ],
    }),
    sessionFacts({
      sessionId: 'w2',
      events: [
        userMessage(at(thursday, 14), '周四：实现面板'),
        turnStart(at(thursday, 14, 1)),
        turnStart(at(thursday, 15)),
        toolCall(at(thursday, 15, 1)),
        title(at(thursday, 15, 2), '实现面板'),
        todosWrite(at(thursday, 15, 3), [{ content: '写面板', status: 'pending' }]),
      ],
    }),
  ];

  const report = buildReport({ kind: 'weekly', dateKey: thursday, tz: TZ, facts, now: at(thursday, 23) });

  assert.equal(report.kind, 'weekly');
  assert.deepEqual(report.range.days, [
    '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08',
  ]);
  assert.equal(report.range.label, '2026-11-02 ~ 2026-11-08');
  assert.equal(report.days.length, 7);
  assert.equal(report.days[0].sessions, 1);
  assert.equal(report.days[0].turns, 1);
  assert.equal(report.days[3].sessions, 1);
  assert.equal(report.days[3].turns, 2);
  assert.equal(report.stats.sessions, 2);
  assert.equal(report.stats.turns, 3);
  assert.equal(report.blocks.length, 2); // 一个目标块 + 一个项目块
  assert.match(report.summary, /^本周 2 天有记录/);
});

test('周报：跨周事件被排除', () => {
  const sunday = '2026-11-08';
  const facts = [
    sessionFacts({
      sessionId: 'x',
      cwd: '/tmp/x',
      events: [
        userMessage(at('2026-11-01', 10), '上周日的会话'),
        userMessage(at(sunday, 10), '本周日的会话'),
        title(at(sunday, 10, 1), '跨周会话'),
      ],
    }),
  ];
  const report = buildReport({ kind: 'weekly', dateKey: '2026-11-05', tz: TZ, facts, now: at(sunday, 23) });
  assert.equal(report.stats.humanMessages, 1);
  assert.equal(report.blocks[0].actions[0].text, '跨周会话');
});

/* ------------------------------------------------------------------ */
/* 空态与读取失败                                                       */
/* ------------------------------------------------------------------ */

test('空窗口返回空态', () => {
  const report = buildReport({ kind: 'daily', dateKey: '2026-11-05', tz: TZ, facts: [], now: at('2026-11-05', 23) });
  assert.equal(report.empty, true);
  assert.deepEqual(report.blocks, []);
  assert.deepEqual(report.todos, []);
  assert.equal(report.summary, '这一天没有记录到 AI 会话活动。');
});

test('读取失败的会话不进入报告，但记入 failures', () => {
  const fact = extractSessionFacts({
    sessionId: 'bad',
    cwd: '/tmp/bad',
    events: [],
    error: 'session/not-found',
  });
  const report = buildReport({ kind: 'daily', dateKey: '2026-11-05', tz: TZ, facts: [fact], now: at('2026-11-05', 23) });
  assert.equal(report.empty, true);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].sessionId, 'bad');
});
