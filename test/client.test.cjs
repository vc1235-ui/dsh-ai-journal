'use strict';
/**
 * Client 半区离线验证（vm 沙箱 + mock React/DOM/fetch，不启动浏览器）：
 * 1. 在 vm 沙箱里加载 client.js，mock window.__ModuleLoader__ / document / fetch / AbortController。
 * 2. 用最小的 React hooks 运行时渲染 JournalPanel，验证契约 v2 的 blocks/todos 渲染、
 *    待办全量显示、「新开对话」预填、loading → ready/empty/error、日报/周报切换、
 *    刷新、重试与竞态防护。
 * 3. 验证 apply(ctx) 注册两个槽位、main 的 inject 回调、样式插入与清理，以及字体/布局静态约束。
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const CLIENT_PATH = require('path').join(__dirname, '..', 'client.js');
const code = fs.readFileSync(CLIENT_PATH, 'utf8');

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.log('  ✗ ' + name + ' — ' + (error && error.message));
  }
}

// ---------------------------------------------------------------------------
// mock document
// ---------------------------------------------------------------------------
function makeDocument() {
  const head = {
    children: [],
    appendChild(element) {
      element.parentNode = head;
      head.children.push(element);
    },
    removeChild(element) {
      head.children = head.children.filter((child) => child !== element);
      element.parentNode = null;
    }
  };
  return {
    head,
    body: null,
    createElement() {
      return {
        attrs: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) {
          this.attrs[name] = value;
        }
      };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

// ---------------------------------------------------------------------------
// mock React（createElement + useState/useRef/useEffect 最小运行时）
// ---------------------------------------------------------------------------
function createMockReact() {
  const stateSlots = new Map();
  const refSlots = new Map();
  const effectSlots = [];
  let stateIndex = 0;
  let refIndex = 0;
  let effectIndex = 0;
  const pending = [];

  function depsEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!Object.is(left[index], right[index])) return false;
    }
    return true;
  }

  const api = {
    createElement(type, props) {
      const merged = {};
      if (props && typeof props === 'object') {
        for (const key of Object.keys(props)) merged[key] = props[key];
      }
      const children = Array.prototype.slice.call(arguments, 2);
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { type, props: merged };
    },
    useState(initial) {
      const index = stateIndex++;
      if (!stateSlots.has(index)) {
        stateSlots.set(index, { value: typeof initial === 'function' ? initial() : initial });
      }
      const slot = stateSlots.get(index);
      const setValue = (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      };
      return [slot.value, setValue];
    },
    useEffect(effect, deps) {
      const index = effectIndex++;
      const previous = effectSlots[index];
      if (previous && depsEqual(previous.deps, deps)) return;
      pending.push({ index, effect, deps });
    },
    useRef(initial) {
      const index = refIndex++;
      if (!refSlots.has(index)) refSlots.set(index, { current: initial });
      return refSlots.get(index);
    },
    begin() {
      stateIndex = 0;
      refIndex = 0;
      effectIndex = 0;
    },
    runEffects() {
      while (pending.length > 0) {
        const item = pending.shift();
        const previous = effectSlots[item.index];
        if (previous && typeof previous.cleanup === 'function') previous.cleanup();
        const cleanup = item.effect();
        effectSlots[item.index] = { deps: item.deps, cleanup };
      }
    }
  };
  api.React = {
    createElement: api.createElement,
    useState: api.useState,
    useEffect: api.useEffect,
    useRef: api.useRef
  };
  return api;
}

// ---------------------------------------------------------------------------
// mock fetch
// ---------------------------------------------------------------------------
const fetchMock = {
  calls: [],
  next: [],
  fetch(url, options) {
    fetchMock.calls.push({ url, options });
    const handler = fetchMock.next.shift();
    if (handler) return handler(url, options);
    return Promise.resolve(jsonResponse(dailyPayloadValue));
  }
};

function jsonResponse(body, status) {
  const codeValue = status === undefined ? 200 : status;
  return {
    ok: codeValue >= 200 && codeValue < 300,
    status: codeValue,
    json: () => Promise.resolve(body)
  };
}

function statusResponse(status) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(null) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 假数据（合成，不含真实会话内容）
// ---------------------------------------------------------------------------
function iso(offsetMs) {
  return Date.now() + (offsetMs || 0);
}

/** 与服务端/客户端一致的本地 MM-DD。 */
function mmdd(ms) {
  const date = new Date(ms);
  return String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

/** 合成一条 TodoItem。 */
function makeTodo(overrides) {
  const base = {
    kind: 'todo',
    content: '待办事项',
    status: 'pending',
    project: '个人AI',
    cwd: '/Users/synthetic/个人AI',
    sessionId: 'session-demo-1',
    sessionTitle: 'DSH插件：AI日报周报总结',
    goal: '做一个 AI 日报插件',
    suggestedPrompt: '继续完成待办：待办事项。所属目标：做一个 AI 日报插件。'
  };
  return Object.assign(base, overrides || {});
}

function dailyPayload() {
  const now = iso(0);
  const goalTodos = [
    makeTodo({
      kind: 'goal',
      content: '做一个 AI 日报插件',
      status: 'active',
      goal: null,
      suggestedPrompt: '继续推进目标：做一个 AI 日报插件。先回顾最近进展和卡点（当前进行中），再给出下一步计划并开始执行；完成后更新目标状态。'
    }),
    makeTodo({
      content: '实现 Client 半区面板',
      status: 'in_progress',
      suggestedPrompt: '继续完成待办：实现 Client 半区面板。所属目标：做一个 AI 日报插件。先确认当前进展和相关文件，再给出简短计划并开始执行；完成后更新待办。'
    }),
    makeTodo({
      content: '实现 Host 半区与日报聚合',
      suggestedPrompt: '继续完成待办：实现 Host 半区与日报聚合。所属目标：做一个 AI 日报插件。先确认当前进展和相关文件，再给出简短计划并开始执行；完成后更新待办。'
    }),
    makeTodo({
      content: '补充 UI 离线测试',
      suggestedPrompt: '继续完成待办：补充 UI 离线测试。所属目标：做一个 AI 日报插件。先确认当前进展和相关文件，再给出简短计划并开始执行；完成后更新待办。'
    }),
    makeTodo({
      content: '更新 README 与验收命令',
      suggestedPrompt: '继续完成待办：更新 README 与验收命令。所属目标：做一个 AI 日报插件。先确认当前进展和相关文件，再给出简短计划并开始执行；完成后更新待办。'
    }),
    makeTodo({
      content: '清理旧版 activity/groups 渲染代码',
      suggestedPrompt: '继续完成待办：清理旧版 activity/groups 渲染代码。所属目标：做一个 AI 日报插件。先确认当前进展和相关文件，再给出简短计划并开始执行；完成后更新待办。'
    }),
    makeTodo({
      content: '处理遗留的字体与高度样式',
      cwd: '/Users/synthetic/未知目录',
      suggestedPrompt: '继续完成待办：处理遗留的字体与高度样式。所属项目：未知目录。先确认当前进展和相关文件，再给出简短计划并开始执行；完成后更新待办。'
    })
  ];

  return {
    ok: true,
    kind: 'daily',
    tz: 'Asia/Singapore',
    range: { startMs: now - 86400000, endMs: now, label: '2026-11-05', days: ['2026-11-05'] },
    generatedAt: now,
    empty: false,
    summary: '今天 5 个会话、11 轮，围绕 2 个目标/项目展开；完成 1 项待办，还有 7 项未完成。',
    stats: {
      sessions: 5,
      turns: 11,
      humanMessages: 11,
      toolCalls: 491,
      projects: 3,
      blocks: 2,
      todosCompleted: 1,
      todosInProgress: 1,
      todosPending: 6,
      deliverables: 1,
      followups: 2,
      goalsActive: 1,
      goalsCompleted: 0
    },
    blocks: [
      {
        kind: 'goal',
        key: 'goal:做一个 AI 日报插件',
        label: '目标',
        title: '做一个 AI 日报插件',
        phase: 'active',
        summary:
          '目标「做一个 AI 日报插件」（进行中），2 个会话 5 轮：实现 Host 半区与日报聚合、实现 Client 半区面板 等 2 项；完成 1 项，还有 7 项待办。',
        actions: [
          { text: '实现 Host 半区与日报聚合', time: now - 3 * 3600000, sessionId: 'session-demo-1' },
          { text: '实现 Client 半区面板', time: now - 2 * 3600000, sessionId: 'session-demo-2' }
        ],
        results: [
          {
            kind: 'deliverable',
            text: '11 月 5 日日报',
            path: 'docs/日报-2026-11-05.md',
            openUrl: '/api/present.open?sessionId=session-demo-1&seq=42&index=0',
            time: now - 3500000,
            sessionId: 'session-demo-1'
          },
          { kind: 'todo', text: '完成离线单测', time: now - 3600000, sessionId: 'session-demo-1' }
        ],
        todos: goalTodos,
        sessionIds: ['session-demo-1', 'session-demo-2'],
        projects: ['个人AI'],
        firstTime: now - 5 * 3600000,
        lastTime: now - 3600000,
        stats: { sessions: 2, turns: 5, humanMessages: 4, toolCalls: 120, todosCompleted: 1, todosOpen: 7, deliverables: 1 }
      },
      {
        kind: 'project',
        key: 'project:/Users/synthetic/另一个项目',
        label: '项目',
        title: '另一个项目',
        phase: null,
        summary: '项目 另一个项目，1 个会话 3 轮；完成 0 项，没有遗留待办。',
        actions: [{ text: '修复构建脚本', time: now - 2 * 3600000, sessionId: 'session-demo-3' }],
        results: [],
        todos: [],
        sessionIds: ['session-demo-3'],
        projects: ['另一个项目'],
        firstTime: now - 4 * 3600000,
        lastTime: now - 2 * 3600000,
        stats: { sessions: 1, turns: 3, humanMessages: 2, toolCalls: 40, todosCompleted: 0, todosOpen: 0, deliverables: 0 }
      }
    ],
    todos: goalTodos,
    followups: [
      {
        kind: 'followup',
        key: '0123456789abcdef0123456789abcdef01234567',
        text: '飞书待回复轮询这个后续再聊',
        time: now - 1800000,
        sessionId: 'session-demo-2',
        sessionTitle: 'Hermes 迁移',
        project: 'workspace',
        cwd: '/Users/synthetic/个人AI',
        suggestedPrompt:
          '继续跟进之前提到的事项：飞书待回复轮询这个后续再聊。所属项目：workspace。来自会话「Hermes 迁移」。先确认当前状态和相关文件，再给出简短计划并开始执行；如果这件事已经不需要处理，请明确说明原因。'
      },
      {
        kind: 'followup',
        key: 'fedcba9876543210fedcba9876543210fedcba98',
        text: 'CI 告警阈值下次再确认',
        time: now - 5400000,
        sessionId: 'session-demo-3',
        sessionTitle: '插件发布',
        project: '另一个项目',
        cwd: '/Users/synthetic/未知目录',
        suggestedPrompt:
          '继续跟进之前提到的事项：CI 告警阈值下次再确认。所属项目：另一个项目。来自会话「插件发布」。先确认当前状态和相关文件，再给出简短计划并开始执行；如果这件事已经不需要处理，请明确说明原因。'
      }
    ],
    days: [{ date: '2026-11-05', label: '11月5日 周三', sessions: 5, turns: 11, activityCount: 5, unfinishedCount: 7 }],
    failures: []
  };
}

let dailyPayloadValue = dailyPayload();

function weeklyPayload(extra) {
  const payload = JSON.parse(JSON.stringify(dailyPayload()));
  payload.kind = 'weekly';
  payload.range = {
    startMs: iso(-3 * 86400000),
    endMs: iso(4 * 86400000),
    label: '2026-11-03 ~ 2026-11-09',
    days: ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']
  };
  payload.summary = '本周 3 天有记录，共 5 个会话、11 轮，围绕 2 个目标/项目展开；完成 1 项待办，还有 7 项未完成。';
  payload.days = [
    { date: '2026-11-03', label: '11月3日 周一', sessions: 1, turns: 2, activityCount: 1, unfinishedCount: 0 },
    { date: '2026-11-04', label: '11月4日 周二', sessions: 0, turns: 0, activityCount: 0, unfinishedCount: 0 },
    { date: '2026-11-05', label: '11月5日 周三', sessions: 2, turns: 5, activityCount: 2, unfinishedCount: 3 },
    { date: '2026-11-06', label: '11月6日 周四', sessions: 0, turns: 0, activityCount: 0, unfinishedCount: 0 },
    { date: '2026-11-07', label: '11月7日 周五', sessions: 1, turns: 3, activityCount: 1, unfinishedCount: 1 },
    { date: '2026-11-08', label: '11月8日 周六', sessions: 0, turns: 0, activityCount: 0, unfinishedCount: 0 },
    { date: '2026-11-09', label: '11月9日 周日', sessions: 1, turns: 1, activityCount: 1, unfinishedCount: 3 }
  ];
  if (extra) Object.assign(payload, extra);
  return payload;
}

/** 合成一个只有 stats.sessions 的块，用于验证块分布条上限。 */
function makeSyntheticBlock(title, sessions, key) {
  const now = iso(0);
  return {
    kind: 'project',
    key: 'project:' + key,
    label: '项目',
    title: title,
    phase: null,
    summary: '项目 ' + title + '，' + sessions + ' 个会话。',
    actions: [{ text: '推进 ' + title, time: now - 1000, sessionId: 's-' + key }],
    results: [],
    todos: [],
    sessionIds: ['s-' + key],
    projects: [title],
    firstTime: now - 2000,
    lastTime: now - 1000,
    stats: {
      sessions: sessions,
      turns: sessions * 2,
      humanMessages: sessions,
      toolCalls: sessions * 3,
      todosCompleted: 0,
      todosOpen: 0,
      deliverables: 0
    }
  };
}

// ---------------------------------------------------------------------------
// 渲染与查找辅助
// ---------------------------------------------------------------------------
function collectText(node, out) {
  const acc = out || [];
  if (node === null || node === undefined || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, acc);
    return acc;
  }
  if (node.props && node.props.children !== undefined) collectText(node.props.children, acc);
  return acc;
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  if (node.props && node.props.children !== undefined) walk(node.props.children, visit);
}

/** 展开函数组件，得到可断言的宿主元素树。 */
function resolveTree(node) {
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map(resolveTree).filter((child) => child !== null);
  if (typeof node.type === 'function') return resolveTree(node.type(node.props || {}));
  if (node.props) {
    const next = Object.assign({}, node.props);
    if (next.children !== undefined) next.children = resolveTree(next.children);
    return { type: node.type, props: next };
  }
  return node;
}

function findButton(tree, text) {
  let found = null;
  walk(tree, (node) => {
    if (found) return;
    if (node.type === 'button' && node.props && node.props.children === text) found = node;
  });
  return found;
}

/** className 按空白分词匹配，查询可写多个类名（必须全部命中）。 */
function classMatches(node, query) {
  if (!node.props || typeof node.props.className !== 'string') return false;
  const own = node.props.className.split(/\s+/).filter(Boolean);
  return String(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => own.includes(token));
}

function findByClass(tree, className) {
  let found = null;
  walk(tree, (node) => {
    if (found) return;
    if (classMatches(node, className)) found = node;
  });
  return found;
}

function findAllByClass(tree, className) {
  const found = [];
  walk(tree, (node) => {
    if (classMatches(node, className)) found.push(node);
  });
  return found;
}

/** 从 CSS 源文本里截取某个选择器的声明块。 */
function cssRule(cssBlock, selector) {
  const marker = selector + '{';
  const index = cssBlock.indexOf(marker);
  if (index === -1) return '';
  const start = index + marker.length;
  const end = cssBlock.indexOf('}', start);
  return end === -1 ? '' : cssBlock.slice(start, end);
}

// ---------------------------------------------------------------------------
// 工作区假数据：cwd 匹配用
// ---------------------------------------------------------------------------
const WORKSPACES = [
  { workspaceId: 'ws-main', path: '/Users/synthetic/个人AI', title: '个人AI' },
  { workspaceId: 'ws-other', path: '/Users/synthetic/另一个项目', title: '另一个项目' }
];

// ---------------------------------------------------------------------------
// 1. 加载 bundle
// ---------------------------------------------------------------------------
let definition = null;
const documentMock = makeDocument();
// 面板的「短暂提示」用 setTimeout 自动消失；测试里收集后在断言后统一 flush。
const sandboxTimers = [];
function flushSandboxTimers() {
  while (sandboxTimers.length > 0) {
    const item = sandboxTimers.shift();
    clearTimeout(item.id);
    item.fn();
  }
}
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(def) {
        definition = def;
      }
    }
  },
  document: documentMock,
  fetch: fetchMock.fetch,
  AbortController,
  Intl,
  console,
  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    sandboxTimers.push({ id, fn });
    return id;
  },
  clearTimeout(id) {
    clearTimeout(id);
    const index = sandboxTimers.findIndex((item) => item.id === id);
    if (index !== -1) sandboxTimers.splice(index, 1);
  }
};
vm.runInNewContext(code, sandbox);

console.log('\n[1] bundle 加载');
check('window.__ModuleLoader__.load 被调用，id = dsh-ai-journal', () => {
  assert.ok(definition, 'definition missing');
  assert.strictEqual(definition.id, 'dsh-ai-journal');
  assert.strictEqual(typeof definition.factory, 'function');
});

const mockReact = createMockReact();
const requireCalls = [];
const exported = definition.factory((name) => {
  requireCalls.push(name);
  if (name === 'react') return mockReact.React;
  throw new Error('unexpected require: ' + name);
});

check('factory 只 require("react")', () => {
  assert.deepStrictEqual(requireCalls, ['react']);
});

check('导出 inject = ["slots", "uiWorkspace", "workspaces"]', () => {
  assert.ok(Array.isArray(exported.inject), 'inject is not an array');
  assert.strictEqual(exported.inject.length, 3);
  assert.strictEqual(exported.inject[0], 'slots');
  assert.strictEqual(exported.inject[1], 'uiWorkspace');
  assert.strictEqual(exported.inject[2], 'workspaces');
  assert.strictEqual(typeof exported.apply, 'function');
  assert.strictEqual(typeof exported.JournalPanel, 'function');
  assert.strictEqual(typeof exported.JournalIcon, 'function');
});

// ---------------------------------------------------------------------------
// 2. 图标
// ---------------------------------------------------------------------------
console.log('\n[2] 左侧栏图标');
check('JournalIcon({size,active}) 输出 svg 且用 currentColor', () => {
  const iconTree = exported.JournalIcon({ size: 20, active: true });
  assert.strictEqual(iconTree.type, 'svg');
  assert.strictEqual(iconTree.props.width, 20);
  assert.strictEqual(iconTree.props.height, 20);
  assert.strictEqual(iconTree.props.stroke, 'currentColor');
  assert.strictEqual(iconTree.props['aria-hidden'], 'true');
  assert.ok(Array.isArray(iconTree.props.children) && iconTree.props.children.length >= 3);
});

check('JournalIcon 默认 size 16（宿主窄栏）', () => {
  const iconTree = exported.JournalIcon({ size: 16, active: false });
  assert.strictEqual(iconTree.props.width, 16);
  assert.strictEqual(iconTree.props.stroke, 'currentColor');
});

// ---------------------------------------------------------------------------
// 3. apply(ctx) 注册
// ---------------------------------------------------------------------------
console.log('\n[3] apply(ctx) 槽位注册与样式');
const injections = [];
const registrations = [];
const styleEffects = [];
const startSessionCalls = [];
const ctx = {
  effect(fn, label) {
    const cleanup = fn();
    styleEffects.push({ label, cleanup });
    return cleanup;
  },
  slots: {
    inject(owner, callback) {
      injections.push(owner);
      return callback();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    }
  },
  workspaces: {
    list: {
      getSnapshot() {
        return { items: WORKSPACES, phase: 'ready', state: 'ready', pinnedSessionIds: [], archivedSessionIds: [] };
      }
    }
  },
  uiWorkspace: {
    startSession(...args) {
      startSessionCalls.push(args);
    }
  }
};
exported.apply(ctx);

const mainRegistration = registrations.find((entry) => entry.options.name === 'main');
const sidebarRegistration = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
const panelProps = mainRegistration && typeof mainRegistration.options.inject === 'function' ? mainRegistration.options.inject() : {};

check('ctx.slots.inject 顺序为 main → sidebar.panellist', () => {
  assert.deepStrictEqual(injections, ['main', 'sidebar.panellist']);
});

check('注册 main keyed 面板 { name: "main", key: "ai-journal" } 且 inject 提供 onStartSession', () => {
  assert.ok(mainRegistration, 'main registration missing');
  assert.strictEqual(mainRegistration.options.key, 'ai-journal');
  assert.strictEqual(mainRegistration.component, exported.JournalPanel);
  assert.strictEqual(typeof mainRegistration.options.inject, 'function');
  assert.strictEqual(typeof panelProps.onStartSession, 'function');
});

check('注册左侧栏 { id: "ai-journal", order: 20, label → "AI 日报" }', () => {
  assert.ok(sidebarRegistration, 'sidebar registration missing');
  assert.strictEqual(sidebarRegistration.options.id, 'ai-journal');
  assert.strictEqual(sidebarRegistration.options.order, 20);
  assert.strictEqual(typeof sidebarRegistration.options.label, 'function');
  assert.strictEqual(sidebarRegistration.options.label(), 'AI 日报');
  assert.strictEqual(sidebarRegistration.component, exported.JournalIcon);
});

check('ctx.effect 注入 <style>，dispose 后移除', () => {
  assert.strictEqual(styleEffects.length, 1);
  assert.strictEqual(styleEffects[0].label, 'ai-journal: styles');
  assert.strictEqual(documentMock.head.children.length, 1);
  const tag = documentMock.head.children[0];
  assert.strictEqual(tag.attrs['data-dsh-ai-journal-style'], '');
  assert.ok(tag.textContent.includes('--dsw-alias-bg-base'));
  assert.ok(tag.textContent.includes('.aij-page'));
  styleEffects[0].cleanup();
  assert.strictEqual(documentMock.head.children.length, 0);
});

// ---------------------------------------------------------------------------
// 4. 面板渲染
// ---------------------------------------------------------------------------
let lastTree = null;

function render() {
  mockReact.begin();
  const element = exported.JournalPanel(panelProps);
  mockReact.runEffects();
  lastTree = resolveTree(element);
  return lastTree;
}

console.log('\n[4] 面板：loading → ready（日报）');
let tree = render();
check('首帧 loading：含标题、刷新按钮、日报/周报切换、加载文案', () => {
  const text = collectText(tree).join('\n');
  assert.ok(text.includes('AI 日报'), 'missing title');
  assert.ok(text.includes('日报') && text.includes('周报'), 'missing kind switch');
  assert.ok(text.includes('正在生成日报…'), 'missing loading copy');
  assert.ok(findByClass(tree, 'aij-refreshBtn'), 'missing refresh button');
  assert.ok(text.includes('今天') && text.includes('‹') && text.includes('›'), 'missing date navigation');
});

check('请求 URL 形状：/ai-journal/api?kind=daily&date=YYYY-MM-DD&tz=...（首屏不带 refresh）', () => {
  assert.strictEqual(fetchMock.calls.length, 1);
  const call = fetchMock.calls[0];
  assert.ok(call.url.startsWith('/ai-journal/api?'), call.url);
  assert.ok(/kind=daily/.test(call.url), call.url);
  assert.ok(/date=\d{4}-\d{2}-\d{2}/.test(call.url), call.url);
  assert.ok(/tz=/.test(call.url), call.url);
  assert.ok(!/refresh=1/.test(call.url), 'first load must not force refresh');
  assert.strictEqual(call.options.credentials, 'same-origin');
  assert.strictEqual(call.options.cache, 'no-store');
});

setTimeout(async () => {
  try {
    render();

    check('ready 后概览：只保留范围/时区/更新时间 + KPI 大数字行（去重后不再显示文字总结）', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(!text.includes('今天 5 个会话、11 轮，围绕 2 个目标/项目展开'), 'summary sentence duplicates the KPI numbers and must be gone');
      assert.ok(!findByClass(lastTree, 'aij-summary'), 'summary paragraph must be removed');
      assert.ok(text.includes('范围 2026-11-05'), 'missing range');
      assert.ok(text.includes('时区 Asia/Singapore'), 'missing tz');
      assert.ok(text.includes('更新于'), 'missing generatedAt');
      assert.ok(!findByClass(lastTree, 'aij-statsLine'), 'text stats line must be gone');
      assert.ok(!text.includes('491 次工具调用'), 'plain text stats must be replaced by KPI tiles');
      assert.ok(!findByClass(lastTree, 'aij-kpiFill'), 'KPI mini bars must be removed');
      const kpis = findAllByClass(lastTree, 'aij-kpi');
      assert.strictEqual(kpis.length, 6, 'expected 6 KPI tiles');
      const labels = kpis.map((kpi) => collectText(findByClass(kpi, 'aij-kpiLabel')).join(''));
      assert.deepStrictEqual(labels, ['会话', '轮次', '我的输入', '工具调用', '交付物', '完成待办']);
      const values = kpis.map((kpi) => collectText(findByClass(kpi, 'aij-kpiValue')).join(''));
      assert.deepStrictEqual(values, ['5', '11', '11', '491', '1', '1']);
      assert.ok(findByClass(lastTree, 'aij-kpiRow'), 'missing KPI row');
      assert.strictEqual(findByClass(lastTree, 'aij-kpiRow').props['aria-label'], '关键指标');
    });

    check('按块渲染：目标块 + 项目块，标题行含徽章/阶段/会话轮次', () => {
      const blocks = findAllByClass(lastTree, 'aij-block');
      assert.strictEqual(blocks.length, 2, 'expect 2 block cards');
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('做一个 AI 日报插件'), 'missing goal title');
      assert.ok(text.includes('另一个项目'), 'missing project title');
      assert.ok(text.includes('目标') && text.includes('项目'), 'missing block kind badges');
      assert.ok(text.includes('进行中'), 'missing goal phase badge');
      assert.ok(text.includes('2 个会话 · 5 轮'), 'missing block meta');
    });

    check('图形化总览：完成率环 / 块分布条，日报不画 7 天柱状图；指标已并入概览 KPI 行', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(findByClass(lastTree, 'aij-chartsSection'), 'missing charts section');
      assert.ok(findByClass(lastTree, 'aij-donutSvg'), 'missing donut');
      assert.ok(findAllByClass(lastTree, 'aij-distSegment').length >= 1, 'missing distribution segments');
      assert.ok(!findByClass(lastTree, 'aij-weekSvg'), 'daily must not render the weekly bar chart');
      assert.ok(text.includes('完成率') && text.includes('块分布'), 'missing chart titles');
      assert.ok(!text.includes('指标'), 'separate metrics card must be gone');
      const donut = findByClass(lastTree, 'aij-donutSvg');
      assert.strictEqual(donut.props.role, 'img');
      assert.ok(String(donut.props['aria-label']).includes('完成率'), 'donut needs a Chinese aria-label');
      const kpiIndex = text.indexOf('我的输入');
      const donutIndex = text.indexOf('完成率');
      const blockIndex = text.indexOf('做一个 AI 日报插件');
      assert.ok(
        kpiIndex >= 0 && donutIndex > kpiIndex && blockIndex > donutIndex,
        'KPI row must come before the charts, and charts before the blocks'
      );
    });

    check('完成率环按 stats 计算：完成 1 /（1+1+6）→ 13%，弧长成比例', () => {
      const percentNodes = findAllByClass(lastTree, 'aij-donutPercent');
      assert.strictEqual(percentNodes.length, 1);
      assert.strictEqual(percentNodes[0].props.children, '13%');
      const arcs = findAllByClass(lastTree, 'aij-donutArc');
      assert.strictEqual(arcs.length, 1);
      const dash = String(arcs[0].props.strokeDasharray).split(' ')[0];
      const ratio = Number(dash) / (2 * Math.PI * 34);
      assert.ok(Math.abs(ratio - 0.13) < 0.002, 'arc ratio should be 13%, got ' + ratio);
      const legend = findByClass(lastTree, 'aij-chartLegend');
      assert.ok(legend, 'missing donut legend');
      assert.strictEqual(collectText(legend).join(''), '完成 1 · 进行中 1 · 待办 6');
    });

    check('块分布条按 blocks[].stats.sessions 占比：2 段 2:1', () => {
      const segments = findAllByClass(lastTree, 'aij-distSegment');
      assert.strictEqual(segments.length, 2);
      assert.strictEqual(segments[0].props.style.width, '66.67%');
      assert.strictEqual(segments[1].props.style.width, '33.33%');
      assert.strictEqual(segments[0].props.title, '做一个 AI 日报插件 · 2 会话');
      const legend = findByClass(lastTree, 'aij-distLegend');
      const legendText = collectText(legend).join('\n');
      assert.ok(legendText.includes('做一个 AI 日报插件') && legendText.includes('另一个项目'), 'legend missing block names');
      assert.ok(legendText.includes('2 会话') && legendText.includes('1 会话'), 'legend missing session counts');
      const bar = findByClass(lastTree, 'aij-distBar');
      assert.strictEqual(bar.props.role, 'img');
      assert.ok(String(bar.props['aria-label']).includes('块分布'), 'distribution needs an aria-label');
    });

    check('KPI 行只有数字 + 标签，不再渲染任何进度条', () => {
      const kpis = findAllByClass(lastTree, 'aij-kpi');
      assert.strictEqual(kpis.length, 6);
      for (const kpi of kpis) {
        assert.ok(!findByClass(kpi, 'aij-kpiTrack'), 'KPI must not render a progress track');
        assert.ok(!findByClass(kpi, 'aij-kpiFill'), 'KPI must not render a progress fill');
      }
      assert.ok(!/aij-kpi(?:Track|Fill)/.test(code), 'progress-bar classes must be gone from the bundle');
      const values = kpis.map((kpi) => collectText(findByClass(kpi, 'aij-kpiValue')).join(''));
      assert.deepStrictEqual(values, ['5', '11', '11', '491', '1', '1']);
    });

    check('顶部图表卡固定三等分整行宽度（窄屏降为 2/1 列）', () => {
      const cssBlock = code.slice(code.indexOf('const CSS_TEXT'), code.indexOf('].join'));
      const rule = cssRule(cssBlock, '.aij-charts');
      assert.ok(/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(rule), 'charts must be three equal columns');
      assert.ok(code.includes('repeat(2,minmax(0,1fr))'), 'missing two-column breakpoint');
      assert.ok(code.includes('grid-template-columns:minmax(0,1fr)'), 'missing single-column breakpoint');
      // 周报三张卡（完成率/块分布/每日轮次）都不整行，等分
      assert.ok(!findAllByClass(lastTree, 'aij-chartCard').some((card) => String(card.props.className).includes('aij-chartWide')), 'daily cards must not span the full row');
    });

    check('块内三段：行动（有序列表）/ 结果 / 待办，且块摘要渲染', () => {
      const text = collectText(lastTree).join('\n');
      for (const title of ['行动', '结果', '待办']) assert.ok(text.includes(title), 'missing block section: ' + title);
      assert.ok(text.includes('目标「做一个 AI 日报插件」（进行中）'), 'missing block summary');
      assert.ok(findAllByClass(lastTree, 'aij-actions').length === 2, 'expect one action list per block');
      assert.ok(text.includes('实现 Host 半区与日报聚合'), 'missing action text');
      assert.ok(text.includes('完成离线单测'), 'missing result text');
      assert.ok(!text.includes('做了什么'), 'v1 activity section must be gone');
      assert.ok(!text.includes('归属目标'), 'v1 groups section must be gone');
      assert.ok(!text.includes('未完成事项'), 'v1 unfinished section must be gone');
    });

    const deliverableResult = dailyPayloadValue.blocks[0].results.find((result) => result.kind === 'deliverable');
    const deliverableLinks = findAllByClass(lastTree, 'aij-deliverableLink');
    const deliverablePaths = findAllByClass(lastTree, 'aij-deliverablePath');

    check('交付物结果行：描述 + 原始路径（title 全路径），是可点击按钮而非 <a href>', () => {
      assert.strictEqual(deliverableLinks.length, 1, 'expected exactly one deliverable link');
      assert.strictEqual(collectText(deliverableLinks[0]).join(''), '11 月 5 日日报打开');
      assert.strictEqual(deliverableLinks[0].props.type, 'button');
      assert.strictEqual(deliverablePaths.length, 1);
      assert.strictEqual(deliverablePaths[0].props.children, 'docs/日报-2026-11-05.md');
      assert.strictEqual(deliverablePaths[0].props.title, 'docs/日报-2026-11-05.md');
      let anchors = 0;
      walk(lastTree, (node) => {
        if (node.type === 'a') anchors += 1;
      });
      assert.strictEqual(anchors, 0, 'deliverable must not be an <a href>');
    });

    fetchMock.next.push(() => Promise.resolve(statusResponse(204)));
    deliverableLinks[0].props.onClick();
    await sleep(10);
    render();

    check('点击交付物：POST openUrl + &action=open、credentials same-origin，204 提示已打开', () => {
      const call = fetchMock.calls[fetchMock.calls.length - 1];
      assert.strictEqual(call.url, deliverableResult.openUrl + '&action=open');
      assert.strictEqual(call.options.method, 'POST');
      assert.strictEqual(call.options.credentials, 'same-origin');
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('已在宿主打开'), 'missing 204 notice');
    });

    async function clickDeliverable(responseFactory, expectedText) {
      const link = findAllByClass(lastTree, 'aij-deliverableLink')[0];
      fetchMock.next.push(responseFactory);
      link.props.onClick();
      await sleep(10);
      render();
      check('交付物打开状态映射：' + expectedText, () => {
        const text = collectText(lastTree).join('\n');
        assert.ok(text.includes(expectedText), 'missing notice: ' + expectedText);
      });
    }

    await clickDeliverable(() => Promise.resolve(statusResponse(409)), '宿主桌面不可用');
    await clickDeliverable(() => Promise.resolve(statusResponse(404)), '文件已不存在');
    await clickDeliverable(() => Promise.resolve(statusResponse(500)), '打开失败');
    await clickDeliverable(() => Promise.reject(new TypeError('open failed')), '打开失败');

    flushSandboxTimers();
    render();

    check('打开提示短暂显示后自动消失', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(!text.includes('已在宿主打开'), 'success notice should clear');
      assert.ok(!text.includes('宿主桌面不可用'), '409 notice should clear');
      assert.ok(!text.includes('文件已不存在'), '404 notice should clear');
    });

    const followupsValue = dailyPayloadValue.followups;

    check('待跟进区：标题 + 启发式说明 + 数量徽标，位于图表之后、blocks 之前', () => {
      const section = findByClass(lastTree, 'aij-followups');
      assert.ok(section, 'missing followups section');
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('待跟进 · 会话里提到、未写入待办'), 'missing followups title');
      assert.ok(
        text.includes('根据会话里的措辞识别，可能不准确；已写成待办的事项不在这里。'),
        'missing heuristic hint'
      );
      assert.strictEqual(findByClass(section, 'aij-countBadge').props.children, '2');
      assert.strictEqual(section.props['aria-label'], '待跟进事项');
      const rows = findAllByClass(section, 'aij-followupRow');
      assert.strictEqual(rows.length, 2, 'expected 2 followup rows');
      assert.strictEqual(findAllByClass(section, 'aij-badgeFollowup').length, 2, 'each row needs a 待跟进 badge');
      assert.ok(collectText(rows[0]).join('').includes(followupsValue[0].text), 'missing followup text');
      const order = [];
      walk(lastTree, (node) => {
        if (classMatches(node, 'aij-chartsSection')) order.push('charts');
        if (classMatches(node, 'aij-followups')) order.push('followups');
        if (classMatches(node, 'aij-block')) order.push('block');
      });
      assert.strictEqual(order[0], 'charts', 'charts must render first');
      assert.strictEqual(order[1], 'followups', 'followups must render between charts and blocks');
      assert.strictEqual(order[2], 'block', 'blocks must render after followups');
    });

    check('待跟进来源：会话标题 · 项目 · 日期（MM-DD）', () => {
      const rows = findAllByClass(findByClass(lastTree, 'aij-followups'), 'aij-followupRow');
      const expected =
        '来源：' +
        followupsValue[0].sessionTitle +
        ' · ' +
        followupsValue[0].project +
        ' · ' +
        mmdd(followupsValue[0].time);
      assert.strictEqual(findByClass(rows[0], 'aij-followupMeta').props.children, expected);
    });

    check('待跟进与待办视觉区分：强调条 + 独立背景 + 独立徽章，不复用待办行', () => {
      const cssBlock = code.slice(code.indexOf('const CSS_TEXT'), code.indexOf('].join'));
      const rule = cssRule(cssBlock, '.aij-followups');
      assert.ok(/border-left/.test(rule), 'followups block needs a left accent bar');
      assert.ok(/background:var\(--dsw-alias-bg-layer-1\)/.test(rule), 'followups block needs its own background');
      assert.ok(cssRule(cssBlock, '.aij-badgeFollowup') !== '', 'missing followup badge rule');
      const section = findByClass(lastTree, 'aij-followups');
      assert.strictEqual(findAllByClass(section, 'aij-todoRow').length, 0, 'followups must not reuse todo rows');
    });

    check('结果为空时显示「本周期没有标记完成的结果」（不编造）', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('本周期没有标记完成的结果'), 'missing empty-result hint');
      assert.ok(text.includes('本周期没有遗留待办。'), 'missing empty-todo hint for project block');
    });

    check('结果为空的项目块不渲染交付物链接（不编造）', () => {
      const blocks = findAllByClass(lastTree, 'aij-block');
      assert.strictEqual(blocks.length, 2);
      assert.strictEqual(findAllByClass(blocks[1], 'aij-deliverableLink').length, 0);
    });

    check('待办全量显示（7 条，不截断）', () => {
      const rows = findAllByClass(lastTree, 'aij-todoRow');
      assert.strictEqual(rows.length, 7, 'expected all 7 todos, got ' + rows.length);
      const text = collectText(lastTree).join('\n');
      const expected = dailyPayloadValue.blocks[0].todos.map((todo) => todo.content);
      for (const content of expected) assert.ok(text.includes(content), 'missing todo content: ' + content);
      assert.ok(!/还有\s*\d+\s*项待办未显示/.test(text), 'todos must not be truncated');
    });

    check('每条待办带「新开对话」按钮', () => {
      const rows = findAllByClass(lastTree, 'aij-todoRow');
      const buttons = rows.map((row) => findByClass(row, 'aij-newSessionBtn'));
      assert.strictEqual(rows.length, 7, 'expected 7 todo rows');
      assert.ok(buttons.every(Boolean), 'expected one 新开对话 per todo row');
      for (const button of buttons) {
        assert.strictEqual(button.props.children, '新开对话');
        assert.strictEqual(button.props.type, 'button');
      }
    });

    // -------------------------------------------------------------------
    // 5. 「新开对话」：workspaceId 匹配 + suggestedPrompt 预填
    // -------------------------------------------------------------------
    console.log('\n[5] 新开对话');
    let buttons = findAllByClass(lastTree, 'aij-todoRow').map((row) => findByClass(row, 'aij-newSessionBtn'));
    buttons[0].props.onClick();

    check('cwd 匹配 Workspace 时传入 workspaceId 与 suggestedPrompt', () => {
      assert.strictEqual(startSessionCalls.length, 1, 'startSession should be called once');
      const call = startSessionCalls[0];
      assert.strictEqual(call.length, 2);
      assert.strictEqual(call[0], 'ws-main');
      assert.strictEqual(call[1].prompt, dailyPayloadValue.blocks[0].todos[0].suggestedPrompt);
    });

    const unmatchedTodo = dailyPayloadValue.blocks[0].todos[6];
    const unmatchedIndex = dailyPayloadValue.blocks[0].todos.findIndex((todo) => todo.cwd === '/Users/synthetic/未知目录');
    assert.ok(unmatchedIndex >= 0, 'unmatched fixture missing');
    buttons[unmatchedIndex].props.onClick();

    check('cwd 匹配不到 Workspace 时省略第一个参数（走最近工作区），prompt 仍等于 suggestedPrompt', () => {
      assert.strictEqual(startSessionCalls.length, 2);
      const call = startSessionCalls[1];
      assert.strictEqual(call.length, 2);
      assert.strictEqual(call[0], undefined);
      assert.strictEqual(call[1].prompt, unmatchedTodo.suggestedPrompt);
    });

    // -------------------------------------------------------------------
    // 5.5 待跟进：新开对话 + 空数组/缺失字段降级
    // -------------------------------------------------------------------
    console.log('\n[5.5] 待跟进：新开对话与兼容性');
    let followupSection = findByClass(lastTree, 'aij-followups');
    let followupButtons = findAllByClass(followupSection, 'aij-newSessionBtn');
    assert.strictEqual(followupButtons.length, 2, 'expected 2 followup action buttons');
    followupButtons[0].props.onClick();

    check('待跟进点击「新开对话」：cwd 匹配 Workspace → workspaceId + suggestedPrompt', () => {
      assert.strictEqual(startSessionCalls.length, 3);
      const call = startSessionCalls[2];
      assert.strictEqual(call.length, 2);
      assert.strictEqual(call[0], 'ws-main');
      assert.strictEqual(call[1].prompt, followupsValue[0].suggestedPrompt);
    });

    followupSection = findByClass(lastTree, 'aij-followups');
    followupButtons = findAllByClass(followupSection, 'aij-newSessionBtn');
    followupButtons[1].props.onClick();

    check('待跟进 workspaceId 未命中时省略第一个参数，prompt 仍为 suggestedPrompt', () => {
      assert.strictEqual(startSessionCalls.length, 4);
      const call = startSessionCalls[3];
      assert.strictEqual(call.length, 2);
      assert.strictEqual(call[0], undefined);
      assert.strictEqual(call[1].prompt, followupsValue[1].suggestedPrompt);
    });

    // -------------------------------------------------------------------
    // 5.6 待跟进：忽略（dismiss）与撤销（restore）
    // -------------------------------------------------------------------
    console.log('\n[5.6] 待跟进：忽略与撤销');
    let followupDismissButtons = findAllByClass(findByClass(lastTree, 'aij-followups'), 'aij-dismissBtn');

    check('每条待跟进行渲染「这不是待办」次要按钮（warn/tertiary，不与主按钮抢）', () => {
      const section = findByClass(lastTree, 'aij-followups');
      const buttons = findAllByClass(section, 'aij-dismissBtn');
      assert.strictEqual(buttons.length, 2, 'expected one dismiss button per followup');
      for (const button of buttons) {
        assert.strictEqual(button.props.children, '这不是待办');
        assert.strictEqual(button.props.type, 'button');
      }
      const cssBlock = code.slice(code.indexOf('const CSS_TEXT'), code.indexOf('].join'));
      const rule = cssRule(cssBlock, '.aij-dismissBtn');
      assert.ok(rule !== '', 'missing dismiss button CSS');
      assert.ok(/background:transparent/.test(rule), 'dismiss button should be secondary (transparent background)');
      assert.ok(/color:var\(--dsw-alias-label-tertiary\)/.test(rule), 'dismiss button should use a muted color');
    });

    fetchMock.next.push(() => Promise.resolve(jsonResponse({ ok: false, message: 'boom' }, 500)));
    followupDismissButtons[1].props.onClick();
    await sleep(10);
    render();

    check('忽略请求失败：条目保留并提示「操作失败，请重试」', () => {
      const section = findByClass(lastTree, 'aij-followups');
      assert.ok(section);
      assert.strictEqual(findAllByClass(section, 'aij-followupRow').length, 2, 'item must stay after failure');
      assert.ok(collectText(lastTree).join('\n').includes('操作失败，请重试'), 'missing failure notice');
      assert.ok(collectText(section).join('').includes(followupsValue[1].text), 'failed item text should stay');
    });

    const callsBeforeDismiss = fetchMock.calls.length;
    fetchMock.next.push(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                jsonResponse({ ok: true, action: 'dismiss', dismissed: 1, persisted: true, removed: true })
              ),
            20
          )
        )
    );
    let dismissButtons = findAllByClass(findByClass(lastTree, 'aij-followups'), 'aij-dismissBtn');
    dismissButtons[0].props.onClick();
    dismissButtons[0].props.onClick(); // 重复点击不得再发请求
    await sleep(40);
    render();

    check('点击「这不是待办」：只 POST 一次忽略接口，body 含 action/key/sessionId/text', () => {
      assert.strictEqual(fetchMock.calls.length, callsBeforeDismiss + 1, 'only one POST expected');
      const call = fetchMock.calls[fetchMock.calls.length - 1];
      assert.strictEqual(call.url, '/ai-journal/api/followups');
      assert.strictEqual(call.options.method, 'POST');
      assert.strictEqual(call.options.credentials, 'same-origin');
      assert.ok(/application\/json/i.test(call.options.headers['content-type']), 'missing JSON content-type');
      assert.deepStrictEqual(JSON.parse(call.options.body), {
        action: 'dismiss',
        key: followupsValue[0].key,
        sessionId: followupsValue[0].sessionId,
        text: followupsValue[0].text
      });
    });

    check('忽略成功后该条立即消失，出现「已忽略 1 条 · 撤销」，不整页闪回 loading', () => {
      const section = findByClass(lastTree, 'aij-followups');
      assert.ok(section, 'section should remain for the undo entry');
      assert.strictEqual(findAllByClass(section, 'aij-followupRow').length, 1, 'dismissed item should be removed locally');
      assert.ok(!collectText(section).join('').includes(followupsValue[0].text), 'dismissed text should be gone');
      const ignored = findByClass(section, 'aij-followupIgnored');
      assert.ok(ignored, 'missing ignored line');
      assert.ok(collectText(ignored).join('').includes('已忽略 1 条'), 'missing ignored count');
      assert.ok(findByClass(ignored, 'aij-undoBtn'), 'missing undo entry');
      assert.ok(findByClass(lastTree, 'aij-donutSvg'), 'panel must stay ready (no full-page loading)');
      assert.ok(!collectText(lastTree).join('\n').includes('正在刷新当前视图…'), 'dismiss must not trigger a reload');
    });

    const callsBeforeUndo = fetchMock.calls.length;
    fetchMock.next.push(() =>
      Promise.resolve(jsonResponse({ ok: true, action: 'restore', dismissed: 0, persisted: true, removed: true }))
    );
    fetchMock.next.push(() => Promise.resolve(jsonResponse(dailyPayloadValue)));
    findByClass(lastTree, 'aij-undoBtn').props.onClick();
    render();
    await sleep(20);
    render();
    await sleep(30);
    render();

    check('撤销：POST restore 最近一条，成功后重新拉取报告（refresh=1）', () => {
      assert.strictEqual(fetchMock.calls.length, callsBeforeUndo + 2, 'expected restore POST + report reload');
      const restoreCall = fetchMock.calls[callsBeforeUndo];
      assert.strictEqual(restoreCall.url, '/ai-journal/api/followups');
      assert.strictEqual(restoreCall.options.method, 'POST');
      assert.deepStrictEqual(JSON.parse(restoreCall.options.body), {
        action: 'restore',
        key: followupsValue[0].key,
        sessionId: followupsValue[0].sessionId,
        text: followupsValue[0].text
      });
      const reloadCall = fetchMock.calls[callsBeforeUndo + 1];
      assert.ok(/\/ai-journal\/api\?/.test(reloadCall.url), reloadCall.url);
      assert.ok(/refresh=1/.test(reloadCall.url), 'reload should bypass cache like a refresh');
      assert.ok(/kind=daily/.test(reloadCall.url), reloadCall.url);
    });

    check('撤销成功后条目回来、忽略入口消失', () => {
      const section = findByClass(lastTree, 'aij-followups');
      assert.strictEqual(findAllByClass(section, 'aij-followupRow').length, 2);
      assert.ok(collectText(section).join('').includes(followupsValue[0].text), 'restored item should be visible again');
      assert.strictEqual(findByClass(section, 'aij-followupIgnored'), null, 'ignored entry should be gone');
    });

    fetchMock.next.push(() =>
      Promise.resolve(jsonResponse({ ok: true, action: 'dismiss', dismissed: 1, persisted: false, removed: true }))
    );
    findAllByClass(findByClass(lastTree, 'aij-followups'), 'aij-dismissBtn')[0].props.onClick();
    await sleep(10);
    render();

    check('persisted:false 时提示「已忽略，但未能写入本机记录」，条目仍移除', () => {
      const section = findByClass(lastTree, 'aij-followups');
      assert.ok(collectText(lastTree).join('\n').includes('已忽略，但未能写入本机记录'), 'missing persistence warning');
      assert.strictEqual(findAllByClass(section, 'aij-followupRow').length, 1);
      assert.ok(!collectText(section).join('').includes(followupsValue[0].text));
    });

    const noKeyPayload = JSON.parse(JSON.stringify(dailyPayloadValue));
    delete noKeyPayload.followups[1].key;
    fetchMock.next.push(() => Promise.resolve(jsonResponse(noKeyPayload)));
    findByClass(lastTree, 'aij-refreshBtn').props.onClick();
    render();
    render();
    await sleep(30);
    render();
    render(); // data 变化后的 effect 清空本地忽略状态，再渲染一次才反映到树上

    check('缺 key 的老数据：条目照常展示，但不渲染「这不是待办」（防御）', () => {
      const section = findByClass(lastTree, 'aij-followups');
      assert.strictEqual(findAllByClass(section, 'aij-followupRow').length, 2);
      assert.strictEqual(findAllByClass(section, 'aij-dismissBtn').length, 1, 'only the keyed row offers dismiss');
      assert.ok(collectText(section).join('').includes(followupsValue[1].text), 'keyless item should still render');
    });

    const emptyFollowupPayload = JSON.parse(JSON.stringify(dailyPayloadValue));
    emptyFollowupPayload.followups = [];
    emptyFollowupPayload.stats.followups = 0;
    fetchMock.next.push(() => Promise.resolve(jsonResponse(emptyFollowupPayload)));
    findByClass(lastTree, 'aij-refreshBtn').props.onClick();
    render();
    render();
    await sleep(30);
    render();
    render();

    check('followups: [] 时整块不渲染（不出现空标题/空占位）', () => {
      assert.strictEqual(findByClass(lastTree, 'aij-followups'), null, 'followups block should be hidden');
      assert.ok(!collectText(lastTree).join('\n').includes('待跟进 · 会话里提到'), 'followups title must not appear');
    });

    const missingFollowupPayload = JSON.parse(JSON.stringify(dailyPayloadValue));
    delete missingFollowupPayload.followups;
    fetchMock.next.push(() => Promise.resolve(jsonResponse(missingFollowupPayload)));
    findByClass(lastTree, 'aij-refreshBtn').props.onClick();
    render();
    render();
    await sleep(30);
    render();
    render();

    check('payload 缺失 followups 字段时自然降级：不渲染、不报错，其余照常', () => {
      assert.strictEqual(findByClass(lastTree, 'aij-followups'), null, 'followups block should be hidden');
      assert.ok(findByClass(lastTree, 'aij-donutSvg'), 'rest of the panel should still render');
      assert.ok(!collectText(lastTree).join('\n').includes('待跟进事项'), 'no followup placeholder');
      assert.ok(!collectText(lastTree).join('\n').includes('待跟进 · 会话里提到'), 'no followup title');
    });

    // -------------------------------------------------------------------
    // 6. 切换到周报 + 每日分布
    // -------------------------------------------------------------------
    console.log('\n[6] 面板：切换周报 + 每日分布');
    fetchMock.next.push(() => Promise.resolve(jsonResponse(weeklyPayload())));
    findButton(lastTree, '周报').props.onClick();
    render();

    check('切换视图立即进入加载态，不闪现上一窗口内容', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('正在生成周报…'), 'weekly loading copy missing');
      assert.ok(!text.includes('今天 5 个会话'), 'daily content must not linger after switching');
    });

    await sleep(30);
    render();

    check('周报请求 kind=weekly', () => {
      const call = fetchMock.calls[fetchMock.calls.length - 1];
      assert.ok(/kind=weekly/.test(call.url), call.url);
      assert.ok(/date=\d{4}-\d{2}-\d{2}/.test(call.url), call.url);
    });

    check('周报底部每日分布：表头 4 列 + 7 行', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('每日分布'), 'missing 每日分布');
      assert.ok(text.includes('2026-11-03 ~ 2026-11-09'), 'missing weekly range label');
      assert.ok(text.includes('11月3日 周一'), 'missing day label');
      const header = findByClass(lastTree, 'aij-dayGrid aij-dayGridHead');
      assert.ok(header, 'missing day header row');
      const headerText = collectText(header).join(' ');
      for (const label of ['日期', '会话', '轮次', '未完成']) assert.ok(headerText.includes(label), 'missing column: ' + label);
      const dayRows = findAllByClass(lastTree, 'aij-dayGrid').filter(
        (node) => !node.props.className.includes('aij-dayGridHead')
      );
      assert.strictEqual(dayRows.length, 7, 'expected 7 day rows');
    });

    check('周报 7 天柱状图：7 个槽位、4 根非零柱、0 轮保留空位、中文 aria-label', () => {
      assert.ok(findByClass(lastTree, 'aij-donutSvg'), 'weekly view should keep the completion ring');
      const svg = findByClass(lastTree, 'aij-weekSvg');
      assert.ok(svg, 'missing weekly bar chart');
      assert.strictEqual(svg.props.role, 'img');
      assert.ok(String(svg.props['aria-label']).includes('每日轮次'), 'week chart needs a Chinese aria-label');
      const slots = findAllByClass(lastTree, 'aij-weekBarSlot');
      assert.strictEqual(slots.length, 7, 'expected 7 day slots');
      const bars = findAllByClass(lastTree, 'aij-weekBar');
      assert.strictEqual(bars.length, 4, 'expected 4 non-zero bars, got ' + bars.length);
      assert.strictEqual(slots[0].props['aria-label'], '11月3日 周一 · 1 会话 · 2 轮');
      const slotTitles = [];
      walk(slots[0], (node) => {
        if (node.type === 'title') slotTitles.push(collectText(node).join(''));
      });
      assert.deepStrictEqual(slotTitles, ['11月3日 周一 · 1 会话 · 2 轮'], 'slot keeps a native title tooltip');
      assert.ok(Number(bars[1].props.height) > Number(bars[0].props.height), 'bar height should follow turns');
      const axes = findAllByClass(lastTree, 'aij-weekAxis');
      assert.ok(axes.length >= 7, 'expected axis labels');
      for (const axis of axes) assert.strictEqual(axis.props.fontSize, 9, 'axis labels must stay small (fontSize 9)');
      const values = findAllByClass(lastTree, 'aij-weekValue');
      assert.ok(values.length >= 7, 'expected hover value labels');
      for (const value of values) assert.strictEqual(value.props.fontSize, 9, 'hover values must be small');
      assert.strictEqual(collectText(values[0]).join(''), '2 轮', 'hover value should show the turn count');
      assert.ok(/aij-weekBarSlot:hover \.aij-weekValue/.test(code), 'hover rule must reveal the value');
      assert.ok(code.includes('opacity:0'), 'hover values stay hidden until hover');
      const zeroSlot = slots.find((slot) => String(slot.props['aria-label']).startsWith('11月4日 周二'));
      assert.ok(zeroSlot, 'missing zero-turn slot');
      let zeroRects = 0;
      walk(zeroSlot, (node) => {
        if (node.type === 'rect') zeroRects += 1;
      });
      assert.strictEqual(zeroRects, 0, '0-turn day must keep an empty slot');
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('11-03') && text.includes('11-09'), 'missing MM-DD axis labels');
    });

    // -------------------------------------------------------------------
    // 7. 竞态：快速翻周，迟到的旧请求不能覆盖新结果
    // -------------------------------------------------------------------
    console.log('\n[7] 面板：请求竞态（旧请求迟到不得覆盖）');
    fetchMock.next.push(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(jsonResponse(weeklyPayload({ range: { startMs: 1, endMs: 2, label: 'STALE-LABEL', days: [] } }))),
            80
          )
        )
    );
    fetchMock.next.push(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(jsonResponse(weeklyPayload({ range: { startMs: 3, endMs: 4, label: 'FRESH-LABEL', days: [] } }))),
            5
          )
        )
    );
    const prevWeekButtons = [];
    walk(lastTree, (node) => {
      if (node.type === 'button' && node.props && node.props['aria-label'] === '上一周') prevWeekButtons.push(node);
    });
    assert.strictEqual(prevWeekButtons.length, 1, 'prev week button missing');
    prevWeekButtons[0].props.onClick();
    render();
    prevWeekButtons[0].props.onClick();
    render();
    await sleep(160);
    render();

    check('迟到的旧响应被丢弃，界面显示最新结果', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('FRESH-LABEL'), 'fresh label missing');
      assert.ok(!text.includes('STALE-LABEL'), 'stale label leaked into view');
    });

    // -------------------------------------------------------------------
    // 7.5 同窗口刷新：保留旧内容 + 顶部提示，新数据到达后替换
    // -------------------------------------------------------------------
    console.log('\n[7.5] 面板：同窗口刷新保留旧内容');
    fetchMock.next.push(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(jsonResponse(weeklyPayload({ range: { startMs: 5, endMs: 6, label: 'KEPT-LABEL', days: [] } }))),
            60
          )
        )
    );
    findByClass(lastTree, 'aij-refreshBtn').props.onClick();
    render();
    render(); // 第一次 render 执行 effect 把 status 置为 loading，第二次才反映到树上

    check('刷新中保留旧内容并提示「正在刷新当前视图…」', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('正在刷新当前视图…'), 'missing refreshing status line');
      assert.ok(text.includes('FRESH-LABEL'), 'old content must stay visible while refreshing');
      assert.ok(findByClass(lastTree, 'aij-refreshBtn').props.disabled === true, 'refresh button should be disabled');
    });

    await sleep(90);
    render();

    check('刷新完成后内容替换为新数据、提示消失', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('KEPT-LABEL'), 'fresh content missing after refresh');
      assert.ok(!text.includes('正在刷新当前视图…'), 'refreshing line should be gone');
    });

    // -------------------------------------------------------------------
    // 7.6 图形化总览数值：完成率 75%、块分布 4 段上限、分母 0 → 0%
    // -------------------------------------------------------------------
    console.log('\n[7.6] 图形化总览数值');
    const chartPayload = weeklyPayload();
    chartPayload.stats.todosCompleted = 3;
    chartPayload.stats.todosInProgress = 0;
    chartPayload.stats.todosPending = 1;
    chartPayload.stats.deliverables = 0;
    chartPayload.blocks = [
      makeSyntheticBlock('块一', 10, 'a'),
      makeSyntheticBlock('块二', 5, 'b'),
      makeSyntheticBlock('块三', 3, 'c'),
      makeSyntheticBlock('块四', 1, 'd'),
      makeSyntheticBlock('块五', 1, 'e')
    ];
    fetchMock.next.push(() => Promise.resolve(jsonResponse(chartPayload)));
    findByClass(lastTree, 'aij-refreshBtn').props.onClick();
    render();
    render();
    await sleep(30);
    render();

    check('完成率环 3/4 → 75%，图例同步', () => {
      const percent = findAllByClass(lastTree, 'aij-donutPercent');
      assert.strictEqual(percent.length, 1);
      assert.strictEqual(percent[0].props.children, '75%');
      const arcs = findAllByClass(lastTree, 'aij-donutArc');
      const dash = String(arcs[0].props.strokeDasharray).split(' ')[0];
      assert.ok(Math.abs(Number(dash) / (2 * Math.PI * 34) - 0.75) < 0.002, 'arc ratio should be 75%');
      assert.strictEqual(
        collectText(findByClass(lastTree, 'aij-chartLegend')).join(''),
        '完成 3 · 进行中 0 · 待办 1'
      );
    });

    check('块分布超过 4 个块时：前 3 块 + 「其它」共 4 段，比例 50/25/15/10', () => {
      const segments = findAllByClass(lastTree, 'aij-distSegment');
      assert.strictEqual(segments.length, 4, 'expected 4 stacked segments');
      assert.deepStrictEqual(
        segments.map((segment) => segment.props.style.width),
        ['50%', '25%', '15%', '10%']
      );
      const legendText = collectText(findByClass(lastTree, 'aij-distLegend')).join('\n');
      assert.ok(legendText.includes('块一') && legendText.includes('块二') && legendText.includes('块三'), 'missing top block names');
      assert.ok(legendText.includes('其它'), 'missing 其它 segment');
      assert.ok(legendText.includes('2 会话'), '其它 should aggregate the rest');
    });

    const zeroPayload = JSON.parse(JSON.stringify(chartPayload));
    zeroPayload.stats.todosCompleted = 0;
    zeroPayload.stats.todosInProgress = 0;
    zeroPayload.stats.todosPending = 0;
    fetchMock.next.push(() => Promise.resolve(jsonResponse(zeroPayload)));
    findByClass(lastTree, 'aij-refreshBtn').props.onClick();
    render();
    render();
    await sleep(30);
    render();

    check('完成率分母为 0 时显示 0%', () => {
      assert.strictEqual(findAllByClass(lastTree, 'aij-donutPercent')[0].props.children, '0%');
    });

    // -------------------------------------------------------------------
    // 8. 错误状态 + 重试（刷新带 refresh=1）
    // -------------------------------------------------------------------
    console.log('\n[8] 面板：错误状态与重试');
    const callsBeforeRefresh = fetchMock.calls.length;
    fetchMock.next.push(() => Promise.reject(new TypeError('Failed to fetch')));
    findByClass(lastTree, 'aij-refreshBtn').props.onClick();
    render();
    await sleep(30);
    render();

    check('刷新请求带 refresh=1', () => {
      assert.strictEqual(fetchMock.calls.length, callsBeforeRefresh + 1);
      assert.ok(/refresh=1/.test(fetchMock.calls[fetchMock.calls.length - 1].url), 'refresh should bypass cache');
    });

    check('网络失败显示中文错误与「重试」', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('AI 日报加载失败'), 'missing error title');
      assert.ok(text.includes('网络请求失败，请检查连接后重试。'), 'missing network error copy');
      assert.ok(findButton(lastTree, '重试'), 'missing retry button');
    });

    fetchMock.next.push(() => Promise.resolve(jsonResponse(weeklyPayload())));
    findButton(lastTree, '重试').props.onClick();
    render();
    await sleep(30);
    render();

    check('重试成功后回到 ready', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('概览') || text.includes('每日分布'), 'retry did not recover');
      assert.ok(!text.includes('AI 日报加载失败'), 'error box should be gone');
    });

    // -------------------------------------------------------------------
    // 9. 契约错误、空状态、读取失败提示
    // -------------------------------------------------------------------
    console.log('\n[9] 面板：契约错误 / 空状态 / 读取失败提示');
    fetchMock.next.push(() => Promise.resolve(jsonResponse({ ok: false, code: 'internal', message: '聚合过程失败' }, 500)));
    findByClass(lastTree, 'aij-refreshBtn').props.onClick();
    render();
    await sleep(30);
    render();

    check('HTTP 500 + ok:false 显示契约错误文案（含 detail）', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('生成日报时出错，请稍后重试。'), 'missing internal copy');
      assert.ok(text.includes('聚合过程失败'), 'missing server detail');
    });

    const emptyPayload = weeklyPayload();
    emptyPayload.empty = true;
    emptyPayload.summary = '';
    fetchMock.next.push(() => Promise.resolve(jsonResponse(emptyPayload)));
    findButton(lastTree, '重试').props.onClick();
    render();
    await sleep(30);
    render();

    check('empty=true 显示空状态说明', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('这一周没有 AI 会话活动'), 'missing empty title');
      assert.ok(text.includes('当前范围：'), 'missing empty label');
    });

    const failurePayload = weeklyPayload();
    failurePayload.failures = [{ sessionId: 'session-x', message: '读取会话 session-x 失败：权限不足' }];
    fetchMock.next.push(() => Promise.resolve(jsonResponse(failurePayload)));
    findByClass(lastTree, 'aij-refreshBtn').props.onClick();
    render();
    await sleep(30);
    render();

    check('failures 非空时显示读取失败提示', () => {
      const text = collectText(lastTree).join('\n');
      assert.ok(text.includes('有 1 个会话读取失败'), 'missing failures notice');
      assert.ok(text.includes('权限不足'), 'missing failure detail');
    });

    // -------------------------------------------------------------------
    // 10. 静态约束
    // -------------------------------------------------------------------
    console.log('\n[10] 静态约束检查');
    check('bundle 使用 window.__ModuleLoader__.load 且只 require react', () => {
      assert.ok(code.includes('window.__ModuleLoader__.load('));
      assert.ok(/factory:\s*\(require\)\s*=>/.test(code));
      const requires = code.match(/require\((['"])([^'"]+)\1\)/g) || [];
      assert.ok(requires.length >= 1, 'no require call found');
      const modules = requires.map((call) => call.slice(call.indexOf('(') + 1, call.length - 1).replace(/^['"]|['"]$/g, ''));
      assert.deepStrictEqual(modules, modules.map(() => 'react'), 'unexpected modules: ' + modules.join(', '));
    });

    check('导出 inject 声明包含 uiWorkspace / workspaces', () => {
      assert.ok(
        /exports\.inject\s*=\s*\[\s*'slots'\s*,\s*'uiWorkspace'\s*,\s*'workspaces'\s*\]/.test(code),
        'inject export must declare all three services'
      );
      assert.ok(code.includes('ctx.uiWorkspace.startSession('), 'must call uiWorkspace.startSession');
      assert.ok(code.includes('ctx.workspaces.list.getSnapshot()'), 'must read workspace snapshot');
    });

    check('未引用 @deepseek-ai 运行时包、未写 document.body / localStorage / 宿主私有 API', () => {
      assert.ok(!/require\(['"]@deepseek-ai/.test(code), 'forbidden @deepseek-ai require');
      assert.ok(!code.includes('document.body'), 'must not touch document.body');
      assert.ok(!code.includes('localStorage'), 'must not use localStorage');
      assert.ok(!/ctx\.layout|ctx\.remote|ctx\.session/.test(code), 'must not use host private APIs');
    });

    check('CSS 字号只用相对 em、字族不声明（继承 DSH 全局缩放）', () => {
      const sizes = code.match(/font-size\s*:\s*[^;}]+/g) || [];
      for (const size of sizes) {
        assert.ok(/\d*\.?\d+em\b/.test(size), 'font-size must stay relative (em): ' + size);
      }
      assert.ok(!/font-size\s*:\s*[\d.]+(?:px|pt|rem)/.test(code), 'must not use absolute font sizes');
      assert.ok(!/font-family\s*:/.test(code), 'must not declare font-family');
      assert.ok(code.includes('font:inherit'), 'controls should inherit the global font');
    });

    const cssBlock = code.slice(code.indexOf('const CSS_TEXT'), code.indexOf('].join'));
    check('CSS line-height 全部使用无单位相对值', () => {
      const values = [];
      const pattern = /line-height\s*:\s*([^;}]+)/g;
      let match;
      while ((match = pattern.exec(cssBlock)) !== null) values.push(match[1].trim());
      assert.ok(values.length > 0, 'no line-height found');
      for (const value of values) assert.ok(!/px/.test(value), 'line-height must be unitless: ' + value);
    });

    check('文本控件用 min-height + padding，不设置固定 height', () => {
      const selectors = [
        '.aij-refreshBtn',
        '.aij-segmentBtn',
        '.aij-navBtn',
        '.aij-todayBtn',
        '.aij-newSessionBtn',
        '.aij-retryBtn',
        '.aij-todoRow',
        '.aij-badge',
        '.aij-blockTitle',
        '.aij-title'
      ];
      for (const selector of selectors) {
        const rule = cssRule(cssBlock, selector);
        assert.ok(rule !== '', 'missing CSS rule: ' + selector);
        assert.ok(!/(^|;)height\s*:/.test(rule), selector + ' must not set a fixed height');
      }
      assert.ok(/min-height\s*:/.test(cssRule(cssBlock, '.aij-refreshBtn')), 'refresh button should use min-height');
      assert.ok(/padding\s*:/.test(cssRule(cssBlock, '.aij-refreshBtn')), 'refresh button should use padding');
    });

    check('CSS 上色只使用 --dsw-alias-* 变量', () => {
      const colorDecls = cssBlock.match(/(?:color|background|border-color|outline)\s*:\s*[^;'"]+/g) || [];
      const literalColors = colorDecls.filter(
        (decl) =>
          /#[0-9a-fA-F]{3,8}\b/.test(decl) ||
          /(?:^|[:(,\s])(?:rgb|rgba|hsl|hsla)\(/.test(decl) ||
          /\b(?:red|blue|green|black|white|gray|grey)\b/.test(decl)
      );
      assert.deepStrictEqual(literalColors, []);
      assert.ok(cssBlock.includes('var(--dsw-alias-'), 'should use theme tokens');
    });

    check('样式含满高 / 滚动 / 窄屏媒体查询', () => {
      assert.ok(code.includes('height:100%;min-height:0'), 'missing full-height layout');
      assert.ok(code.includes('overflow:auto'), 'missing scroll container');
      assert.ok(code.includes('@media (max-width:720px)'), 'missing narrow layout');
    });

    check('待办项渲染不截断、结果为空有明确提示', () => {
      assert.ok(!/\.slice\(0,\s*4\)/.test(code), 'todos must not be sliced to 4');
      assert.ok(code.includes('本周期没有标记完成的结果'), 'missing empty result copy');
      assert.ok(code.includes('新开对话'), 'missing new-session button label');
    });

    check('图表配色只用 alias token，不写死颜色', () => {
      const cssBlock = code.slice(code.indexOf('const CSS_TEXT'), code.indexOf('].join'));
      const paintDecls = cssBlock.match(/(?:fill|stroke)\s*:\s*[^;}]+/g) || [];
      assert.ok(paintDecls.length >= 4, 'expected svg paint declarations');
      for (const decl of paintDecls) {
        if (/^\s*(?:fill|stroke)\s*:\s*(?:none|transparent|currentColor|inherit)\s*$/.test(decl)) continue;
        assert.ok(decl.includes('var(--dsw-alias-'), 'chart paint must use an alias token: ' + decl);
      }
      const inlineStyles = code.match(/style:\s*\{[^}]*\}/g) || [];
      for (const style of inlineStyles) {
        assert.ok(!/\b(?:color|background|fill|stroke)\b/.test(style), 'inline style must not set colors: ' + style);
      }
    });

    check('图表容器不设固定高度', () => {
      const cssBlock = code.slice(code.indexOf('const CSS_TEXT'), code.indexOf('].join'));
      for (const selector of ['.aij-chartsSection', '.aij-charts', '.aij-chartCard', '.aij-chartSvg', '.aij-donutSvg', '.aij-distBar']) {
        const rule = cssRule(cssBlock, selector);
        assert.ok(rule !== '', 'missing CSS rule: ' + selector);
        assert.ok(!/(^|;)height\s*:/.test(rule), selector + ' must not set a fixed height');
      }
    });

    check('图形化总览无第三方图表依赖', () => {
      assert.ok(!/(?:d3|chart\.js|echarts|recharts|apexcharts|highcharts)/i.test(code), 'must not depend on chart libraries');
      assert.ok(!/^\s*import\s/m.test(code), 'must not use ES module imports');
    });

    check('交付物打开走 POST + action=open，不用 <a href> 导航', () => {
      assert.ok(code.includes('&action=open'), 'missing action=open');
      assert.ok(/method:\s*'POST'/.test(code), 'must POST to the present route');
      assert.ok(/credentials:\s*'same-origin'/.test(code), 'must send same-origin credentials');
      assert.ok(!/\bhref\s*[:=]/.test(code), 'must not use anchor href navigation');
    });

    check('待跟进区无固定高度、无字号/字族声明', () => {
      const cssBlock = code.slice(code.indexOf('const CSS_TEXT'), code.indexOf('].join'));
      for (const selector of ['.aij-followups', '.aij-followupList', '.aij-followupRow', '.aij-followupText']) {
        const rule = cssRule(cssBlock, selector);
        assert.ok(rule !== '', 'missing CSS rule: ' + selector);
        assert.ok(!/(^|;)height\s*:/.test(rule), selector + ' must not set a fixed height');
        assert.ok(!/font-size|font-family/.test(rule), selector + ' must not set font-size/font-family');
      }
    });

    check('忽略接口只用 POST，不得用 GET 改状态', () => {
      assert.ok(code.includes("fetch('/ai-journal/api/followups'"), 'missing followups write endpoint');
      assert.ok(/method:\s*'POST'/.test(code), 'dismiss/restore must POST');
      assert.ok(
        !/fetch\(\s*'\/ai-journal\/api\/followups'\s*\)/.test(code),
        'must not call the followups endpoint with a bare GET'
      );
    });

    check('待跟进区不依赖 bot 专属路径（对外发布兼容）', () => {
      assert.ok(!code.includes('/.dsh/bot'), 'must not read the bot workspace path');
      assert.ok(!/feishu|lark/i.test(code), 'must not depend on Feishu/Lark configuration');
      assert.ok(code.includes('listOf(readyData.followups)'), 'followups must be read defensively from the payload');
    });

    check('图表中文 aria-label 与 role=img', () => {
      assert.ok(code.includes("role: 'img'"), 'charts need role=img');
      assert.ok(code.includes('完成率 '), 'donut aria-label copy missing');
      assert.ok(code.includes('块分布：'), 'distribution aria-label copy missing');
      assert.ok(code.includes('本周每日轮次柱状图'), 'week chart aria-label copy missing');
    });

    // -------------------------------------------------------------------
    // report
    // -------------------------------------------------------------------
    console.log('\n==========================================');
    if (failures.length > 0) {
      console.log('FAILED: ' + failures.length + ' check(s)');
      for (const failure of failures) {
        console.log('\n--- ' + failure.name + ' ---');
        console.log(failure.error && failure.error.stack ? failure.error.stack : failure.error);
      }
      process.exitCode = 1;
    } else {
      console.log('ALL CHECKS PASSED');
      console.log('startSession calls: ' + startSessionCalls.length);
      console.log('fetch calls observed: ' + fetchMock.calls.length);
      console.log('style tag present after apply-dispose cycle: ' + documentMock.head.children.length);
    }
  } catch (error) {
    console.error('\nUNEXPECTED FAILURE');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}, 40);
