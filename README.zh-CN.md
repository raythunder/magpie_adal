# Adal

[English](./README.md) · [npm](https://www.npmjs.com/package/magpie-adal) · [GitHub](https://github.com/raythunder/magpie_adal)

通过本地已安装、已登录的 [AdaL CLI](https://adal.sylph.ai)，在 [Magpie](https://usemagpie.ai) 中使用 AdaL 的模型。npm 包名：`magpie-adal`；供应商 id：`adal`。

插件采用 Magpie 支持的 OpenCode v1 格式，没有运行时依赖，也不用额外管理 HTTP 服务。登录凭据由 AdaL 自己保管，Magpie 只保存本地连接标记。插件沿用 AdaL 云端模型代理，直接传递供应商原生请求，不经过 AdaL Agent 的提示词和工具循环。

## 安装

安装 AdaL CLI **1.10.3 或更新版本**，先在终端运行 `adal` 完成登录。当前实现核对了 AdaL 1.10.3，并在 Magpie 0.1.1318 验证。升级 AdaL 后应重新运行真实检查。

从 0.2.x 升级后，在 Magpie 中关闭再打开插件，刷新各模型使用的原生 API；原有 `adal/default`、`adal/<model-key>` 和本地登录标记继续使用。

在 Magpie 中打开「插件 → 添加插件」，输入：

```text
magpie-adal
```

也可以使用 Magpie CLI：

```sh
magpie plugin add magpie-adal
magpie plugin login adal
magpie provider test adal default
```

从 GitHub 安装：

```sh
magpie plugin add github:raythunder/magpie_adal
```

本地开发时，可将项目克隆到名为 `Adal` 的文件夹，再添加该文件夹：

```sh
git clone https://github.com/raythunder/magpie_adal.git Adal
magpie plugin add "$PWD/Adal"
```

从文件夹安装时，插件列表第一行显示文件夹名，第二行显示供应商名称 **Adal**。从 npm 安装时，第一行可能显示包名。官方市场里的友好名称来自市场注册表；本项目单独分发。

macOS 没有把 `magpie` 加入 PATH 时，可将命令中的 `magpie` 替换为 `/Applications/magpie.app/Contents/MacOS/magpie`。修改本地插件文件或刷新模型目录后，在应用里关闭再打开插件。

## 登录

在 **Adal** 供应商中选择 **Use local AdaL CLI sign-in**。这会通过原工具的 SDK 检查 CLI 登录状态，不发送模型查询，也不要求 API key。

Magpie 在 `plugin-auth.json` 中仅保存 `local-cli` 标记。每次模型请求先启动已认证 SDK，再临时读取 `~/.adal/adal_oauth_creds.json` 中的凭据（或沿用原工具的 `ADAL_AUTH_TOKEN`），仅在内存中向 AdaL 自己的代理使用，不写入 Magpie 配置或日志。SDK 或代理拒绝认证时，重新运行 `adal` 登录；插件不另建登录或续期机制。退出此供应商不会退出 AdaL。

通过插件添加的账号均使用同一个本地 AdaL 登录，不支持独立的多个账号。

## 模型

选择 `adal/default` 使用目录中的默认模型，或选择 `adal/<model-key>` 使用指定模型。名称、模型 API id、上下文上限、默认参数和推理档位来自 `~/.adal/model_catalog.json`。运行 `adal` 更新目录，再重新加载插件。

支持 AdaL 云端的 Anthropic、MiniMax、OpenAI、xAI、DeepSeek、Meta、Kimi、Z.ai、Qwen 和 Google 模型，按原工具的 model client 选择协议：

| 协议 | 供应商 | Magpie AI SDK |
| --- | --- | --- |
| Anthropic Messages | Anthropic、MiniMax | `@ai-sdk/anthropic` |
| OpenAI Responses | OpenAI、xAI、DeepSeek、Meta | `@ai-sdk/openai` |
| Chat Completions | Kimi、Z.ai、Qwen | `@ai-sdk/openai-compatible` |
| Gemini generateContent | Google | `@ai-sdk/google` |

本地模型和 ChatGPT 关联订阅不列入直连目录。每次请求还会核对 SDK 实际选择的模型和 `connection_mode`；BYOAK 或第三方凭据路径会明确拒绝，请使用 AdaL CLI，避免静默改变计费来源。目录不代表账号一定有权限或剩余额度。

## 请求与工具

Magpie 将客户端请求转换为所选模型的原生 API。插件通过短暂的 `adal --sdk-runtime` 会话完成认证、模型选择和配置核对，**不向 SDK 发送 `query`**。模型请求直接发往 AdaL 原工具使用的 `/proxy` 路径，沿用 JWT、供应商目标地址、会话和客户端标识头，以及 Base64 请求体编码。配置中的回环 API 地址仅是接口标识，不监听额外服务。

- 直接保留原生 system/developer 指令、历史消息、图片、工具定义和工具结果；图片支持由目录声明。
- 原生 `tool_use` / function call 由调用方 Agent 执行。没有提示词 JSON 工具桥接，也没有 AdaL 原生工具执行或恢复查询。
- 默认使用 AdaL 目录中的模型参数，并应用 SDK 的有效推理档位；调用方明确提供的原生参数优先。`max_input_tokens` 仅用于本地限制，不传入模型 API。
- 与原工具一致，云端始终流式请求；流式调用直接转发供应商事件，非流式调用合并为供应商完整回复，保留工具参数、推理签名和真实 token 用量。合并逻辑复用社区 Zed 插件，许可见 [第三方说明](./THIRD_PARTY_NOTICES.md)。
- 支持请求取消、响应流取消、超时、进程清理及不完整流检测；保留上游错误状态和 `Retry-After`。不伪造 token 用量或费用。

参数组合仍须符合供应商规则，例如 Anthropic 开启 adaptive thinking 时不能强制特定工具。插件不会为了绕过限制而静默关闭推理。音频、视频和图片生成不属于本插件的聊天接口。

实际验证覆盖 Anthropic 文本流、非流式原生工具调用及工具结果回传，以及 OpenAI、Google、Kimi 的文本流；其他映射依据本地 AdaL 1.10.3 源码，尚未逐一发送真实查询。Magpie 0.1.1318 的 `provider test` 会将 Google 探测误发为 Chat，不能用该探测判断 Gemini 原生路径；使用下方真实检查。

## 额度与用量

Magpie 的供应商额度面板可查看套餐、本周已用百分比、周额度重置时间和钱包余额。也可以查询：

```sh
magpie quota adal
magpie quota adal --json
```

查询启动短暂的已认证 SDK 进程，仅定位该进程组的本地后端，读取 `/auth/usage` 后关闭进程。不发送模型请求，不读取或复制登录 token。认证、模型连接和额度查询都需要 `lsof`：macOS 自带，Linux 需另行安装。目前不支持 Windows。

钱包余额沿用 AdaL `/usage` 的 `$` 单位，`$0.00` 不表示套餐内周额度已经用完。用量覆盖整个 AdaL 账号，包括直接使用 CLI 的消耗；不推算接口未提供的月度用量。

周额度仅用于展示，不据此停用所有模型，因为 BYOAK 或关联订阅仍可能可用。查询失败时显示错误，不把缺失数据当成零；只有认证被拒绝时才标记登录过期。

## 配置

通常无需配置。Magpie 的插件选项支持：

```json
{
  "cliPath": "/absolute/path/to/adal",
  "timeoutMs": 300000
}
```

CLI 按 `cliPath` → `ADAL_RUNTIME_PATH` → `~/.adal/bin/adal` → PATH 中的 `adal` 查找。`cliPath` 是可执行文件路径，不是 shell 命令。`timeoutMs` 必须为至少 1000 的整数，默认五分钟。默认每账号并发 1；请求体上限 4 MiB，SDK 初始化输出上限 1 MiB，模型响应上限 16 MiB。

云端模型请求使用 Magpie 插件宿主的 `fetch`，遵循其供应商/账号代理设置。CLI 认证和目录同步仍由 AdaL 自己的运行环境联网。`ADAL_PROXY_URL`、`ADAL_APP_URL`（旧版为 `BACKEND_API_URL`）按原工具约定选择平台地址；仅允许 HTTPS，回环调试地址可用 HTTP。临时工作目录会清理；SDK 启动仍可能产生 AdaL 自己的会话元数据。

## 开发与验证

开发脚本需要 Node.js **22+**。无需运行 `npm install`；Magpie 使用 Bun 加载插件。

```sh
npm test
npm run test:magpie
npm run test:quota
npm pack --dry-run
```

`test:magpie` 在独立 HOME/XDG 目录中使用假的 SDK 和本地云端代理，验证 Magpie 加载、登录、额度、Anthropic、Responses 和 Chat 路径，以及真实隔离网关的 Gemini 翻译和原生工具往返，不修改现有配置。不同安装位置可设置 `MAGPIE_BIN`。单元测试还覆盖 Gemini、凭据重新读取、计费来源保护、取消、超时和流截断。`test:quota` 使用真实 AdaL 账号，但不发送模型查询。

真实模型检查会发送三次小型查询，消耗 AdaL 额度：

```sh
npm run test:live
ADAL_TEST_MODEL=<Anthropic-model-key> npm run test:live
ADAL_TEST_MODEL=<other-model-key> npm run test:live -- --text-only
```

完整检查覆盖登录、SSE、非流式原生工具调用和含工具结果的后续对话，不执行返回的工具。`--text-only` 只发送一次文本查询，可用于其他原生协议。集成依赖 AdaL SDK 和云端代理协议，升级 AdaL 后请重新验证。

开发依据：[Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins)、[社区插件示例](https://github.com/magpie-community/plugins)、AdaL [SDK 参考](https://docs.sylph.ai/integration/sdk/api-reference)、[模型](https://docs.sylph.ai/getting-started/models)和[额度说明](https://docs.sylph.ai/getting-started/pricing-and-usage)。协议和额度字段也核对了本地 CLI 源码。

## 许可

[MIT](./LICENSE)。
