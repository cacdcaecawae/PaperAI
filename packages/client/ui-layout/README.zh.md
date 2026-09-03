# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

外壳插件：三栏 AppFrame（拖动手柄与让步链）加 `ctx.layout` 面板切换服务；它注册到运行时拥有的 `root` slot，并声明 `sidebar`、`conversation`、`details` 和 `shell.overlay`。侧边栏的缩放边界是不可见命中条带，详情栏边界则保留其浮动胶囊。关闭的侧边栏仍保留 56px 控制栏，详情栏则关闭到零宽度。

可选 `Config` 字段 `centerMin`、`detailsMin`、`detailsDefault` 和 `detailsMax` 都是以 CSS 像素为单位的正整数。其默认值依次为 `640`、`300`、`360` 和 `520`；必须满足 `detailsMin <= detailsDefault <= detailsMax`，否则插件加载失败。详情栏会在保留 `centerMin` 的前提下向 `detailsMin` 收缩。拖动详情栏时会按配置范围限幅，打开已关闭的详情栏时则使用 `detailsDefault`。

`detailsVisibility` 控制哪种当前 Session 可以保留已打开的详情栏。默认值 `nonblank-session` 保持 DSH 行为：hero、无 Session 和 blank Session 状态都将详情栏渲染为零宽度，但不会改动存储的宽度偏好。`current-session` 还允许 blank 的当前 Session，因此产品插件可以在首次非 blank Agent 回合之前调用 `ctx.layout.openDetails()`；该选项本身不会创建 Session，也不会打开面板。切换到另一个符合条件的 Session 时，详情栏仍会在绘制前关闭。

`detailsNarrowMode` 控制已打开的详情栏无法与 `centerMin` 和 `detailsMin` 共存时的布局。默认值 `close` 将详情栏渲染为零宽度，并把剩余空间交给中栏。`focus` 保留当前侧栏，将仍保持挂载的中栏设为不可交互的零宽度，并让详情栏占用其余空间。聚焦模式继续沿用侧栏原有的断点、展开收起和拖动行为。两种模式都保留已存储的宽度偏好，并在三栏重新容得下时自动恢复分栏。与窄屏兜底无关，产品可以在详情栏打开时通过 `ctx.layout.setDetailsFocus(active)` 在任意视口宽度下主动要求同样的聚焦呈现；关闭详情栏即释放该要求，宽度偏好始终不被改写。

AppFrame 始终挂载会话栏和详情栏的位置。布局 store 是瞬时状态，侧边栏以默认宽度启动，详情栏则保持关闭，且该 store 从不读写 `localStorage`。会话 owner share 为空，侧边栏 owner share 只包含 `collapsed` 和 `width`；注册方通过标准钩子获取业务数据，并从各自的 inject 接口获取操作。

该包还提供主题呈现器：它消费解析后的 `ctx.theme` 快照，并将其投影到 document（用 `html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，并将主题的别名 token 设为 body 上的内联变量，同时拥有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新）。在应用调色板和 token 后进行测量，可确保渲染后的背景成为唯一的颜色依据；呈现器在 dispose（资源释放）时会移除其自有的元数据节点，并一并清除其写入的其他全局状态。

根入口与 `/client` 入口导出有类型的布局 `Config`、`DetailsNarrowMode`、`DetailsVisibility` 和 `LayoutGeometry` 契约。`/client` 还导出插件主体（`apply`／`inject`）、`LayoutController` 和四个 owner-share 接口。AppFrame、面板 store 与让步求解器仍属于包内部。

## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **面板几何信息是瞬时状态**：重新加载会恢复侧边栏默认值，并使详情栏保持关闭；在不同且符合条件的 Session id 之间切换同样会关闭详情栏，并忘记拖动后的宽度，而不符合条件的状态会以零宽度渲染详情栏，但不会修改几何信息。
- **详情栏可用条件不会打开面板或提供 Session**：`current-session` 只允许 blank 的当前 Session 保留已经打开的详情栏宽度偏好。
- **渲染几何可能与存储偏好不同**：让步、关闭模式和聚焦模式都由当前 frame 推导；消费方必须使用 frame 提供的 owner props，不能把已存储宽度视为实际渲染宽度。
- **挤压重排期间不提供滚动锚定**：布局变化可能移动读者的 viewport。
