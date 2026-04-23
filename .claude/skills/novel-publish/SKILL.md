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

脚本内置的自动处理机制（无需人工干预）：
- 序号/标题：CDP 鼠标点击 + `Input.insertText`，确保 React 状态正确更新
- 正文粘贴：DataTransfer ClipboardEvent，React 富文本编辑器原生支持
- 弹框处理：自动检测并点击「知道了」「放弃」，防止保存到旧草稿
- 重定向检测：落地 URL 含草稿 ID 时先导航首页再重新打开，防止内容写入旧草稿
- URL 碰撞检测：脚本自动比对本次与上次的 URL，碰撞则抛错触发重试
- 草稿释放：保存后导航到首页再关闭标签页，告知服务器当前草稿已完成

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

## Phase 3：逐章调用 CDP 脚本（带自动重试）

脚本路径：`.claude/skills/novel-publish/scripts/`

**3.0 读取 Book ID**

从 `novels/[小说名]/发布信息.md` 提取番茄小说 Book ID：
```bash
BOOK_ID=$(grep -oE '番茄小说 Book ID：[0-9]+' "novels/[小说名]/发布信息.md" | grep -oE '[0-9]+$' || echo "")
```
若为空则不传 `--book-id`（脚本使用默认值）。

对每章最多尝试 **2次**，失败则记录并继续下一章：

```bash
SCRIPT_DIR=".claude/skills/novel-publish/scripts"
DATE=$(date +%Y-%m-%d)
BOOK_ID=$(grep -oE '番茄小说 Book ID：[0-9]+' "novels/[小说名]/发布信息.md" | grep -oE '[0-9]+$' || echo "")
BOOK_ID_ARG=""
[ -n "$BOOK_ID" ] && BOOK_ID_ARG="--book-id $BOOK_ID"

for ch_file in [按章节号升序的文件列表]; do
  success=false
  for attempt in 1 2; do
    if bun "$SCRIPT_DIR/fanqie-publish.ts" \
         --md-file "$ch_file" \
         --time "[HH:MM]" \
         --date "$DATE" \
         $BOOK_ID_ARG; then
      success=true
      break
    fi
    echo "[retry] ch$(basename $ch_file) attempt $attempt failed, waiting 8s..."
    sleep 8
  done

  if [ "$success" = false ]; then
    echo "[FAILED] $(basename $ch_file)"
  fi

  # 章节间间隔，让服务器充分释放草稿状态
  sleep 5
done
```

**脚本退出码：**
- `0` = 成功（草稿已保存，URL 唯一）
- `1` = 失败（URL 碰撞、表单填充失败、存草稿按钮未找到等）

---

## Phase 4：汇报结果

```
发布完成报告
═══════════════════════════════

小说：[小说名]
发布章节：[N] 章（成功 M / 失败 F）

章节清单：
✓ 第48章 宋缺的剑   → 草稿已保存，定时 16:00
✓ 第49章 出门       → 草稿已保存，定时 16:00
✗ 第50章 旧铁上的字 → 失败（重试2次后放弃），需手动上传
...

请在番茄小说草稿箱确认后发布。
如有失败章节，手动上传或重新运行：/novel-publish [小说名] ch050
```

---

## 故障处理

| 问题 | 脚本行为 | 操作建议 |
|------|----------|---------|
| 未登录 | 等待 inputs 超时，退出码 1 | Chrome 窗口手动登录后重新运行 |
| bun 未安装 | 命令未找到 | `npm install -g bun` |
| 找不到章节文件 | Phase 1 报错，提前终止 | 检查章节号和文件名格式 |
| URL 碰撞 | 自动抛错，触发重试 | 通常重试可解决 |
| 弹框（知道了/放弃） | 自动处理 | 无需操作 |
| 服务端重定向旧草稿 | 自动检测并重新导航 | 无需操作 |
| 序号/标题为空 | 已用 CDP 点击+insertText 修复 | 若仍出现，截图反馈 |
| 存草稿按钮未找到 | 抛错，触发重试 | 通常重试可解决 |

---

## 首次使用说明

1. 运行 `/novel-publish` 后，会打开一个新的 Chrome 窗口（独立 profile）
2. 在该窗口中登录番茄小说
3. 登录完成后，可以重新运行命令，之后的会话都会复用这个登录态
4. profile 保存在 `~/Library/Application Support/baoyu-fanqie/chrome-profile`
