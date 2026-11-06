### 插件地址 / Plugin link

`dsh-ai-journal`（npm 包名）· https://github.com/vc1235-ui/dsh-ai-journal

### 简短说明 / Summary

从本机 DSH 会话日志生成每日 / 每周 AI 日报：按「目标 → 行动 → 结果 → 待办」分块，含交付物链接、未完成待办一键新开对话、启发式「待跟进」与「这不是待办」忽略。DSH 左侧栏「AI 日报」入口 + 图形化面板；纯本地、不联网、无第三方插件依赖，MIT。

### 插件实际效果 / Plugin screenshots

（可选；计划补充：概览 KPI 与图表、目标分块、待跟进区截图）

### 补充信息 / Additional details

- 已验证 DSH `0.2.1-rc.5` / Web profile；
- 许可证 MIT；仓库公开，含 `dsh.bundle` → `cordis.patch.yml`，可 `dsh plugin add`；
- 无其它插件依赖；数据只读本机会话，唯一落盘是忽略列表（`$DSH_HOME/ai-journal/followups-dismissed.json`）。
