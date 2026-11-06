import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDismissedStore, dismissedStorePath } from '../lib/dismissed.js';

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-journal-dismissed-'));
  const file = path.join(dir, 'nested', 'followups-dismissed.json');
  return { dir, file, store: createDismissedStore(file) };
}

test('忽略记录：写入后新实例能读回，undo 后删除，文件只在 DSH home 下', () => {
  const { dir, file, store } = tempStore();
  assert.equal(store.count(), 0);
  assert.equal(store.has(KEY_A), false);

  const dismissed = store.dismiss({ key: KEY_A, sessionId: 's1', text: '飞书待回复轮询这个后续再聊', dismissedAt: 1 });
  assert.equal(dismissed.persisted, true);
  assert.equal(dismissed.count, 1);
  assert.equal(store.has(KEY_A), true);

  // 模块重新加载/进程重启后仍生效
  const reopened = createDismissedStore(file);
  assert.equal(reopened.has(KEY_A), true);
  assert.equal(reopened.count(), 1);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries[KEY_A].sessionId, 's1');
  assert.ok(Date.now() - raw.entries[KEY_A].dismissedAt < 5000);

  const restored = reopened.restore(KEY_A);
  assert.equal(restored.removed, true);
  assert.equal(reopened.has(KEY_A), false);
  assert.equal(createDismissedStore(file).count(), 0);

  // 默认路径始终落在 $DSH_HOME/ai-journal 下
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    assert.equal(dismissedStorePath(), path.join(dir, 'ai-journal', 'followups-dismissed.json'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('忽略记录：损坏文件按空表处理，不阻塞报告；重复忽略幂等', () => {
  const { dir, file, store } = tempStore();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.equal(store.count(), 0);
  const first = store.dismiss({ key: KEY_B, sessionId: 's2', text: '回头再说' });
  assert.equal(first.count, 1);
  const again = store.dismiss({ key: KEY_B, sessionId: 's2', text: '回头再说' });
  assert.equal(again.count, 1);
  assert.equal(createDismissedStore(file).has(KEY_B), true);
});

test('忽略记录：非法 key 不写入；写盘失败时保留内存结果并报告 persisted=false', () => {
  const { store, file } = tempStore();
  const rejected = store.dismiss({ key: '', text: 'x' });
  assert.equal(rejected.count, 0);

  // 把目录位置占成普通文件：写盘失败但内存仍生效
  const blocker = path.join(path.dirname(file), 'blocker');
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(blocker, 'x', 'utf8');
  const broken = createDismissedStore(path.join(blocker, 'x.json'));
  const result = broken.dismiss({ key: KEY_A, text: '写不进去' });
  assert.equal(result.persisted, false);
  assert.equal(broken.has(KEY_A), true);
});
