# Agent Note: Workspace 列表到详情的导航

Status: implemented

[English](2026-08-30-workspace-detail-navigation.md) | 中文

## 问题

Workspace 原地展开时，项目资源会插在 Workspace 行与 Session 行之间。项目操作、资源类别和同级 Workspace 共用一个树层级；随着 PaperAI 加入文档、模板、实验和后续项目资源，侧边栏的层级会变得含混。

## 决策

分组侧边栏是一份 Workspace 列表。用户通过指针、Enter 或 Space 激活真实 Workspace 行后，会在同一侧边栏区域中打开二级详情视图。页头把紧凑的返回操作与 Workspace 标题、规范路径副标题组合在一起；返回操作会把焦点恢复到来源 Workspace 行。可叠加的 `sidebar.workspaces.content` 条目自行负责项目区段标题；`ui-workspace` 在同一个滚动区域中提供相匹配的 Session 标题与局部新建 Session 操作。内容 slot 无占用方时不会渲染空项目区段。

`ui-workspace` 负责导航、Session 展示、焦点行为和可叠加详情 slot。`ui-paperai-workbench` 等资源插件仍然只负责自身的资源区段与操作。Ungrouped 没有 Workspace 身份或项目资源，因此继续作为披露行。搜索和扁平 Session 展示仍是全局替代视图，不会嵌入详情。

详情沿用现有侧边栏的行密度、语义主题别名、共用图标、焦点轮廓和短促 hover 过渡。资源或 Session 为空时会指明用于创建第一项的操作。导航状态属于本地查看状态：返回列表或切换到扁平展示会退出详情，但不会改变已选 Session。

组件覆盖固定了指针与键盘进入、返回导航与焦点恢复、slot owner 数据、空状态、Session 操作、排序和焦点语义。无密钥浏览器快照会启动 PaperAI Web 组合，并固定带有真实投影文档资源的组装后 Workspace 详情。

## 考虑过的替代方案

**保留原地展开。** 这种方式可以保留原有树机制，但会继续把项目资源与同级 Workspace、Session 行混在一起；每增加一个资源类别，含混程度都会上升。

**由 PaperAI 通过内容条目渲染覆盖层。** slot 占用方无法负责浏览器页头、同级 Session 行和返回导航；若绕过 slot 所有权，就会让通用 Workspace 交互耦合到单一产品插件。

**引入独立页面路由。** 该交互局限于一个侧边栏区域，不需要浏览器历史语义。本地二级视图可以保留外壳与 Session 选择，同时减少全局状态。

## 后果

Workspace 行成为导航目标而非披露控件，Ungrouped 则保留披露语义。资源插件获得稳定的项目级组合区域；随着类别增加，Workspace 列表仍能保持紧凑。用户在同级 Workspace 之间切换时需要额外执行一次返回操作；全局搜索在查询有效期间会有意替代详情。
