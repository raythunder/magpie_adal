# Adal

[English](./README.md) · [npm](https://www.npmjs.com/package/magpie-adal) · [GitHub](https://github.com/raythunder/magpie_adal)

通过本地已安装、已登录的 [AdaL CLI](https://adal.sylph.ai)，在 [Magpie](https://usemagpie.ai) 中使用 AdaL 的模型。npm 包名：`magpie-adal`；供应商 id：`adal`。

插件采用 Magpie 支持的 OpenCode v1 格式，没有运行时依赖，也不用额外管理 HTTP 服务。登录凭据由 AdaL 自己保管，Magpie 只保存本地连接标记。

## 安装

安装 AdaL CLI **1.9.0 或更新版本**，先在终端运行 `adal` 完成登录。真实模型调用和额度查询已在 AdaL 1.9.0、Magpie 0.1.1130 验证。

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

在 **Adal** 供应商中选择 **Use local AdaL CLI sign-in**。这会检查已有的 CLI 登录状态，不发送模型查询，不要求 API key，也不复制 AdaL token。

Magpie 在 `plugin-auth.json` 中保存本地连接标记；认证和续期由 AdaL 管理。退出此供应商的登录不会退出 AdaL。

通过插件添加的账号均使用同一个本地 AdaL 登录，不支持独立的多个账号。

## 模型

选择 `adal/default` 使用 AdaL 默认模型，或选择 `adal/<model-key>` 使用指定模型。模型 key 和显示名称来自 `~/.adal/model_catalog.json`；实际可用性取决于账号权限和额度。

运行 `adal` 更新模型目录。插件会在启动请求前拒绝目录之外的 key。AdaL 可能把模型切换失败也确认成成功，因此对目录内的模型，无法保证检测到静默回退。

## 请求与工具

Magpie 将客户端请求转换为 Chat Completions。插件运行 `adal --sdk-runtime`，将 SDK v1 NDJSON 事件转换为 JSON 或 SSE。配置中的 API 地址仅用于标识接口，不是额外监听的 HTTP 服务。

- 文字对话保留 system/developer 指令、assistant 历史和工具结果。
- 无工具请求支持逐段文字流。每个请求启动新的 AdaL 会话，传入完整对话历史。
- 外部工具通过提示词中的 JSON 协议桥接。如果 SDK 对客户端提供的工具名发出权限请求，插件也会先拒绝 AdaL 执行，再将拟议调用返回给调用方 Agent。返回标准 `tool_calls` 前验证工具名和 JSON 参数；参数业务约束仍由调用方验证。
- 支持 `auto`、`none`、`required`、指定函数和关闭并行工具调用。工具回复需要等待文本或拟议调用验证后发送，SSE 不会逐字输出；JSON 回复仍取决于模型遵守桥接指令的能力。
- 启用 SDK 的逐次工具授权（`can_use_tool: true`），拒绝所有 AdaL 原生执行；限制默认工具注册作为额外保护，平台特殊工具由权限回调拦截。工具开始标记本身不会中断请求：客户端工具名只有在确认查找失败后才会转交；拒绝导致轮次结束且没有回复时，补一次纯模型回复恢复。成功或未能确认的原生结果仍会报错。每次在临时工作目录执行，不传入客户端项目，也不使用 `--yolo`。
- 支持请求取消、响应流取消、超时和进程清理。

不支持图片、音频、视频。不传递 `temperature`、`top_p`、`max_tokens`、`stop`、`seed`、`response_format` 或推理档位，使用 AdaL 自己的模型配置。不伪造 token 用量或费用。

## 额度与用量

Magpie 的供应商额度面板可查看套餐、本周已用百分比、周额度重置时间和钱包余额。也可以查询：

```sh
magpie quota adal
magpie quota adal --json
```

查询启动短暂的已认证 SDK 进程，仅定位该进程组的本地后端，读取 `/auth/usage` 后关闭进程。不发送模型请求，不读取或复制登录 token。需要 AdaL **1.9.0+** 和 `lsof`：macOS 自带，Linux 需另行安装。目前不支持 Windows 额度查询。

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

CLI 按 `cliPath` → `ADAL_RUNTIME_PATH` → `~/.adal/bin/adal` → PATH 中的 `adal` 查找。`cliPath` 是可执行文件路径，不是 shell 命令。`timeoutMs` 必须为至少 1000 的整数，默认五分钟。默认每账号并发 1；请求体上限 4 MiB，SDK 输出上限 16 MiB。

AdaL 继承本地环境，Magpie 的供应商代理设置不会自动传给 CLI。临时工作目录会清理，但 AdaL 可能在 `~/.adal/sessions` 保留会话记录。

## 开发与验证

开发脚本需要 Node.js **22+**。无需运行 `npm install`；Magpie 使用 Bun 加载插件。

```sh
npm test
npm run test:magpie
npm run test:quota
npm pack --dry-run
```

`test:magpie` 在独立 HOME/XDG 目录中使用假的 AdaL，不修改现有 Magpie 配置。不同安装位置可设置 `MAGPIE_BIN`。`test:quota` 使用真实 AdaL 账号，但不发送模型查询。

真实模型检查会发送三次小型查询，消耗 AdaL 额度：

```sh
npm run test:live
ADAL_TEST_MODEL=<model-key> npm run test:live
```

检查覆盖登录、SSE、外部工具调用和含工具结果的后续对话，不执行返回的工具。集成依赖 AdaL SDK 内部协议，升级 AdaL 后请重新验证。

开发依据：[Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins)、[社区插件示例](https://github.com/magpie-community/plugins)、AdaL [SDK 参考](https://docs.sylph.ai/integration/sdk/api-reference)、[模型](https://docs.sylph.ai/getting-started/models)和[额度说明](https://docs.sylph.ai/getting-started/pricing-and-usage)。协议和额度字段也核对了本地 CLI 源码。

## 许可

[MIT](./LICENSE)。
