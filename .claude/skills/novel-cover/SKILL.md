---
name: novel-cover
description: |
  为小说生成封面图（600×800，含作品名和作者笔名，风格与作品匹配）。
  自动从番茄小说排行榜抓取5张同类爆款封面作为参考，调用 baoyu-cover-image 生成3个候选版本，
  Reader Agent 评分（≥8分通过），不通过则根据反馈重新生成，最多3轮。
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Skill
  - Agent
  - AskUserQuestion
  - mcp__plugin_playwright_playwright__browser_navigate
  - mcp__plugin_playwright_playwright__browser_snapshot
  - mcp__plugin_playwright_playwright__browser_wait_for
  - mcp__plugin_playwright_playwright__browser_evaluate
metadata:
  trigger: 生成封面、小说封面、封面图
---

# novel-cover：生成小说封面图

用户调用时可能提供：小说名、作者笔名。如未提供则自动推断或询问。

---

## Step 0：确认小说和参数

检查 `novels/` 下的子目录：
- 只有一部 → 直接用
- 多部 → 问用户选哪部

读取以下文件：
- `novels/[小说名]/发布信息.md` — 获取目标读者（男频/女频）、简介、标签
- `novels/[小说名]/世界规则.md` — 获取视觉关键词（修炼体系、地点、风格）
- `novels/[小说名]/读者画像.md` — 了解目标读者视觉期待（如存在）

如果用户未提供**作者笔名**，查看发布信息.md中是否记录；若无，用 AskUserQuestion 询问一次。

**检查竞品参考图**：
```bash
ls novels/[小说名]/封面参考/ 2>/dev/null
```
- 目录已有图片 → 直接使用，**跳过 Step 0.5**
- 目录不存在或为空 → 执行 **Step 0.5** 自动抓取

---

## Step 0.5：自动抓取竞品封面（仅在 封面参考/ 为空时执行）

目标：从番茄小说排行榜抓取5张同类爆款封面，存入 `novels/[小说名]/封面参考/`。

**0.5.1 确定搜索分类**

根据 `发布信息.md` 中的标签映射到番茄小说分类 URL：

| 标签组合 | 番茄排行榜 URL |
|---------|-------------|
| 男频 + 玄幻/武侠/修仙 | `https://fanqienovel.com/rank/book?genre=1&type=male&rankType=hot` |
| 男频 + 都市/现实 | `https://fanqienovel.com/rank/book?genre=4&type=male&rankType=hot` |
| 女频 + 言情/古言 | `https://fanqienovel.com/rank/book?genre=2&type=female&rankType=hot` |
| 女频 + 现言/都市 | `https://fanqienovel.com/rank/book?genre=5&type=female&rankType=hot` |

若无法精确匹配，默认使用男频玄幻热门榜。

**0.5.2 用 Playwright 访问排行榜，提取封面图 URL**

```
导航到对应排行榜 URL
等待页面加载（等待出现封面图片元素）
用 evaluate 提取前 8 本书的封面图 URL：
  document.querySelectorAll('img[src*="cover"], img[alt*="封面"], .book-cover img, [class*="cover"] img')
  取前 8 个 src 属性，过滤掉空值和占位图
```

如果 Playwright 获取失败（登录墙/结构变化），降级到 **Step 0.5.3**。

**0.5.3 降级方案：WebSearch**

用关键词搜索同类爆款书名，再手动提取封面 URL：
```
搜索词："番茄小说 [男频/女频] [玄幻/武侠] 热门 2025 排行"
从搜索结果找5本热门书名
再搜索每本书的封面图片 URL
```

**0.5.4 下载封面图**

```bash
mkdir -p novels/[小说名]/封面参考

# 对每个封面 URL，用 curl 下载
curl -L --max-time 10 --output "novels/[小说名]/封面参考/ref-01.jpg" "[URL1]"
curl -L --max-time 10 --output "novels/[小说名]/封面参考/ref-02.jpg" "[URL2]"
# ... 最多5张
```

下载后验证文件大小（> 5KB 视为有效），无效的跳过。

**0.5.5 记录来源**

保存 `novels/[小说名]/封面参考/来源.md`：
```markdown
# 封面参考来源

抓取时间：[YYYY-MM-DD]
类型：[男频玄幻/女频言情等]
来源平台：番茄小说热门榜

| 文件 | 对应书名 | 备注 |
|------|---------|------|
| ref-01.jpg | [书名] | |
| ref-02.jpg | [书名] | |
...

> 以上图片仅作为封面风格参考，不用于商业用途。
```

**完成后告知用户**：
```
✓ 已自动抓取 [N] 张竞品封面参考，保存到 novels/[小说名]/封面参考/
  参考书目：[书名1]、[书名2]、...
  （可打开目录查看，不满意可手动替换）
```

---

## Step 1：确定封面风格

根据读取内容，按以下规则决定封面风格参数：

**男频武侠/玄幻（如本项目《开门剑山》）：**
- `--type scene`（具体场景感）或 `--type hero`（人物剪影）
- `--palette cool` 或 `--palette dark`（冷色、墨色）
- `--rendering painterly`（水墨/写意感）或 `--rendering hand-drawn`
- `--mood bold`（高对比，有张力）
- `--text title-only`（只显示标题，不加副标题）
- `--font display`（粗体装饰字体）
- `--aspect 3:4`（竖版，对应600×800px）

**女频都市/言情（如有）：**
- `--palette pastel` 或 `--palette warm`
- `--rendering painterly` 或 `--rendering digital`
- `--mood balanced`
- `--font serif`

---

## Step 2：构建封面 prompt 补充说明

准备一段内容摘要，保存为 `novels/[小说名]/cover-brief.md`：

```
作品名：[小说名]
作者笔名：[笔名]
类型：男频武侠/玄幻
简介摘要：[从发布信息.md取2-3句核心描述]
视觉关键词：[从世界规则.md提取：如"剑修""江湖""凤尾山""旧铁""草莽少年"]

封面硬性要求：
- 必须显示作品名"[小说名]"（中文大字，醒目）
- 必须显示作者笔名"[笔名]"（小字，角落或底部）
- 尺寸目标：600×800像素（3:4竖版）
- 风格：写意水墨或古风插画，不要照片质感
- 人物如有：用剪影或侧影，不要正脸大特写
- 主色调：冷色系（墨色、灰蓝、靛蓝）为主，点缀暖色（朱砂、金色）
```

---

## Step 3：生成3个候选封面

生成**3个不同风格**的版本，分别覆盖不同方向，便于 Reader Agent 比选：

**版本A（scene + dark）**：
```
/baoyu-cover-image novels/[小说名]/cover-brief.md \
  --type scene --palette dark --rendering painterly \
  --mood bold --text title-only --font display --aspect 3:4 --quick \
  [--ref novels/[小说名]/封面参考/*.png（如有）]
```
生成后复制到 `novels/[小说名]/封面候选/cover-A.png`

**版本B（hero + cool）**：
```
/baoyu-cover-image novels/[小说名]/cover-brief.md \
  --type hero --palette cool --rendering painterly \
  --mood bold --text title-only --font display --aspect 3:4 --quick \
  [--ref novels/[小说名]/封面参考/*.png（如有）]
```
生成后复制到 `novels/[小说名]/封面候选/cover-B.png`

**版本C（metaphor + earth）**：
```
/baoyu-cover-image novels/[小说名]/cover-brief.md \
  --type metaphor --palette earth --rendering hand-drawn \
  --mood bold --text title-only --font display --aspect 3:4 --quick \
  [--ref novels/[小说名]/封面参考/*.png（如有）]
```
生成后复制到 `novels/[小说名]/封面候选/cover-C.png`

---

## Step 4：Reader Agent 评分

读取 `novels/[小说名]/读者画像.md`（如存在），启动 **general-purpose agent** 以目标读者身份分别评价3个候选封面。

评分格式（每个版本）：
```
封面 [A/B/C]：
  第一反应：会点 / 可能 / 不会
  书名清晰：Y/N | 主视觉记忆点：Y/N | 风格符合类型：Y/N
  点击欲望：X / 10
  最大优势：[一句话]
  最大问题：[一句话]
```

**汇总**：
```
══════════════════════════
封面评分汇总
══════════════════════════
版本A：X/10 — [一句话评价]
版本B：X/10 — [一句话评价]
版本C：X/10 — [一句话评价]

推荐版本：[最高分版本]，原因：[具体说明]
通过门槛（≥8分）：[是 / 否]
```

**判断**：
- 最高分 ≥ 8 → 进入 Step 5，使用最高分版本
- 最高分 < 8 → 进入 Step 4.5（最多再生成2版，共最多3轮）

---

## Step 4.5：根据反馈重新生成（最多2轮）

从 Reader 反馈中提取最高频问题，调整 prompt 和参数重新生成**2个新版本**。

常见问题 → 调整方向：
- "书名看不清" → 在 prompt 中强调标题占封面高度1/3，加粗字体
- "风格不够男频" → 切换 `--palette dark`，强调刀剑/力量感元素
- "没有记忆点" → 切换 `--type hero`，加强主角剪影或标志性道具（旧铁）
- "太普通/像某本书" → 更换 rendering 风格，加强独特视觉元素

重新 Reader 评分。若仍未达到8分，取最高分版本继续，记录遗留问题。

---

## Step 5：整理输出文件

将最终选定版本复制到：
```
novels/[小说名]/封面.png
```

清理临时文件：
```bash
rm novels/[小说名]/cover-brief.md
rm -rf novels/[小说名]/封面候选/
```

---

## Step 6：汇报结果

```
封面已生成：novels/[小说名]/封面.png
选用版本：[A/B/C 或第N轮版本X]
风格：[palette] + [rendering]

Reader 评分：X / 10（门槛：8 分）[通过 ✓ / 未达标，已取最高分版本]

发布前请确认：
✓ 作品名"[小说名]"是否清晰可见
✓ 作者笔名"[笔名]"是否存在
✓ 风格是否符合预期

遗留问题（如有）：[Reader 反馈中未修复的问题]
如需重新生成，在 novels/[小说名]/封面参考/ 放入竞品截图后重新运行 /novel-cover。
```

---

## 特殊情况

- **作者笔名未知**：必须询问用户，不能省略
- **baoyu-cover-image 未安装**：提示用户安装
- **无读者画像.md**：Reader 评分跳过，直接生成3版让用户自选
- **有竞品参考图**：优先用 `--ref` 传入，让 AI 学习竞品的构图/色调
