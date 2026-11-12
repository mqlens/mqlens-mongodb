# MQLens

[English](README.md) · [Deutsch](README.de.md) · **简体中文**

**浏览、查询并理解 MongoDB 数据。** 适用于 macOS、Windows 和 Linux 的免费开源桌面工作区。

[![CI](https://github.com/mqlens/mqlens-mongodb/actions/workflows/ci.yml/badge.svg)](https://github.com/mqlens/mqlens-mongodb/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-enabled-brightgreen.svg)](.github/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/mqlens/mqlens-mongodb)](https://github.com/mqlens/mqlens-mongodb/releases)
[![Downloads](https://img.shields.io/github/downloads/mqlens/mqlens-mongodb/total)](https://github.com/mqlens/mqlens-mongodb/releases)
[![Stars](https://img.shields.io/github/stars/mqlens/mqlens-mongodb?style=flat)](https://github.com/mqlens/mqlens-mongodb/stargazers)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<br />

连接本地 MongoDB、自托管部署或 MongoDB Atlas，在同一个桌面工作区中浏览文档、编写查询并查看结果。使用标签页和分屏视图，同时处理多个集合。

从熟悉的表格和 JSON 视图开始，按需使用聚合工具、执行计划、模式分析或内置 Shell。桌面应用无需 MQLens 账号，AI 辅助功能可按需启用。

**[下载 MQLens](https://mqlens.com/#download)** · [观看演示](https://mqlens.com/demo/) · [文档](https://mqlens.com/docs/) · [官网](https://mqlens.com)

<br />

[![MQLens 工作区并排显示两个集合](website/public/screenshots/mqlens-workspace.png)](https://mqlens.com/demo/)

*截图和演示使用示例数据，其中的查询结果和执行统计仅用于展示。*

## 从集合到答案

- **浏览文档。** 在表格、树形和 JSON 视图之间切换，筛选、排序、编辑和导出结果。
- **理解查询。** 构建聚合管道、查看可视化执行计划并管理索引。
- **安排工作区。** 拆分视图、将标签页移至独立窗口，并恢复上次会话。
- **连接数据库。** 支持 MongoDB 连接字符串、SSH 隧道、TLS 及多种身份验证方式。
- **使用操作保护。** 设置只读连接或为破坏性操作启用确认提示。凭据在本地加密，并由主密码保护。
- **按需使用 AI。** 在执行前检查和编辑生成的 MQL，或主动为兼容 MCP 的智能体开放指定连接。

[查看全部功能](https://mqlens.com/features/)，包括模式分析、GridFS、测试数据生成、导入导出及内置 `mongosh` Shell。

## MQLens Server — 即将推出

面向团队的自托管后端正在规划中，将提供集中的 MongoDB 凭据管理、访问控制和审计日志。MQLens Server 将作为独立付费产品推出；桌面应用仍然免费开源。[了解 MQLens Server](https://mqlens.com/mqlens-server/) 或[关注项目进展](https://github.com/mqlens/mqlens-server)。

## 安装并运行第一次查询

下载[最新版本](https://github.com/mqlens/mqlens-mongodb/releases/latest)，或在[下载页面](https://mqlens.com/#download)选择适合的平台安装包。

| 平台 | 安装包 | 开始使用 |
| --- | --- | --- |
| macOS | 适用于 Apple Silicon 或 Intel 的 `.dmg` | 打开磁盘映像，将 MQLens 拖入“应用程序”文件夹。 |
| Windows | 适用于 x64 的 `.exe` 或 `.msi` | 运行安装程序，然后从开始菜单启动 MQLens。 |
| Linux | `.deb`、`.rpm` 或 `.AppImage` | 使用包管理器安装，或为 AppImage 文件添加执行权限。 |

1. 打开 MQLens，创建本地凭据保险库。
2. 添加 MongoDB 连接，或浏览内置示例数据。
3. 打开集合，输入筛选条件并运行查询。

参阅[安装与连接指南](https://mqlens.com/docs/)。可选的内置 Shell 需要安装 [`mongosh`](https://www.mongodb.com/docs/mongodb-shell/)；普通图形界面查询不需要。

## 快速预览

[![MQLens 以表格和树形视图浏览示例文档](assets/demo.gif)](https://mqlens.com/demo/)

[观看完整演示并了解工作流程](https://mqlens.com/demo/)。

| 构建聚合管道 | 阅读执行计划 |
| --- | --- |
| [![聚合阶段及示例结果](website/public/screenshots/mqlens-aggregation.png)](https://mqlens.com/guides/mongodb-aggregation-gui/) | [![执行计划及示例执行统计](website/public/screenshots/mqlens-explain-plan.png)](https://mqlens.com/guides/read-mongodb-explain-plan/) |

## 信任与隐私

- 无需账号，不收集应用遥测数据。
- 连接凭据和设置在本地使用 AES-256-GCM 加密，密钥通过 Argon2id 派生。
- 只读模式和破坏性操作确认可配合 MongoDB 权限与备份使用。
- AI 功能可选。配置的服务提供商或智能体客户端可能接收提示词、模式上下文和工具结果。将 API 密钥保存在后端并不意味着 AI 处理只在本机进行。
- MCP 默认关闭，按连接启用，并提供写操作确认机制。启用前请阅读 [MCP 工具参考](docs/mcp-tools.md)。
- 发布版本包含验证信息。参阅[下载验证指南](docs/verifying-downloads.md)和[安全政策](.github/SECURITY.md)。

正在比较工具？可阅读与 [MongoDB Compass](https://mqlens.com/compare/mongodb-compass-alternative/) 和 [Studio 3T](https://mqlens.com/compare/studio-3t-alternative/) 的对比。

## 语言支持

应用支持英语、德语和简体中文，可在设置中切换。本 README 也提供 [English](README.md) 和 [Deutsch](README.de.md) 版本。链接中的网站页面和技术指南目前为英文。

## 参与贡献

MQLens 使用 React 和 TypeScript 构建界面，后端基于 Tauri 和 Rust。欢迎提交问题报告、文档修正、翻译和代码贡献。

- [开发环境与测试命令](docs/development.md)
- [贡献指南](.github/CONTRIBUTING.md)和[翻译指南](docs/CONTRIBUTING-i18n.md)
- [本地演示数据库](docs/demo-database.md)
- [适合新贡献者的问题](https://github.com/mqlens/mqlens-mongodb/labels/good%20first%20issue)和[路线图](docs/ROADMAP.md)
- [报告问题](https://github.com/mqlens/mqlens-mongodb/issues/new?template=bug_report.yml)

## 许可证

[Apache-2.0](LICENSE)。可自由使用、查看和改进。
