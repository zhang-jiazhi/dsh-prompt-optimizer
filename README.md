# dsh-prompt-optimizer

> [!IMPORTANT]
> 本项目是将原作者 **linshenkx** 的
> [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer)
> 移植到 DSH（DeepSeek Harness）的第三方插件，并非原项目的官方 DSH 版本。
> 核心优化模板与设计归功于原作者；本仓库主要实现 DSH Host、Client 与设置系统集成。

本插件移植 `prompt-optimizer`（AGPL-3.0）的核心优化模板，去掉评估、对比、迭代、变量、图像生成对接等功能，只保留一件事：**把输入框里的提示词一键优化好**。

参考了 [seven282/oss-prompt-optimizer](https://github.com/seven282/oss-prompt-optimizer) 的宿主/客户端结构。

## 功能

- **入口**：输入框工具行、权限选择器右侧：`[基础|上下文|图像 ▾] [模板 ▾] [✨]`
  - 类别下拉：基础 / 上下文 / 图像
  - 模板富下拉：展示模板名称与一句话描述（对齐参考成品的选项样式）
  - ✨ 按钮：点击优化输入框草稿并写回；**优化中再点取消**（断开请求，宿主同步中止模型调用）；成功后按钮变 ↺，草稿未被手动编辑时可一键恢复原文
- **模板目录**（提取自 prompt-optimizer 默认模板，做了精简改写）：
  - 基础：任务指令优化（推荐，默认项）/ 需求步骤化规划 / 系统提示词优化（角色卡）/ 系统提示词优化-带输出格式 / 系统提示词分析式优化 / OpenClaw-SOUL 结构化模板
    - **任务指令优化 / 需求步骤化规划**：对应上游 `user-optimize`（用户提示词）模式，把输入框草稿改写成发给助手的任务指令——保持「用户说的话」的身份，不生成角色卡，不编造报错/路径/环境等原文没有的事实，缺失信息只写成「待确认」。默认就用这个。
    - **系统提示词优化系列**：对应上游 `optimize`（系统提示词）模式，产出 `# Role / ## Profile / ## Skills` 角色卡，用于给新会话或新智能体定义角色；把它的结果直接发给助手等于给助手一份人设而不是一个任务，因此不再作为默认项。
  - 上下文：通用消息优化（推荐）/ 分析型优化（技术场景）/ 格式化优化（数据场景）——自动携带当前会话**最近**的对话作为背景（best-effort；优先读取 DSH 的 canonical surface，旧 host 才回退原始会话事件；取尾部 80 个事件里的最后 N 条对话，N 由设置项控制且最多 200 条）
  - 图像：通用自然语言 / 摄影向 / 解构创造性 / 中文美学（文生图）+ 通用编辑优化（图生图）
- **模型调用**：走 DSH 宿主 `ctx.llm` 服务，默认跟随 DSH 默认模型，不直连任何 API、不触碰凭据；提供方与模型 ID 同时填写时覆盖默认路由
- **请求边界**：仅接受 loopback、同源请求；请求体有大小上限；客户端断开会中止模型流；上下文读取与模型执行均受可清理 deadline 约束，兼容忽略 `signal` 的旧适配器
- **设置页**：设置 → 侧边栏「提示词优化」独立分区，可配：模型提供方/ID（覆盖默认路由）、采样温度、输出 token 上限、超时、输入长度上限、上下文条数与字符预算；改动即时生效并持久化。`settingsScope` 按可选服务注入，缺失时工具栏仍可用

## 安装（本地插件）

```bash
# 1. 克隆到 DSH 本地插件目录
git clone https://github.com/zhang-jiazhi/dsh-prompt-optimizer.git \
  "$HOME/.dsh/local-plugins/dsh-prompt-optimizer"

# 2. web profile 挂依赖 + 加入 bundles（~/.dsh/profiles/web/package.json）
#    dependencies:  "@local/dsh-prompt-optimizer": "link:<上面的绝对插件路径>"
#    dsh.profile.bundles 追加: "@local/dsh-prompt-optimizer"
cd ~/.dsh/profiles/web && pnpm install

# 3. 停止旧进程后重新启动 web
dsh web
```

## 测试

```bash
npm test          # 宿主 + 客户端兼容性/生命周期验证，无需启动 web
```

- `test/host-smoke.mjs`：路由注册、模板目录、三类模板渲染、默认/自定义模型路由、settings 生效与数值钳制、
  取消、超时、越权 403、canonical surface 优先读取、坏 JSON/413 body 边界、响应 listener 清理，及请求/模型 deadline 回归。
- `test/client-smoke.mjs`：用最小 React/DOM 替身加载 `lib/client.js`，验证两个插槽注册、
  可选 `settingsScope`（undefined / null / 无 `.bind`）兼容、服务晚到时的嵌套 bind，以及 dynamic-like facade
  不支持 nested inject 时仍保留工具栏。
- `test/client-lifecycle-smoke.mjs`：验证等待期间手动编辑不被覆盖、取消后立即重试、切换会话、卸载组件时的
  AbortController 与 request identity 防护，旧响应不能写入新草稿。

> 替身实现的两个细节是刻意的，别"简化"掉：`fakeRes` 提供 `on('close')` 与
> `writableEnded`，`fakeReq` 在读完 body 后立刻触发 `close`——真实 Node 的顺序就是
> `end → close`。替身省掉这些，取消路径的断言会变成假绿（本插件的 P0 正是这样漏过一轮）。

本地 Node 合成会话基准（不含 `sessionQuery` 后端磁盘读取与真实 LLM）：尾窗投影 60 / 5000 事件请求 p50 约 0.02 ms、p95 约 0.04 ms；算法只处理最后 80 个事件。真实会话读取仍由 DSH persistence/query 服务负责，底层读取不可取消时插件只保证自身 handler deadline，不保证后台存储工作立即停止。

## 选模板的原则

| 你要做的事 | 选哪个 |
|---|---|
| 把输入框里这句话变成更清楚的任务，发给助手干活 | 基础 → 任务指令优化（默认） |
| 需求复杂，希望助手按步骤推进 | 基础 → 需求步骤化规划 |
| 结合本会话最近对话再润色这条消息 | 上下文 → 通用消息优化 |
| 给新会话/新智能体写系统提示词（角色卡） | 基础 → 系统提示词优化系列 |
| 文生图 / 图生图提示词 | 图像 → 对应模板 |

## 模板改写说明

原项目模板经 `TemplateProcessor` 用完整 Mustache（循环 / lambda / 定界符切换）渲染。本插件**不移植 Mustache**，模板提取时已归一为白名单变量约定：

- `{{originalPrompt}}` 原提示词（`{{json:originalPrompt}}` 为 JSON 转义形态）
- `{{对话上下文}}` 会话最近对话（仅上下文类模板）
- 其余 `{{…}}`（输出格式示例中的占位符）渲染时原样保留

三个上下文类模板原版的 user 消息依赖 `{{#conversationMessages}}` 循环与 `helpers.toJson`，已改写为等价的扁平「证据」协议。

## 来源、致谢与协议

- 原项目与原作者：[linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer)
- DSH 插件结构参考：[seven282/oss-prompt-optimizer](https://github.com/seven282/oss-prompt-optimizer)
- 模板文本源自原项目；本项目保留原项目归属并同样以 AGPL-3.0 发布，详见 [LICENSE](./LICENSE)
