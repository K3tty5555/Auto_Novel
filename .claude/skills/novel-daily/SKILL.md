---
name: novel-daily
description: |
  日常写作+发布一键流程。自动写N章（每章经过 Critic + Reader 双重评分）再批量定时发布。
  解决"写完要手动分别调多次命令"的断点问题。
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - AskUserQuestion
  - Skill
metadata:
  trigger: 今日写作、日更、daily、写今天的章节、写四章
---

# novel-daily：日常写作+发布一键流程

用法示例：
```
/novel-daily              ← 写4章（默认），16:00 定时发布
/novel-daily 2            ← 写2章
/novel-daily 4 --time 20:00   ← 写4章，20:00 发布
/novel-daily 4 --write-only   ← 只写不发布（今天写，明天发）
/novel-daily 4 --publish-only ← 只发布今天已写好的章节
```

---

## Phase 0：确认参数

检查 `novels/` 下的子目录（多部则询问）。

确认参数：
- **章数**：用户指定，默认 4
- **发布时间**：`--time`，默认 `16:00`
- **模式**：完整 / 只写 / 只发布

查看 `chapters/` 确认**起始章节号**（已有 ch050 则从 ch051 开始）。

---

## Phase 1：逐章写作

对每章按顺序执行（**必须串行，不能并行**——每章依赖上章结尾）：

```
for i in 1..N:
  调用 novel-write skill，写第 (起始+i-1) 章
  novel-write 内部完成：ContextLoader → Planner → Writer → Critic → Reader → 保存
  章节保存后，继续下一章
```

**进度汇报**（每章完成后实时输出）：
```
[1/4] ✓ ch051_[标题] 已写完（Critic: X.X | Reader: X/10）
[2/4] ✓ ch052_[标题] 已写完（Critic: X.X | Reader: X/10）
[3/4] 写作中...
```

如果某章 Reader 评分低于门槛且修改后仍未达标，记录遗留问题，继续写下一章（不因单章阻塞整个流程）。

---

## Phase 2：发布（`--write-only` 时跳过）

所有章节写完后，汇总本日新写的章节列表，调用 `novel-publish`：

```bash
DATE=$(date +%Y-%m-%d)
# 调用 novel-publish skill，传入本日写的所有章节
/novel-publish [小说名] ch[起始]-ch[结束] --time [HH:MM]
```

发布结果直接透传 novel-publish 的汇报格式。

---

## Phase 3：日报

```
═══════════════════════════════════
今日日报 [YYYY-MM-DD]
═══════════════════════════════════
小说：[书名]
今日产出：[N] 章（ch[起始] - ch[结束]）
总字数：约 [XXXX×N] 字

章节质量：
  ch[NNN] [标题]  Critic X.X | Reader X/10 [通过✓/遗留问题⚠]
  ch[NNN] [标题]  Critic X.X | Reader X.X | Reader X/10 [通过✓]
  ...

发布状态：[已定时发布 16:00 ✓ / 仅写作未发布]

遗留问题（如有）：
  · ch[NNN]：[Reader 反馈中未修复的问题]

建议：[若有持续低分模式，提示运行 /novel-sync 做文风复盘]
```

---

## 特殊情况

- **`--publish-only`**：跳过写作，直接找今日最新写好但未发布的章节（通过文件修改时间判断）并发布
- **写作中断**：若某章写失败，询问用户是否跳过继续还是停止，不自动跳过
- **用户有特定灵感**：调用前告知 novel-write，每章可传入灵感提示；如果4章灵感不同，调用前询问用户逐章说明
