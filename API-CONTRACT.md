# API 契约：dsh-ai-journal（v3，2026-11-05）

Host 半区 → Client 半区的唯一契约。只在本机同源可用；会话内容只在内存中聚合，不落盘（唯一的写接口是「这不是待办」的忽略记录，只存 key/会话 id/截断文案/时间）。

## 路由

```text
GET /ai-journal/api?kind=daily|weekly|meta&date=YYYY-MM-DD&tz=<IANA 时区>&refresh=1
```

- `kind` 缺省 / 非法 → `daily`；`meta` 返回诊断信息，不读会话。
- `date` 缺省 → 请求时区的今天；格式非法 → 同样回落到今天。周报的 `date` 可以是该周任意一天，Host 归一到周一。
- `tz` 缺省 / 非法 → `Asia/Singapore`。
- `refresh=1` 跳过 15 秒报告缓存。
- 仅接受回环地址（`127.0.0.1` / `localhost` / `::1`）且非跨站请求；只接受 `GET` / `HEAD`。

失败响应：

```json
{ "ok": false, "code": "bad-request|forbidden|unavailable|internal", "message": "中文说明" }
```

`403 forbidden`、`405`（非 GET/HEAD）、`503 unavailable`（组成缺少 `sessionController` 或 `sessionQuery`）、`500 internal`。

## 成功响应（daily / weekly 同构）

```jsonc
{
  "ok": true,
  "kind": "daily",
  "tz": "Asia/Singapore",
  "range": { "startMs": 1793808000000, "endMs": 1793894400000, "label": "2026-11-05", "days": ["2026-11-05"] },
  "generatedAt": 1793873814694,
  "empty": false,
  "summary": "今天 5 个会话、11 轮，围绕 3 个项目展开；完成 1 项待办，还有 6 项未完成。",
  "stats": {
    "sessions": 5, "turns": 11, "humanMessages": 11, "toolCalls": 491,
    "projects": 3, "blocks": 3,
    "todosCompleted": 1, "todosInProgress": 1, "todosPending": 5, "deliverables": 2, "followups": 1,
    "goalsActive": 0, "goalsCompleted": 0
  },
  "blocks": [ /* Block[]：一个目标（无目标时一个项目）一个大块 */ ],
  "todos": [ /* TodoItem[]：跨块汇总的全部未完成事项（含目标） */ ],
  "followups": [ /* FollowupItem[]：会话里提到、但没写进待办清单的「以后再说」类事项（启发式） */ ],
  "days": [ /* DayStat[]：日报 1 项，周报 7 项 */ ],
  "failures": [ { "sessionId": "s-x", "message": "读取失败原因" } ]
}
```

### Block

```jsonc
{
  "kind": "goal",              // "goal" | "project"
  "key": "goal:做一个带左侧栏入口的 DSH 插件",
  "label": "目标",              // "目标" | "项目"，与 kind 对应
  "title": "做一个带左侧栏入口的 DSH 插件",  // 目标 objective 或项目名
  "phase": "active",          // 仅 goal：active|completed|blocked|paused；project 为 null
  "summary": "目标「…」（进行中），2 个会话 5 轮：…；完成 1 项，还有 3 项待办。",
  "actions": [ { "text": "实现 Host 半区与日报聚合", "time": 1793870000000, "sessionId": "s-1" } ],
  "results": [
    { "kind": "deliverable", "text": "11 月 5 日日报", "path": "docs/日报-2026-11-05.md",
      "openUrl": "/api/present.open?sessionId=s-1&seq=42&index=0", "time": 1793870000000, "sessionId": "s-1" },
    { "kind": "todo", "text": "完成离线单测", "time": 1793870000000, "sessionId": "s-1" }
  ],
  "todos": [ /* TodoItem[]：该块全部未完成事项，目标排最前 */ ],
  "sessionIds": ["s-1", "s-2"],
  "projects": ["个人AI"],
  "firstTime": 1793860000000,
  "lastTime": 1793873000000,
  "stats": { "sessions": 2, "turns": 5, "humanMessages": 4, "toolCalls": 120, "todosCompleted": 1, "todosOpen": 3, "deliverables": 1 }
}
```

语义：

- **行动 actions**：块内会话标题（即「这件事是什么」的现成概括）去重后最多 6 条，不是逐条消息。标题缺失时用首条人类输入。
- **结果 results**：按「已完成目标 → 交付物 → 已完成待办」排序，最多 8 条，同一路径的交付物只出现一次。
  - `kind: "goal"`：目标已完成；
  - `kind: "deliverable"`：会话日志里 `deliverables/presented` 事件声明的交付文件（`text` 取描述或文件名，`path` 为原始路径，`openUrl` 是 DSH 的 `present.open` 路由坐标）；
  - `kind: "todo"`：已完成待办。
  没有任何可核实结果时为空数组，客户端显示「本周期没有标记完成的结果」，不编造产出。
- **待办 todos**：块内所有 `pending` / `in_progress` 条目，**全量返回，不截断**；进行中/受阻的目标本身也作为一条（`kind: "goal"`）排在前面。
- 块顺序：目标块在前，同类按最近活动时间倒序。

### TodoItem

```jsonc
{
  "kind": "todo",                 // "todo" | "goal"
  "content": "实现 Client 半区面板",
  "status": "in_progress",        // todo: pending|in_progress；goal: active|blocked
  "project": "个人AI",
  "cwd": "/Users/sunxx/Documents/个人AI",
  "sessionId": "s-1",
  "sessionTitle": "DSH插件：AI日报周报总结",
  "goal": "做一个带左侧栏入口的 DSH 插件",  // 可为 null
  "suggestedPrompt": "继续完成待办：实现 Client 半区面板。所属目标：…。先确认当前进展和相关文件，再给出简短计划并开始执行；完成后更新待办。"
}
```

### FollowupItem

```jsonc
{
  "kind": "followup",
  "key": "9f2c…40位sha1",                      // 稳定标识 = sha1(sessionId + "\0" + 归一化 text)
  "text": "飞书待回复轮询这个后续再聊",          // 命中的原句（截断到 110 字）
  "time": 1793936762288,
  "sessionId": "session-2622eb80-…",
  "sessionTitle": "Hermes 迁移",
  "project": "workspace",
  "cwd": "/Users/sunxx/.dsh/bot/workspace",
  "suggestedPrompt": "继续跟进之前提到的事项：飞书待回复轮询这个后续再聊。所属项目：workspace。来自会话「Hermes 迁移」。先确认当前状态和相关文件，再给出简短计划并开始执行；如果这件事已经不需要处理，请明确说明原因。"
}
```

语义与口径（**启发式，非模型判断**）：

- 只扫**窗口内的人类输入**（`user/message` 且 `source.kind === 'user'`），不读 AI 回复、不读工具结果；
- 命中措辞：`待回复` / `待确认` / `待跟进` / `未回复` / `别忘了` / `再聊` / `回头再` / `下次再` / `之后再` / `后续再` 等，或「后续 + 12 字内的动作」；
- 每个会话最多 4 条，整份报告最多 12 条，按时间倒序，同句去重；
- 与 `todos[]`（结构化待办）**分开统计**，不计入 `stats.todos*`；客户端必须标注这是「会话里提到、未写入待办」的低置信信息，不能当作已确认待办；
- `key` 由 Host 生成并在响应前过滤掉用户已忽略的条目（`stats.followups` 同步为过滤后的数量）。

### 忽略接口 `POST /ai-journal/api/followups`

供「这不是待办」使用，是本插件唯一的写接口：

- 请求：`Content-Type: application/json`，body `{ "action": "dismiss" | "restore", "key": "<40位sha1>", "sessionId": "…", "text": "…" }`；`key` 必须来自报告的 `followups[].key`；
- 成功：`200 { ok: true, action, dismissed: <当前忽略总数>, persisted: <是否已落盘>, removed: <restore 是否真的删到> }`；
- 失败：`400`（action/key 不合法）、`413`（body > 8KB）、`415`（非 JSON）、`403`（非同源）、`405`（其它方法/路径）；
- 存储：`$DSH_HOME/ai-journal/followups-dismissed.json`（未设置 `$DSH_HOME` 时 `~/.dsh`），只存 `key/sessionId/截断text/dismissedAt`，最多 5000 条；文件损坏按空表处理；写盘失败时内存仍生效但 `persisted:false`；
- 忽略后报告里该条消失；撤销后重新出现（客户端需重新拉取报告）。

### DayStat

```jsonc
{ "date": "2026-11-05", "label": "11月5日 周三", "sessions": 3, "turns": 9, "activityCount": 3, "unfinishedCount": 4 }
```

## Client 半区要求

1. 槽位：`sidebar.panellist`（`id: "ai-journal"`、`order: 20`、`label: () => "AI 日报"`）+ `main`（`key: "ai-journal"`）。
2. 数据：`fetch('/ai-journal/api?kind=…&date=…&tz=' + Intl.DateTimeFormat().resolvedOptions().timeZone, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal })`，带请求序号丢弃迟到响应。
3. 状态：loading（骨架）/ error（中文原因 + 重试）/ empty / ready；同窗口刷新保留旧内容并提示「正在刷新当前视图…」。
4. 渲染结构：顶部（标题、说明、刷新）+ 日报/周报分段控件 + `‹ 范围 ›` + 今天/本周；内容区：
   - `summary` 一句话总览 + 范围/时区/更新时间；
   - **每个 Block 一个大块**，标题行：`label` 徽章（目标/项目）+ `title` + 阶段徽章（goal）+ 会话数/轮次；
   - 块内 `summary` 一句话；
   - 四段：**行动**（`actions`，有序列表）、**结果**（`results`，无内容时给提示）、**待办**（`todos`，全量）。
   - 周报底部「每日分布」表（`days`，7 行：日期 / 会话 / 轮次 + 比例条 / 未完成）。
5. **未完成待办行的「新开对话」链接**：每条 todo/goal 右侧一个按钮，点击调用 `ctx.uiWorkspace.startSession(workspaceId?, { prompt: todo.suggestedPrompt })`，把 `suggestedPrompt` 预填进新会话输入框；`workspaceId` 用 `ctx.workspaces.list.getSnapshot().items` 里 `path === todo.cwd` 的项，匹配不到就不传（用最近工作区）。目标条目同样可点。
6. **交付物链接**：结果里 `kind === "deliverable"` 的条目渲染成可点击文件行（描述/文件名 + 路径，路径可复制），点击时对它自己的 `openUrl` 追加 `action=open` 并 `POST`（`credentials: 'same-origin'`）。状态映射：204 → 短暂提示「已在宿主打开」；409 → 「宿主桌面不可用」；404 → 「文件已不存在」；其它/网络失败 → 「打开失败」。链接不得携带会话内容，也不得改成 GET 触发打开。
7. **图形化摘要与总览（位于 blocks 之上）**：用纯内联 SVG/div 画图，不引入第三方图表库，数字全部来自 `stats` / `blocks` / `days`。概览卡**不显示任何文字总结/文字统计行**（`summary` 与 KPI 数字重复，故不渲染），只保留范围/时区/更新于 + 一排 **KPI 大数字**：
   - **KPI 行**：会话 / 轮次 / 我的输入 / 工具调用 / 交付物 / 完成待办 六项，每项只有「数字（相对字号）+ 标签」，不带进度条。
   - **完成率环**：donut 弧长 = `todosCompleted / (todosCompleted + todosInProgress + todosPending)`（分母为 0 时显示 0%），中心显示百分比，下方图例「完成 X · 进行中 Y · 待办 Z」；弧用 `--dsw-alias-state-success-primary`，轨道用 `--dsw-alias-bg-mask-2`。
   - **块分布条**：横向堆叠条，按 `blocks[].stats.sessions` 占比分段的宽度，最多 4 段 + 其余归「其它」，图例列出块名；段色只用 `--dsw-alias-state-business-primary` / `--dsw-alias-state-success-primary` / `--dsw-alias-state-warn-primary` / `--dsw-alias-label-dimmed`。
   - **周报 7 天柱状图**：以 `days[].turns` 为柱高画 7 根竖柱（0 值保留空位），x 轴写 `MM-DD`，轴文字要用小号 SVG 字号（`fontSize` ≈ 9，随图缩放不会变成大字）；每根柱 hover 时在柱顶显示「N 轮」（纯 CSS `:hover` 显隐），槽位 `title` / `aria-label` 写「11月5日 周三 · 3 会话 · 9 轮」；日报不画这张图。
   - **布局**：图表卡片在宽屏固定 `repeat(3, minmax(0,1fr))` 等分整行宽度，窄屏降为 2 列 / 1 列；图表容器不设固定高度；`aria-label` 用中文描述。
8. **字体**：不声明 `font-family`；字号只用**相对 em**（目前仅 KPI 大数字 `1.5em`），其余完全继承 DSH 全局，禁止 px/rem/pt 绝对字号；SVG 图内文字用 `fontSize` 用户单位（随 `viewBox` 缩放）。层级主要用字重、颜色、间距表达；避免固定高度，改用 `min-height` + padding，保证放大字号时不裁切。`line-height` 用无单位相对值。
9. 文案固定中文（本期不接 `ctx.locale`）；错误映射：`unavailable` → 「缺少会话查询能力」、`bad-request`、`internal`、网络失败。
10. **待跟进区（可选数据）**：`followups[]` 非空时，在图表区与 blocks 之间渲染「待跟进 · 会话里提到、未写入待办」，每条：`待跟进` 徽章 + 文案 + 「来源：会话标题 · 项目 · 日期」+「新开对话」按钮（预填 `suggestedPrompt`，workspaceId 解析同待办）+「这不是待办」按钮；空数组时整块不渲染。文案必须说明这是启发式识别，不能与结构化待办混淆。
    - 「这不是待办」→ `POST /ai-journal/api/followups`（见上）`{action:'dismiss', key, sessionId, text}`，成功后该条立即从界面移除，并在原位/区块底部给「已忽略，撤销」入口（`action:'restore'` 同一 key，成功后重新拉取报告 `refresh=1`）；
    - 请求失败时保留条目并提示「操作失败，请重试」，不得假装成功；只允许 POST 该接口，不得用 GET 改状态。
11. **兼容性要求（插件要对外发布）**：所有数据只来自 `sessionController` / `sessionQuery`，**不得**读取 `~/.dsh/bot`、飞书配置或任何 bot 专属路径；没有安装 bot 的环境下，`followups` 里只会出现普通 Web 会话里的人类输入（或为空），功能自然降级，不能报错、不能出现空区块。
12. 组件禁用 `document.body`、`localStorage`、其它插件 DOM；样式用 `ctx.effect` 注入并清理，只用 `--dsw-alias-*` 变量上色。

## 兼容性（对外发布）

- 插件只依赖宿主已有的 `sessionController`、`sessionQuery`、`webServer` 与客户端 `slots` / `uiWorkspace` / `workspaces` 服务；缺少时按现有约定返回 503 或前端提示，不追加依赖。
- 飞书 Bot 的会话在本机是**普通 DSH 会话**（cwd 形如 `~/.dsh/bot/workspace`），因此无需任何 bot 专属代码即可被统计；没有 bot 的机器上该会话不存在，报告照常工作。
- 未知/新增的事件类型一律忽略；`deliverables/presented`、`todo/write`、`goal/change` 之外不假设任何结构。
- 「待跟进」是启发式：对方环境里没有同类措辞时自然为空，不要求任何插件/服务端配合。
- **版本声明**：本契约按 DSH `0.2.1-rc.5`（Web profile）实现与验证；`/api/present.open` 由 `@deepseek-ai/dsh-client-ui-deliverables`（属 `@deepseek-ai/dsh-web-app`）注册，路由不存在时交付物按钮点击失败但有文案兜底，报告其余部分不受影响。对外发布时以此版本为最低支持基线，升级 DSH 后需复核事件形状与本路由。
