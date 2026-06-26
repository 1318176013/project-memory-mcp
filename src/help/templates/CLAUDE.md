## 项目记忆（project-memory MCP）

开始编码任务前，若任务涉及【改已有功能 / 要守项目约定 / 易踩坑区域】：

1. 读工作空间根的 `.project-memory`（JSON），取出 `projectId`；读不到则跳过本节。
2. 用该 projectId 调 `search_knowledge(projectId, query)` 查相关的决策 / 约定 / 教训 / 写法。
3. 动手前用一句话说明：将遵循哪条已查到的约定 / 避开哪个坑。

纯新建、与项目历史无关的小改动可跳过。
