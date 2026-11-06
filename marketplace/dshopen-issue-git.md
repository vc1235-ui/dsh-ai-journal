### 插件地址 / Plugin link

https://github.com/vc1235-ui/dsh-ai-journal （仓库根即插件包根目录，无子目录）

### 简短说明 / Summary

从本机 DSH 会话日志生成每日 / 每周 AI 日报：按「目标 → 行动 → 结果 → 待办」分块，含交付物链接、未完成待办一键新开对话、启发式「待跟进」与「这不是待办」忽略。DSH 左侧栏「AI 日报」入口 + 图形化面板；纯本地、不联网、无第三方插件依赖，MIT。

### 补充信息 / Additional details

- 尚未发布 npm（作者暂无 npm 账号），按「固定 Git 提交」方式申请收录：
  - 版本：`0.1.0`
  - 完整提交 SHA：`85e3371f791605a9576bc49455539ca1fa01fd7f`
  - 该目录可直接安装：含 `package.json`、`cordis.patch.yml`（`dsh.bundle.patch`）与全部运行文件，无构建步骤；
- 预构建 tarball（同一提交，`npm pack` 产物）：https://github.com/vc1235-ui/dsh-ai-journal/releases/download/v0.1.0/dsh-ai-journal-0.1.0.tgz
- 已验证 DSH `0.2.1-rc.5` / Web profile；`engines.dsh: >=0.2.1-rc.5`；许可证 MIT；仓库公开；
- 无其它插件依赖；数据只读本机会话，唯一落盘是忽略列表（`$DSH_HOME/ai-journal/followups-dismissed.json`）；
- 后续若发布 npm，会在原 issue 回复新版本。
