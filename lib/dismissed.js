/**
 * 「待跟进」忽略记录：把用户点过「这不是待办」的条目持久化到 DSH home。
 *
 * - 文件位置：`$DSH_HOME/ai-journal/followups-dismissed.json`（未设置时用 `~/.dsh`）；
 * - 只存 key / 会话 id / 截断文案 / 时间，不复制会话内容，也不读别的插件存储；
 * - 读失败/格式损坏时按空表处理，不影响报告生成；写失败时保留内存结果并返回 persisted:false。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 目录名与文件名。 */
const DIR_NAME = 'ai-journal';
const FILE_NAME = 'followups-dismissed.json';
/** 单文件最多保留的忽略条数，超出按时间淘汰最旧。 */
const MAX_ENTRIES = 5000;
/** 文案上限（与聚合层一致），只用于记录，不参与匹配。 */
const TEXT_MAX = 160;

/**
 * 解析 DSH home：优先 `$DSH_HOME`，否则 `~/.dsh`。
 * @returns {string} 绝对路径。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.dsh');
}

/** 忽略记录文件路径。 */
export function dismissedStorePath() {
  return path.join(dshHome(), DIR_NAME, FILE_NAME);
}

/** 归一化单条记录的形状；非法输入返回 null。 */
function normalizeEntry(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const key = typeof value.key === 'string' ? value.key.trim() : '';
  if (key === '') return null;
  return {
    key,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId.slice(0, 200) : '',
    text: typeof value.text === 'string' ? value.text.slice(0, TEXT_MAX) : '',
    dismissedAt: Number.isFinite(value.dismissedAt) ? value.dismissedAt : Date.now(),
  };
}

/**
 * 创建一个忽略记录存储实例（便于测试隔离；插件里用默认实例）。
 * @param {string} [filePath] - 自定义文件路径，默认按 DSH home 计算。
 */
export function createDismissedStore(filePath = dismissedStorePath()) {
  /** key → entry。 */
  let entries = new Map();
  /** 上次成功加载时的 mtime，用于发现外部修改。 */
  let loadedMtimeMs = -1;
  /** 文件缺失/损坏时也标记为已加载，避免每条请求都重读。 */
  let loaded = false;
  /** 内存里有未落盘的改动：写失败时保护它不被下一次读取覆盖。 */
  let dirty = false;

  function loadIfChanged() {
    if (dirty) return;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      entries = new Map();
      loaded = true;
      loadedMtimeMs = -1;
      return;
    }
    if (loaded && stat.mtimeMs === loadedMtimeMs) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const source = parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
        ? parsed.entries
        : {};
      const next = new Map();
      for (const [key, value] of Object.entries(source)) {
        const entry = normalizeEntry({ ...value, key });
        if (entry !== null) next.set(entry.key, entry);
      }
      entries = next;
    } catch {
      /* 损坏文件按空表处理，不阻塞报告 */
      entries = new Map();
    }
    loaded = true;
    loadedMtimeMs = stat.mtimeMs;
  }

  function persist() {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const all = [...entries.values()].sort((left, right) => right.dismissedAt - left.dismissedAt).slice(0, MAX_ENTRIES);
    entries = new Map(all.map((entry) => [entry.key, entry]));
    const body = JSON.stringify({ version: 1, updatedAt: Date.now(), entries: Object.fromEntries(entries) }, null, 2);
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, filePath);
    loadedMtimeMs = fs.statSync(filePath).mtimeMs;
  }

  return {
    /** 是否已忽略。 */
    has(key) {
      loadIfChanged();
      return entries.has(String(key ?? ''));
    },
    /** 忽略条数。 */
    count() {
      loadIfChanged();
      return entries.size;
    },
    /**
     * 记录一次忽略。
     * @param {{key: string, sessionId?: string, text?: string}} input
     * @returns {{persisted: boolean, count: number}} 写入失败时 persisted=false。
     */
    dismiss(input) {
      loadIfChanged();
      const entry = normalizeEntry({ ...input, dismissedAt: Date.now() });
      if (entry === null) return { persisted: false, count: entries.size };
      entries.set(entry.key, entry);
      try {
        persist();
        dirty = false;
        return { persisted: true, count: entries.size };
      } catch {
        dirty = true;
        return { persisted: false, count: entries.size };
      }
    },
    /**
     * 撤销一次忽略。
     * @param {string} key
     * @returns {{persisted: boolean, removed: boolean, count: number}}
     */
    restore(key) {
      loadIfChanged();
      const removed = entries.delete(String(key ?? ''));
      if (!removed) return { persisted: true, removed: false, count: entries.size };
      try {
        persist();
        dirty = false;
        return { persisted: true, removed: true, count: entries.size };
      } catch {
        dirty = true;
        return { persisted: false, removed: true, count: entries.size };
      }
    },
  };
}
