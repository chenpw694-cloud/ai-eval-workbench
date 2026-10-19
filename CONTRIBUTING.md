# 继续开发

使用 `.node-version` 中的 Node.js 版本与 `package.json` 声明的 pnpm。首次运行：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

提交前运行 `pnpm test` 和 `pnpm build`。修改依赖时同时提交 `pnpm-lock.yaml`；不手改锁文件。GitHub 的检查工作流会运行相同命令。

## 修改入口

| 想修改什么 | 先看哪里 |
| --- | --- |
| 电商方案、权重与标签 | `schemes/ecommerce-t2i/scheme.json` |
| 正式页面与操作流程 | `src/pages/FormalWorkspace.tsx` 与对应 Workspace 页面 |
| 演示页面与合成数据 | `src/App.tsx`、`src/demo/`、`src/pages/ReportDemo.tsx` |
| 评分、汇总与口径 | `src/core/assessment.ts`、`scoring.ts`、`report.ts` |
| 传包、合并与冲突 | `src/core/packages.ts`、`merge.ts`、`src/storage/` |
| 独立复评与 GSB | `src/core/quality.ts`、`src/storage/quality.ts` |
| 联合排名与报告修订 | `src/core/joint.ts`、`report-notes.ts` |
| 固定版本归档 | `src/core/archive.ts`、`src/storage/archives.ts` |

新增其他 AI 方案时可以先新建 `schemes/<方案名>/`，但当前正式项目创建入口仍绑定电商方案，部分评分与页面也含电商语义。仅新增 JSON 不会自动获得完整的文生视频评测支持，需要一起补方案选择、数据契约及对应计算。

## 保存数据兼容性

页面改动尽量保持在页面层。更改评分、汇总或规则时更新相关核心测试。不要让演示数据写入正式项目，也不要将缺评当成满分。

导出协议或数据库结构有变化时，说明旧数据如何读取、迁移或明确拒绝。修改归档报告计算、结构或检查文案时，升级 `calculationVersion` 并保留旧版核验逻辑，详见 `docs/12-version-archive.md`。

真实记录、原图和导出包放在仓库外；公开问题反馈使用复现步骤及脱敏后的最小示例。`.gitignore` 只能减少误提交，不能识别被改名的数据文件。

## 适合继续 vibe coding 的请求

可以这样描述下一次修改：

> 请先阅读 README 与相关设计文档。在保留现有项目数据兼容性的前提下，为【页面】增加【行为】。沿用当前界面样式；只修改相关模块；完成适当验证并说明数据影响。

项目采用 MIT 许可证，完整条款见 [LICENSE](LICENSE)。
