# Agent Note: PaperAI 名册：原生 DSH 引擎与两个 ACP 通道并列

Status: implemented

[English](2026-09-17-paperai-native-engine-in-roster.md) | 中文

## Problem

自[ACP 通道决策](../architecture/2026-09-08-paperai-acp-channels.zh.md)起，PaperAI 启动器把产品自有 preset 根目录过滤成只剩 `codex` 与 `claude`，而[产品档案笔记](../architecture/2026-08-28-paperai-product-profile.zh.md)称原生引擎"保留给显式部署配置"。这条路径并不存在：`apps/cli/src/profile-boot.ts` 里的 `composeProfile` 在 home patch 与所有 `--patch` 覆盖层之后追加启动器的 roots 覆盖层并覆盖 `roots`，任何部署都无法把 `dsh` preset 加回来。选择器只剩两项，且因程序贡献的 preset 不带描述而都显示"暂无描述"；想用自有模型 API 写作的人没有任何引擎可选。`packages/bundle/paperai-web/config/agent-presets/` 下完整的 `dsh` 组装一直随包发布却无人可用。

## Decision

PaperAI 档案发现整个产品自有 preset 根目录。`profilePresetRoots('paperai')` 返回不带 id 过滤的根目录，选择器按各自声明的 `order` 列出三个引擎：`DSH 标准`、`Codex`、`Claude`。Codex 仍是部署默认值；用户 preset 根目录仍关闭。

每一项的文案都是一句短话，说明的是通道而非人设：原生引擎为"自定义模型，直连 API。"，两个通道为"本地 Codex ACP 通道。"与"本地 Claude ACP 通道。"。原生引擎的文案写在其 `preset.yml` 里；通道的文案作为 `description` 放在 `@paperai/agent-acp` 的 `ACP_TEMPLATES` 上，`PaperAiAcpAgents` 注册贡献 preset 时一并传入。贡献会遮住同 id 的文件 preset，因此两个通道的 `preset.yml` 也写同一句话，供未组装 ACP 插件的组合使用。

**互不干扰。** 三个引擎只共享名册、项目规程与版本账本。原生会话在 DSH Loop 上挂载 `dsh` 组装（写作人设、`agent-instructions`、`@paperai/tool-document` 与标准行），使用随附的模型目录和 设置 → 模型 里的 DeepSeek 凭据；Host 的 `acpSession` 对它回答 `null`，因此 ACP 会话控件在其头部不渲染任何内容。ACP 会话经通道贡献的工厂路由创建，从不挂载 `dsh` 行。ACP 设置页仍只列出两个通道；通用 preset 设置行提供完整名册供设置默认值。

本决策在名册方面部分取代[产品档案笔记](../architecture/2026-08-28-paperai-product-profile.zh.md)，在 PaperAI 开放哪些引擎方面部分取代[ACP 通道决策](../architecture/2026-09-08-paperai-acp-channels.zh.md)；两者的其余决策保持不变。

## Alternatives considered

**保留过滤，改为尊重部署的 `roots`。** 让 home patch 覆盖启动器的覆盖层能让文档描述的路径成真，但随包产品仍缺这个引擎，且所有档案都会继承一条为单一档案写的合并规则。名册是产品事实，直接发布比记录一份 patch 更简单。

**从文件 preset 推导通道文案。** 在 `dsh-agent-presets` 内把贡献与同 id 的已发现 preset 合并，会把 PaperAI 的文案塞进共享注册表，并改变所有档案依赖的规则。模板表已经拥有每个通道的名称，描述放在旁边即可。

**保留长描述。** 它们在菜单里复述人设；菜单是用来选通道的，一句话足够。

## Consequences

选择器重新提供原生引擎，文案按用户要求缩短，启动器不再带无用的 `ids` 管道。`apps/cli/tests/profile-preset-roots.spec.ts` 固定三个 id，`apps/web/tests/paperai-dsh-preset.e2e.ts` 固定原生组装与 `null` 的 ACP 回答，`agent-presets` 浏览器 golden 固定通道文案。原生引擎需要在 设置 → 模型 里填入 DeepSeek key，因为 PaperAI 关闭了首次运行的凭据对话框；全新安装仍以 Codex 打开。
