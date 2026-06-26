#!/usr/bin/env node
/**
 * project-memory · 写侧 Stop hook
 *
 * 任务结束时，若【本回合有代码改动 + 当前是接入了 memory 的项目】，
 * 打回 agent 要求它把这次的项目知识沉淀到 project-memory，再放行。
 *
 * 放行（不打回）条件，满足任一即放行（见 NOTES §4d）：
 *   1. stop_hook_active === true                         （防死循环：沉淀已做完的二次 Stop）
 *   2. 工作空间根无 .project-memory                       （非接入项目）
 *   3. .project-memory 解析失败 / 无 projectId            （契约不满足，绝不自作主张生成）
 *   4. 本回合 transcript 无 Edit/Write/MultiEdit/NotebookEdit（纯问答/闲聊轮）
 * 以上都不满足 → 打回沉淀。
 *
 * 约定：hook 出任何意外一律"放行"（exit 0，不输出 block），绝不卡住用户。
 */

const fs = require("fs");
const path = require("path");

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// —— 放行：什么都不输出，正常退出。Claude Code 视为"允许停止"。
function allow() {
  process.exit(0);
}

// —— 打回：输出 decision:block + reason，agent 会被要求继续干（这里=去沉淀）。
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

function buildReason(projectId) {
  return `🧠 本次会话有代码改动。在结束前，请把这次产生的、跨会话有用的项目知识沉淀到 project-memory。

【projectId】${projectId}

━━ 该记什么（满足：源码里读不到 + 跨会话有用） ━━
· 决策取舍（选了 A 否了 B 及原因）
· 项目约定 / 规范（命名、错误处理、目录习惯…）
· 踩坑教训（看着能改、改了会炸的地方）
· 标准写法 / 示例代码

【不该记】源码里就有的事实 / 仅本次对话的临时信息 / 通用常识 / 未经验证的猜测。
若本次确实没有上述新知识，直接走"无沉淀"回显，不要硬凑。

━━ 怎么分类（一条只归一个 kind，按"首要意图"选） ━━
· decision   —— 记录一次做了取舍的决策
· convention —— 约束"就得这么做"（规范/要求/定义）
· pattern    —— 提供可照抄的标准写法/示例
· gotcha     —— 警示风险、不能动的地方
· note       —— 以上都不沾的兜底
理由/背景/教训写进 content，不因带了它们就改 kind。
若一条里有两个各自需要被独立搜到的知识点 → 拆成两条。
title 必须清晰、自带关键词（便于将来语义搜到），如"前端表单校验约定"而非"校验说明"。

━━ 怎么做 ━━
1. 沉淀前先用关键词调 search_knowledge(projectId, query) 看是否已有同类知识：
     已存在且过时 → update_memory（更新）
     已存在且仍有效 → 跳过
     不存在 → add_memory（新增）
2. 写入时带上上面的 projectId 和选好的 kind。

━━ 最后必须回显沉淀记录（供审计，格式照抄） ━━
有沉淀时：
🧠 知识沉淀
✅ 新增 [kind] <title> (<id>)
        └ <一句话原因/要点>           ← 仅"新增"带这行
🔄 更新 [kind] <title> (<id>)
⏭️ 跳过 [kind] <title> — 已存在且仍有效

无沉淀时：
🧠 知识沉淀：本次无新知识（常规改动，无新决策/约定/教训/写法）

回显完成后即可结束，无需再做其它。`;
}

// 读 stdin（Stop hook 的输入 JSON）
function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// 读取工作空间根的 .project-memory，返回 projectId 或 null（任何异常都返回 null）
function readProjectId(cwd) {
  try {
    const p = path.join(cwd, ".project-memory");
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const id = data && typeof data.projectId === "string" ? data.projectId.trim() : "";
    return id || null;
  } catch {
    return null;
  }
}

/**
 * 判断"本回合"是否有代码改动。
 * 本回合 = transcript 中最后一条【真实用户消息】之后的所有行。
 * 判据（已用真实 transcript 核实）：
 *   - 真实用户消息：type==="user" 且 message.content 是 string
 *   - tool_result ：type==="user" 且 message.content 是 array（排除）
 *   - tool_use    ：type==="assistant"，message.content[].type==="tool_use"，工具名在 .name
 */
function turnHasCodeEdit(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return false; // 读不到 transcript → 保守放行
  }

  const records = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      records.push(JSON.parse(s));
    } catch {
      /* 跳过坏行 */
    }
  }

  // 找最后一条真实用户消息的下标
  let turnStart = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type === "user" && typeof r.message?.content === "string") {
      turnStart = i;
      break;
    }
  }

  // 从该下标起向后扫 tool_use 里的编辑类工具
  for (let i = turnStart; i < records.length; i++) {
    const r = records[i];
    if (r.type === "assistant" && Array.isArray(r.message?.content)) {
      for (const c of r.message.content) {
        if (c.type === "tool_use" && EDIT_TOOLS.has(c.name)) {
          return true;
        }
      }
    }
  }
  return false;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    return allow(); // 输入坏 → 放行
  }

  // 1. 防死循环
  if (input.stop_hook_active === true) return allow();

  const cwd = input.cwd || process.cwd();

  // 2/3. 必须是接入项目，且能拿到 projectId
  const projectId = readProjectId(cwd);
  if (!projectId) return allow();

  // 4. 本回合需有代码改动
  const transcriptPath = input.transcript_path;
  if (!transcriptPath || !turnHasCodeEdit(transcriptPath)) return allow();

  // 都满足 → 打回沉淀
  return block(buildReason(projectId));
}

main();
