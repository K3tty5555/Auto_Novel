---
name: novel-cover
description: |
  为小说生成封面图（600×800，含作品名和作者笔名，风格与作品匹配）。
  调用 baoyu-cover-image，自动读取发布信息.md和世界规则.md生成风格prompt。
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Skill
  - Agent
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

如果用户未提供**作者笔名**，查看发布信息.md中是否记录；若无，用 AskUserQuestion 询问一次。

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

在调用 baoyu-cover-image 之前，准备一段内容摘要，让 baoyu-cover-image 分析时能提取正确的视觉元素：

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

将此内容保存为临时文件 `novels/[小说名]/cover-brief.md`，供 baoyu-cover-image 读取。

---

## Step 3：调用 baoyu-cover-image

使用 Skill 工具调用 baoyu-cover-image，传入参数：

```
/baoyu-cover-image novels/[小说名]/cover-brief.md \
  --type scene \
  --palette dark \
  --rendering painterly \
  --mood bold \
  --text title-only \
  --font display \
  --aspect 3:4 \
  --quick
```

**注意**：`--quick` 跳过交互确认，直接生成。如果用户想自定义某个维度，去掉 `--quick`。

---

## Step 4：整理输出文件

baoyu-cover-image 默认将封面保存到 `cover-image/` 目录。

将生成的 `cover.png` 复制到：
```
novels/[小说名]/封面.png
```

用 Bash 执行：
```bash
cp cover-image/[slug]/cover.png novels/[小说名]/封面.png
```

删除临时文件：
```bash
rm novels/[小说名]/cover-brief.md
```

---

## Step 5：汇报结果

```
封面已生成：novels/[小说名]/封面.png
尺寸目标：600×800（3:4竖版）
格式：PNG
风格：[实际使用的 palette/rendering]

发布前请确认：
- ✓ 作品名"[小说名]"是否清晰可见
- ✓ 作者笔名"[笔名]"是否存在
- ✓ 风格是否符合预期

如需重新生成，可修改参数后再次调用 /novel-cover。
```

---

## 特殊情况

- **作者笔名未知**：必须询问用户，不能省略，因为封面是对外展示的
- **baoyu-cover-image 未安装**：提示用户安装（openclaw install baoyu-cover-image）
- **生成的封面不满意**：告知用户可用 `--type hero` 或 `--palette cool` 等参数调整后重试
