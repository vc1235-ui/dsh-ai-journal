/**
 * AI 日报 · Host 半区。
 *
 * 只做三件事：
 * 1. 通过 `ctx.sessionController` 列出会话、通过 `ctx.sessionQuery` 读取窗口内的会话日志；
 * 2. 用 `lib/journal.js` 把日志折叠成日报/周报 JSON（纯函数，可离线测试）；
 * 3. 在 `ctx.webServer` 上挂前缀路由：`GET /ai-journal/api` 供浏览器半区取数，
 *    `POST /ai-journal/api/followups` 记录「这不是待办」的忽略（落到 DSH home 的小 JSON）。
 *
 * 不写会话日志、不联网。接口契约见 API-CONTRACT.md。
 *
 * @module dsh-ai-journal
 */

import {
  buildReport,
  dayKey,
  dayStartMs,
  extractSessionFacts,
  normalizeTimeZone,
  weekStartKey,
} from './lib/journal.js';
import { createDismissedStore } from './lib/dismissed.js';

/** Loader 行 id。 */
export const name = 'ai-journal';

/** 无必需服务：缺少 webServer 时 Host 半区静默不挂路由，Client 仍可加载。 */
export const inject = [];

/** 单次报告最多读取的会话数。 */
const MAX_SESSIONS = 120;

/** 读取会话日志的并发上限。 */
const READ_CONCURRENCY = 4;

/** 会话事实缓存容量（按会话数计）。 */
const FACTS_CACHE_LIMIT = 400;

/** 报告缓存有效期（毫秒）。 */
const REPORT_TTL_MS = 15_000;

/** POST 请求体上限（字节）。 */
const BODY_LIMIT = 8 * 1024;

/** 合法的待跟进 key：sha1 十六进制。 */
const FOLLOWUP_KEY_RE = /^[0-9a-f]{40}$/;

/**
 * 读取 JSON 请求体。
 * @param {import('node:http').IncomingMessage} request
 * @param {number} limit - 字节上限。
 * @returns {Promise<any>} 解析后的 JSON。
 */
async function readJsonBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 路由前缀。 */
const ROUTE = '/ai-journal/api';

/** 判断请求是否来自本机同源页面（与 DSH 自带管理页同一套信任 fence）。 */
function isTrustedRequest(request) {
  const host = request.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  const hostname = host.replace(/^\[/, '').replace(/\]/, '').replace(/:\d+$/, '').toLowerCase();
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (!loopback) return false;
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers?.origin;
  if (typeof origin === 'string' && origin !== '') {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return true;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** 固定并发地处理一组任务，保持结果顺序。 */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 以「最近活动时间」做小容量淘汰的 Map。 */
function putCapped(map, key, value, limit) {
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 */
export function apply(ctx) {
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[ai-journal] ${message}`);
    } catch {
      /* 日志失败不影响业务 */
    }
  };

  /** 数据服务（sessionController + sessionQuery）所在的作用域上下文。 */
  let dataScope = null;
  /** 报告缓存：key → { builtAt, report }。 */
  const reportCache = new Map();
  /** 会话事实缓存：sessionId → { updatedAt, facts }。 */
  const factsCache = new Map();
  /** 「待跟进」忽略记录（DSH home 下的独立 JSON，不碰其它插件数据）。 */
  const dismissed = createDismissedStore();

  /**
   * 过滤掉已被标记「这不是待办」的待跟进条目，并同步 stats.followups。
   * 只读副本，不修改缓存里的报告对象。
   * @param {object} report - buildReport 的结果。
   * @returns {object} 过滤后的报告。
   */
  function withDismissed(report) {
    const list = Array.isArray(report?.followups) ? report.followups : null;
    if (list === null || list.length === 0) return report;
    const kept = list.filter((item) => !dismissed.has(item?.key));
    if (kept.length === list.length) return report;
    return { ...report, followups: kept, stats: { ...report.stats, followups: kept.length } };
  }

  ctx.effect(() => () => {
    dataScope = null;
    reportCache.clear();
    factsCache.clear();
  }, 'ai-journal: caches');

  ctx.inject(['sessionController', 'sessionQuery'], (scope) => {
    dataScope = scope;
    log('info', 'session services ready');
    return () => {
      if (dataScope === scope) dataScope = null;
    };
  });

  /**
   * 读取一个会话并提取事实；命中缓存且 updatedAt 未变时直接复用。
   * @param {object} summary - SessionSummary。
   * @param {boolean} [force] - true 时跳过缓存读取（refresh=1）。
   * @returns {Promise<object>} 会话事实。
   */
  async function factsFor(summary, force = false) {
    const cached = factsCache.get(summary.sessionId);
    if (!force && cached !== undefined && cached.updatedAt === summary.updatedAt) return cached.facts;
    let facts;
    try {
      const snapshot = await dataScope.sessionQuery.readSession(summary.sessionId);
      facts = extractSessionFacts({
        sessionId: summary.sessionId,
        cwd: snapshot.session?.cwd ?? summary.cwd,
        events: snapshot.events,
      });
    } catch (error) {
      facts = extractSessionFacts({
        sessionId: summary.sessionId,
        cwd: summary.cwd,
        events: [],
        error: error instanceof Error ? error.message : String(error),
      });
      log('warn', `read session ${summary.sessionId} failed: ${facts.error}`);
    }
    putCapped(factsCache, summary.sessionId, { updatedAt: summary.updatedAt, facts }, FACTS_CACHE_LIMIT);
    return facts;
  }

  /**
   * 生成一份报告（带短期缓存）。
   * @param {object} query - 归一化后的查询。
   * @returns {Promise<object>} 报告 JSON。
   */
  async function reportFor(query) {
    const cacheKey = `${query.kind}|${query.dateKey}|${query.tz}`;
    const cached = reportCache.get(cacheKey);
    if (!query.refresh && cached !== undefined && Date.now() - cached.builtAt < REPORT_TTL_MS) {
      return cached.report;
    }

    const startKey = query.kind === 'weekly' ? weekStartKey(query.dateKey) : query.dateKey;
    const windowStartMs = dayStartMs(startKey, query.tz);
    const listed = await dataScope.sessionController.list({}, undefined);
    const allSummaries = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : [];
    const candidates = allSummaries
      .filter((summary) => summary && summary.blank !== true && summary.origin !== 'subagent')
      .filter((summary) => typeof summary.updatedAt === 'number' && summary.updatedAt >= windowStartMs)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_SESSIONS);

    const facts = await mapPool(candidates, READ_CONCURRENCY, (summary) => factsFor(summary, query.refresh === true));
    const report = buildReport({ kind: query.kind, dateKey: startKey, tz: query.tz, facts, now: Date.now() });
    reportCache.set(cacheKey, { builtAt: Date.now(), report });
    while (reportCache.size > 24) {
      const oldest = reportCache.keys().next().value;
      reportCache.delete(oldest);
    }
    return report;
  }

  ctx.inject(['webServer'], (webScope) => {
    webScope.effect(() => webScope.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (request, response) => {
        if (!isTrustedRequest(request)) {
          sendJson(response, 403, { ok: false, code: 'forbidden', message: '仅允许本机同源页面访问。' });
          return;
        }
        let url;
        try {
          url = new URL(request.url ?? '/', 'http://localhost');
        } catch {
          sendJson(response, 400, { ok: false, code: 'bad-request', message: '请求地址不合法。' });
          return;
        }

        if (request.method === 'POST') {
          if (!url.pathname.endsWith('/followups')) {
            response.writeHead(405, { allow: 'GET, HEAD' });
            response.end();
            return;
          }
          const contentType = String(request.headers['content-type'] ?? '');
          if (!contentType.toLowerCase().includes('application/json')) {
            sendJson(response, 415, { ok: false, code: 'unsupported-media-type', message: '只接受 application/json。' });
            return;
          }
          let body;
          try {
            body = await readJsonBody(request, BODY_LIMIT);
          } catch (error) {
            const tooLarge = error instanceof Error && error.message === 'body-too-large';
            sendJson(response, tooLarge ? 413 : 400, {
              ok: false,
              code: tooLarge ? 'payload-too-large' : 'bad-request',
              message: tooLarge ? '请求体过大。' : '请求体不是合法 JSON。',
            });
            return;
          }
          const action = body && typeof body.action === 'string' ? body.action : '';
          const key = body && typeof body.key === 'string' ? body.key.trim() : '';
          if ((action !== 'dismiss' && action !== 'restore') || !FOLLOWUP_KEY_RE.test(key)) {
            sendJson(response, 400, { ok: false, code: 'bad-request', message: 'action 或 key 不合法。' });
            return;
          }
          const result = action === 'dismiss'
            ? dismissed.dismiss({ key, sessionId: body.sessionId, text: body.text })
            : dismissed.restore(key);
          reportCache.clear();
          sendJson(response, 200, {
            ok: true,
            action,
            dismissed: dismissed.count(),
            persisted: result.persisted !== false,
            removed: result.removed === true,
          });
          return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { allow: 'GET, HEAD' });
          response.end();
          return;
        }
        const tz = normalizeTimeZone(url.searchParams.get('tz'));
        const kindParam = url.searchParams.get('kind');
        const kind = kindParam === 'meta' ? 'meta' : kindParam === 'weekly' ? 'weekly' : 'daily';
        const dateParam = url.searchParams.get('date');
        const dateKeyValue = typeof dateParam === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
          ? dateParam
          : dayKey(Date.now(), tz);

        if (kind === 'meta') {
          sendJson(response, 200, {
            ok: true,
            plugin: 'dsh-ai-journal',
            kind: 'meta',
            tz,
            today: dayKey(Date.now(), tz),
            services: {
              sessionController: dataScope?.sessionController !== undefined,
              sessionQuery: dataScope?.sessionQuery !== undefined,
              webServer: true,
            },
            now: Date.now(),
          });
          return;
        }

        if (dataScope === null) {
          sendJson(response, 503, {
            ok: false,
            code: 'unavailable',
            message: '当前组成缺少 sessionController 或 sessionQuery，AI 日报暂不可用。',
          });
          return;
        }

        try {
          const report = await reportFor({
            kind,
            dateKey: dateKeyValue,
            tz,
            refresh: url.searchParams.get('refresh') === '1',
          });
          sendJson(response, 200, withDismissed(report));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log('warn', `build report failed: ${message}`);
          sendJson(response, 500, {
            ok: false,
            code: 'internal',
            message: `生成日报失败：${message}`,
          });
        }
      },
    }), 'ai-journal: api route');
    log('info', `api mounted at ${ROUTE}`);
  });
}
