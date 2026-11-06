# 发布与收录指南 / Publishing & listing

本仓库同时准备两个社区索引市场的收录。当前状态：GitHub 公开仓库 ✅，许可证 ✅，`dsh.bundle` 清单 ✅；**npm 发布 ⏳**（需要作者本人 `npm login`），npm 发布后即可提交两个市场。

## 0. 前置检查（已完成）

| 项 | 状态 |
| --- | --- |
| GitHub 公开仓库 | ✅ https://github.com/vc1235-ui/dsh-ai-journal |
| 仓库 topic `dsh-plugin` | ✅（社区市场 CI 会检查） |
| `package.json` 声明 `dsh.bundle`（`cordis.patch.yml`） | ✅ |
| 许可证 | ✅ MIT |
| 图标（180×180 PNG） | ✅ `assets/icon-180.png` |
| 离线测试 | ✅ 105 项（聚合 22 + 忽略存储 3 + 面板 80） |
| npm 发布 | ⏳ `npm publish` 后完成 |

## 1. npm 发布（两个市场都依赖）

包名 `dsh-ai-journal` 已确认在 npm registry 上可用（当前 404）。

```sh
cd dsh-ai-journal
npm login          # 作者本人登录（需要 npm 账号；CI/脚本无法代替）
npm publish --access public
npm view dsh-ai-journal version   # 应输出 0.1.0
```

发布后，DSH 用户可直接 `dsh plugin --profile web add dsh-ai-journal`。

## 2. DSH 社区插件市场（awesome-dsh-plugin / aaamechanic 镜像）

- 市场索引：https://aaamechanic.github.io/dsh-plugin-market/index.json
- 数据源：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin（`data/plugins/*.yml` 生成 README 与索引）
- 投稿方式：向该仓库提 **1 个文件** 的 PR，文件名 `data/plugins/vc1235-ui__dsh-ai-journal.yml`：

```yaml
url: https://github.com/vc1235-ui/dsh-ai-journal
name: vc1235-ui/dsh-ai-journal
category: ui
description:
  en: Daily and weekly AI journals generated from your local DSH session logs, grouped by goal with deliverables and unfinished todos.
  zh: 按天/按周汇总本机 DSH 会话：按目标分块的行动/结果/交付物与未完成待办，左侧栏图形化面板。
icon: https://raw.githubusercontent.com/vc1235-ui/dsh-ai-journal/main/assets/icon-180.png
```

硬性要求与注意事项：

- **仓库创建满 1 天**才会通过 CI（本仓库创建于 2026-11-06，建议 2026-11-07 之后提交 PR）；
- 仓库必须声明 `dsh.bundle` 清单（已满足，否则会被拒）；
- 描述以句号结尾；含 `: ` 时需要加引号（上面 `en` 行没有 `: `，安全）；
- 同类条目较多时维护者会要求拆分，本仓库是单插件，一次一条即可；
- 合并后 README/索引自动重建，`https://aaamechanic.github.io/dsh-plugin-market/index.json` 会收录（该站是 awesome 列表按 DSH 版本过滤的镜像，npm 有版本会优先展示版本号）。

PR 命令（仓库 fork 后）：

```sh
# 在 awesome-dsh-plugin fork 里
git checkout -b add-dsh-ai-journal
# 新建 data/plugins/vc1235-ui__dsh-ai-journal.yml，内容如上
git add data/plugins/vc1235-ui__dsh-ai-journal.yml
git commit -m "Add vc1235-ui/dsh-ai-journal"
git push -u origin add-dsh-ai-journal
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --title "Add vc1235-ui/dsh-ai-journal" --body "Daily/weekly AI journal panel for DSH Web; public repo + npm release + MIT license."
```

## 3. 开放插件市场（dshopen.org）

- 索引：https://dshopen.org/index.json
- 仓库：https://github.com/polang233/dsh-plugin-index
- 入口：填写「插件收录」issue 表单 https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml
- 要求：公开源码 + **可安装的 npm 版本** + 明确许可证（均可满足，npm 发布后即可）

Issue 建议填写：

- **插件地址**：`dsh-ai-journal`（npm 包名；或 `https://github.com/vc1235-ui/dsh-ai-journal`）
- **简短说明**：
  > 从本机 DSH 会话日志生成每日/每周 AI 日报：按「目标 → 行动 → 结果 → 待办」分块，含交付物链接、未完成待办一键新开对话、启发式待跟进与「这不是待办」忽略。左侧栏「AI 日报」入口，纯本地、不联网、无第三方插件依赖。
- **插件实际效果**：可选，建议后续补 1–3 张面板截图（概览 KPI、目标分块、待跟进区）。
- **补充信息**：已验证 DSH `0.2.1-rc.5` / Web profile；MIT；无其它插件依赖。

命令：

```sh
gh issue create --repo polang233/dsh-plugin-index \
  --title "[plugin-add] dsh-ai-journal" \
  --body-file marketplace-dshopen.md
```

收录后在 README 放徽章（把包名编码进 URL）：

```md
[![开放插件市场](https://img.shields.io/endpoint?url=https%3A%2F%2Fdshopen.org%2Fbadge%2Fdsh-ai-journal.json)](https://dshopen.org/zh/plugins/dsh-ai-journal/)
```

## 4. 发布顺序建议

1. `npm publish`（作者执行一次，之后两个市场都能读到版本）；
2. 立即提交 dshopen.org 的收录 issue（不依赖仓库年龄）；
3. 仓库满 24 小时后提交 awesome-dsh-plugin PR（之后镜像站自动收录）；
4. 收录后在 README 补两个市场徽章（dshopen 徽章见上；社区市场徽章可用 https://awesome-dsh-plugin.com/badge.svg）。
