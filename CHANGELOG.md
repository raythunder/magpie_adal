# 更新记录

## 0.3.0

- 模型请求改为直接访问 AdaL 云端代理，沿用原工具的认证、路由、客户端标识、Base64 编码和目录参数。
- 按模型声明 Anthropic Messages、OpenAI Responses、Chat Completions 和 Gemini 原生协议，保留图片能力、推理档位、签名、工具结构和真实 token 用量。
- 移除提示词 JSON 工具桥接、AdaL Agent 查询和工具拒绝后的恢复查询；SDK 仅用于认证、模型核对和额度查询。
- 云端始终流式调用，非流式结果复用社区 Zed 插件的合并逻辑。
- 核对实际模型与计费来源，拒绝静默回退和 BYOAK/关联订阅转为 AdaL 计费。
- 请求体按读取字节数限制大小，并在超时或取消时停止读取；SDK 父进程提前退出后仍清理持有管道的后代进程。
- 非流式 Anthropic 回复保留 `citations_delta` 中的文档引用。
- 保留 `adal` 供应商、原有目录 key 和 `local-cli` 登录标记。升级后须重新加载插件，以刷新原生 API 配置。
- 最低验证版本调整为 AdaL 1.10.3；认证、模型调用及额度查询需要 macOS/Linux 与 `lsof`。
