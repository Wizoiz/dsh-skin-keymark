# Changelog

## 0.1.9 — 2026-11-02

### Added

- **「全窗铺开」开关**（皮肤面板 → 界面透明 / 文字配色，默认开启）。开启后皮肤不再只覆盖对话画布，而是推到侧栏、各类面板、菜单、悬停态与窗口标题栏拖拽带。
- 面板透明度改为**从画布透明度推导**：`max(画布 alpha + 各自抬升量, 各自地板)`。壁纸越透、面板跟着越透，两者永远联动。

### Changed

- `CONTENT_TOKENS` 由 17 项扩到 26 项，新增：
  - 交互面：`--dsw-alias-interactive-bg-hover`、`-hover-accent`、`-hover-solid`、`-active`
  - 侧栏导航行：`--dsw-specific-sidebar-nav-item-active`、`-hover`
  - 模块板与横幅：`--dsw-alias-bg-module-platform`、`--dsw-alias-markdown-code-block-banner`、`--dsw-alias-menu-group-header-fill`
  - 浮层：`--dsw-alias-tooltip-bg`、`--dsw-alias-tooltip-key-bg`、`--dsw-alias-toast-bg`
  - 第四层：`--dsw-alias-bg-layer-4`
- 铺开模式下侧栏只比画布实 3%（原 10%），消除毛玻璃接缝；侧栏地板由 0.55 降到 0.20。

### Fixed

- **只有对话区有皮肤**：旧公式 `max(1 - 内容层透明强度, 地板)` 在默认强度 0 时恒等于 1，等于一个像素都不动。这是公式级原因，不是样式没写对。
- **侧栏被第三方实底吃掉**：新增私有变量 `--km-side-fill` / `--km-canvas-fill` 回指，绕开 `dsh-claude-style` 在元素级重声明 `--dsw-specific-sidebar-fill`（元素级声明压过 body 继承）。
- **误伤 iframe**：结构性透明层选择器加 `:not(iframe)`，避开 `dsh-univer-office` 文档预览器的 `uvf_frame`。
- 卸载时同步清理铺开层的私有变量，不留无人读取的声明。

## 0.1.8 — 2026-10-22

- 与 `dsh-claude-style` 的共存握手：打 `data-we-wallpaper` 标记，压掉对方盖在壁纸上的画布罩布。
- 分部位透明度系数（气泡 / 输入卡 / 菜单 / 代码块）。
- 界面主题包、强调色、面板毛玻璃。
