---
name: novel-publish
description: |
  将章节发布到番茄小说。自动清洗Markdown格式（去掉水平线、加粗符号、引用标记等），
  用Playwright打开番茄小说后台，逐章创建、粘贴正文、设定时（默认16:00）并保存草稿。
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
  - mcp__plugin_playwright_playwright__browser_navigate
  - mcp__plugin_playwright_playwright__browser_snapshot
  - mcp__plugin_playwright_playwright__browser_take_screenshot
  - mcp__plugin_playwright_playwright__browser_click
  - mcp__plugin_playwright_playwright__browser_type
  - mcp__plugin_playwright_playwright__browser_fill_form
  - mcp__plugin_playwright_playwright__browser_press_key
  - mcp__plugin_playwright_playwright__browser_wait_for
  - mcp__plugin_playwright_playwright__browser_evaluate
  - mcp__plugin_playwright_playwright__browser_select_option
  - mcp__plugin_playwright_playwright__browser_tabs
metadata:
  trigger: 发布番茄、上传章节、定时发布、番茄小说发布
---

# novel-publish：发布章节到番茄小说

用法示例：
```
/novel-publish 开门剑山 ch101-105
/novel-publish 开门剑山 ch101
/novel-publish 开门剑山 ch101-105 --time 16:00
/novel-publish 开门剑山 ch101-105 --time 16:00 --stagger 20
```

参数说明：
- `小说名`：对应 `novels/` 下的目录名
- `章节范围`：`ch101-105`（连续）或 `ch101`（单章）
- `--time`：发布时间，默认 `16:00`
- `--stagger`：多章时间间隔（分钟），默认 `0`（同一时间点）

---

## Phase 1：解析参数，找到章节文件

**1.1 解析章节列表**

从用户输入提取：
- 小说名 → `novels/[小说名]/chapters/`
- 章节范围 → 将 `ch101-105` 解析为 [101, 102, 103, 104, 105]

**1.2 查找对应 .md 文件**

在 `chapters/` 目录中查找每个章节号对应的文件：
- 匹配规则：文件名以 `ch{NNN}_` 开头（NNN为零填充三位数）
- 例：`ch101_回来了.md`

如果某章号找不到对应文件，停止并告知用户。

将找到的文件按章节号升序排列，记录：
- 文件路径
- 章节标题（从 `# 第X章 标题` 提取，或从文件名 `_` 后部分提取）

---

## Phase 2：Markdown 清洗

对每个章节文件执行以下清洗，生成**纯文本发布包**：

**清洗规则（按顺序执行）：**

1. **去掉文件头元数据**
   - 删除 `# 第X章 标题` 这一行（保留章节标题，单独存储）
   - 删除 `> 字数：约XXXX字 | 写作日期：...` 这一行

2. **去掉水平分割线**
   - 将 `---`（单独成行）替换为空行

3. **去掉引用块标记**
   - 将行首的 `> ` 去掉（只去标记，保留内容）

4. **去掉粗体/斜体标记**
   - `**文字**` → `文字`
   - `*文字*` → `文字`
   - `__文字__` → `文字`

5. **处理段落间距**
   - 确保每个段落之间有**一个空行**（番茄小说以空行分段）
   - 连续多个空行压缩为一个空行
   - 文首和文尾不留空行

6. **去掉其他 Markdown 标记**
   - `# `、`## `、`### ` 开头的标题行 → 只保留文字（去掉 `#` 和空格）
   - 但注意：章节正文一般不含子标题，如果出现再处理

**清洗结果**：每章生成一个清洁的纯文本字符串（变量存于内存）

**验证**：
- 检查清洁后文本中是否还含有 `---`、`**`、`> ` 等 Markdown 标记
- 检查段落间距是否合理（抽查前3段）

---

## Phase 3：打开番茄小说后台

**3.1 导航到创作后台**

使用 Playwright 导航到番茄小说创作后台：
```
https://fanqienovel.com/platform/home
```

如果该 URL 不正确，尝试：
```
https://fanqienovel.com/creator
```

截图确认是否已登录（是否看到"创作中心"或"我的书架"等字样）。

**如果未登录**：
- 提示用户在打开的浏览器中手动登录番茄小说
- 等待用户确认登录完成后继续（用 AskUserQuestion 确认）

**3.2 找到目标小说**

在创作后台查找对应小说（按小说名匹配）。

截图后，点击对应小说的"管理"或"章节管理"链接。

---

## Phase 4：逐章发布

**计算发布时间**：
- 基础时间：用户指定的 `--time`，默认 `16:00`
- 如果 `--stagger > 0`：每章递增对应分钟数
  - 例：5章，stagger=20 → 16:00, 16:20, 16:40, 17:00, 17:20
- 如果 `--stagger == 0`（默认）：所有章节同一时间 `16:00`

**对每章执行以下步骤**：

### Step A：新建章节

在章节管理页面，点击"新建章节"或"添加章节"按钮。

等待章节编辑器加载完成（等待标题输入框出现）。

### Step B：填写标题

在标题输入框中填入章节标题：
- 格式：`第X章 标题` 或直接填写标题（根据平台要求）
- 从 Phase 1 记录的标题中取得

### Step C：粘贴正文

正文区域通常是一个 `<textarea>` 或富文本编辑器。

**操作流程**：
1. 点击正文编辑区
2. 使用 `browser_type` 输入内容（如果文本框支持直接type）
3. 或者：将内容写入剪贴板，然后使用 `Ctrl+A` 全选后粘贴

**注意**：
- 如果编辑器是富文本（contenteditable），使用 `evaluate` 直接设置文本内容
- 如果是普通 textarea，使用 `browser_type` 或 `fill_form`
- 输入前先截图确认编辑区状态

**设置内容的优先方案**（按此顺序尝试）：

方案A - evaluate 直接设置（适用于 textarea）：
```javascript
document.querySelector('textarea').value = '内容';
document.querySelector('textarea').dispatchEvent(new Event('input', {bubbles: true}));
```

方案B - fill_form：
```
填入 selector:textarea 内容
```

方案C - 剪贴板粘贴：
```
先用 evaluate 将内容复制到剪贴板
navigator.clipboard.writeText('内容')
然后点击编辑区 + Ctrl+A + Ctrl+V
```

### Step D：设置定时发布

查找"定时发布"或"发布时间"选项，设置为计算好的时间。

常见 UI 模式：
- 单选按钮：选择"定时发布"单选项
- 时间输入框：填入 `16:00` 或 `YYYY-MM-DD 16:00`
- 日期选择器：选择今天的日期 + 时间

如果日期需要填写，使用今天的日期（当前运行日期）。

### Step E：保存草稿

点击"保存草稿"或"提交"按钮。

等待保存成功的提示（"保存成功"、"草稿已保存"等）。

截图确认保存状态。

记录该章的草稿状态（成功/失败）。

---

## Phase 5：汇报结果

```
发布完成报告
═══════════════════════════════

小说：[小说名]
发布章节：[N] 章

章节清单：
✓ 第101章 [标题] → 草稿已保存，定时 16:00
✓ 第102章 [标题] → 草稿已保存，定时 16:00
✓ 第103章 [标题] → 草稿已保存，定时 16:00
✓ 第104章 [标题] → 草稿已保存，定时 16:00
✓ 第105章 [标题] → 草稿已保存，定时 16:00

请在番茄小说后台确认草稿状态后发布。
```

如果某章失败，标注 ✗ 并说明原因。

---

## 故障处理

| 问题 | 处理方式 |
|------|---------|
| 未登录 | 截图展示，等待用户手动登录后继续 |
| 找不到小说 | 截图，让用户确认小说名称是否一致 |
| 编辑器无法输入 | 截图并尝试其他方案（A→B→C） |
| 保存失败 | 截图记录，继续下一章，最后汇报失败章节 |
| 定时设置找不到 | 跳过定时，保存为草稿，提醒用户手动设置 |

---

## 番茄小说 UI 关键元素参考

（实际运行时以截图为准，以下仅供参考）

- 创作后台入口：通常在用户头像下拉菜单中"创作中心"
- 章节管理：选择书名 → "章节管理" 或 "目录管理"
- 新建章节按钮：通常标注"新建章节"、"+ 添加"
- 标题框：通常在编辑器顶部
- 正文区：大面积的文本输入区域
- 定时发布：在"发布"按钮旁边，或点击"发布"后弹出的选项
- 草稿保存：通常有单独的"保存草稿"按钮

---

## 首次使用说明

1. 运行 `/novel-publish` 后，Playwright 会打开一个浏览器窗口
2. 如果未登录，请在该窗口中手动登录番茄小说
3. 登录完成后，告知 Claude Code 继续
4. 之后的会话中，浏览器会复用已有会话（取决于 Playwright MCP 配置）
