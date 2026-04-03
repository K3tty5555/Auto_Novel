---
name: novel-publish
description: |
  将章节发布到番茄小说。自动清洗Markdown格式，
  用Chrome CDP连接真实浏览器（复用登录态），逐章创建章节、填入标题、粘贴正文、设定时（默认16:00）并保存草稿。
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
metadata:
  trigger: 发布番茄、上传章节、定时发布、番茄小说发布
---

# novel-publish：发布章节到番茄小说

用法示例：
```
/novel-publish 开门剑山 ch048
/novel-publish 开门剑山 ch048-052
/novel-publish 开门剑山 ch048-052 --time 16:00
/novel-publish 开门剑山 ch048-052 --time 16:00 --stagger 20
```

参数说明：
- `小说名`：对应 `novels/` 下的目录名
- `章节范围`：`ch048-052`（连续）或 `ch048`（单章）
- `--time`：发布时间，默认 `16:00`
- `--stagger`：多章时间间隔（分钟），默认 `0`（同一时间点）

---

## 技术说明

使用 **Chrome CDP**（非 Playwright），连接/启动带独立 profile 的 Chrome：
- Profile 目录：`~/Library/Application Support/baoyu-fanqie/chrome-profile`
- 首次运行会打开新 Chrome 窗口，手动登录番茄小说后即可复用登录态
- 脚本：`.claude/skills/novel-publish/scripts/fanqie-publish.ts`
- 运行方式：`bun fanqie-publish.ts`

---

## Phase 1：解析参数，找到章节文件

**1.1 解析章节列表**

从用户输入提取：
- 小说名 → `novels/[小说名]/chapters/`
- 章节范围 → 将 `ch048-052` 解析为 [48, 49, 50, 51, 52]

**1.2 查找对应 .md 文件**

在 `chapters/` 目录中查找每个章节号对应的文件：
- 匹配规则：文件名以 `ch{NNN}_` 开头（NNN为零填充三位数）
- 例：`ch048_宋缺的剑.md`

如果某章号找不到对应文件，停止并告知用户。

将找到的文件按章节号升序排列，记录：
- 文件路径
- 章节标题（从 `# 第X章 标题` 提取，或从文件名 `_` 后部分提取）

---

## Phase 2：计算发布时间

基础时间：用户指定的 `--time`，默认 `16:00`

如果 `--stagger > 0`：每章递增对应分钟数
- 例：5章，stagger=20 → 16:00, 16:20, 16:40, 17:00, 17:20

如果 `--stagger == 0`（默认）：所有章节同一时间 16:00

今天日期：用 `date +%Y-%m-%d` 获取。

---

## Phase 3：逐章调用 CDP 脚本

对每章执行：

```bash
cd .claude/skills/novel-publish/scripts
bun fanqie-publish.ts \
  --md-file "novels/[小说名]/chapters/ch{NNN}_{标题}.md" \
  --time "[HH:MM]" \
  --date "[YYYY-MM-DD]"
```

脚本会自动：
1. 清洗 Markdown 格式（去掉 `---`、`**`、`> ` 等）
2. 连接 / 启动 Chrome（fanqie 专用 profile）
3. 打开番茄小说发布页（新标签页）
4. 填入标题、粘贴正文、设定时、存草稿
5. 关闭标签页

**首次运行**：Chrome 会打开番茄小说页面，如果未登录，手动登录后脚本会自动继续（或重新运行）。

**如果 bun 未安装**，使用：
```bash
npx -y bun fanqie-publish.ts ...
```

---

## Phase 4：汇报结果

```
发布完成报告
═══════════════════════════════

小说：[小说名]
发布章节：[N] 章

章节清单：
✓ 第48章 宋缺的剑 → 草稿已保存，定时 16:00
✓ 第49章 ...      → 草稿已保存，定时 16:00
...

请在番茄小说后台确认草稿状态后发布。
```

如果某章失败，标注 ✗ 并说明原因。

---

## 故障处理

| 问题 | 处理方式 |
|------|---------|
| 未登录 | Chrome 窗口打开后手动登录，然后重新运行 |
| bun 未安装 | 用 `npx -y bun` 替代 |
| 找不到文件 | 检查章节号和文件名格式 |
| 脚本报错 | 截图并告知用户具体错误信息 |
| 定时设置失败 | 脚本会继续存草稿，提醒用户手动设置定时 |

---

## 首次使用说明

1. 运行 `/novel-publish` 后，会打开一个新的 Chrome 窗口（独立 profile）
2. 在该窗口中登录番茄小说
3. 登录完成后，可以重新运行命令，之后的会话都会复用这个登录态
4. profile 保存在 `~/Library/Application Support/baoyu-fanqie/chrome-profile`
