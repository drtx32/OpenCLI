# OpenCLI 项目指南

## 项目概述

OpenCLI 是一个将网站、浏览器会话统一转化为 CLI 接口的工具。核心目录：

- `clis/` — 所有适配器命令（每个子目录为一个 site）
- `cli-manifest.json` — 自动生成，勿手动编辑
- `src/` — 核心框架代码
- `tests/` — 测试文件

## zsxq 适配器

位于 `clis/zsxq/`，包含多个命令：

| 命令 | 作用 | 关键文件 |
|------|------|----------|
| `topics` | 获取话题列表 | `topics.js` |
| `topic` | 获取单个话题详情 | `topic.js` |
| `dynamics` | 获取最新动态 | `dynamics.js` |
| `groups` | 列出加入的星球 | `groups.js` |
| `search` | 搜索星球内容 | `search.js` |

**注意**：`topic`（单条）和 `topics`（列表）是两个独立命令，位于不同文件。

### topics 命令分页

ZSXQ API 使用 `end_time` cursor 分页，不是数字 offset。

```bash
# 获取最新 30 条
opencli zsxq topics --limit 30 --group_id <id> --resolve_files false

# 翻页：传入上一页最后一条的 create_time
opencli zsxq topics --limit 30 --end_time "2026-04-15T09:39:51.023+0800" --group_id <id> --resolve_files false
```

### topic 命令新增 images/files

`topic` 命令现已支持 `images` 和 `files` 输出字段，以及 `resolve_files` 参数控制是否解析下载链接。

## 常用操作

### 本地测试

```bash
# 测试单个命令
opencli zsxq topics --limit 5 --group_id 28855811424141

# 运行测试
npm test

# doctor 检查
opencli doctor
```

### 提交规范

- commit message 格式：`feat(zsxq): description` / `fix(zsxq): description`
- Co-Authored-By 不要漏掉

### 同步到 node_modules

本地 `clis/` 改动不会自动同步到 `node_modules/@jackwener/opencli/clis/`。发布时由维护者处理。

## 文件修改优先级

- **zsxq 相关**：直接改 `clis/zsxq/` 下的文件
- **cli-manifest.json**：由构建脚本自动生成，不要手动改
- **adapter-manifest.json**（存在于 fork 仓库的 `.opencli/` 目录）：记录各 adapter 的 hash，用于本地开发验证
