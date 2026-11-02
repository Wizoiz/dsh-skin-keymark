# Changelog

## 0.1.10 — 2026-11-02

本轮只做「不改外观、只减少无效工作」的改动：可见像素与 0.1.9 一致。

### Added

- 分部位透明度由 **4 组扩到 7 组**：新增「侧栏行」「全局悬停态」「提示气泡 / toast」。此前 26 个令牌里有 14 个在面板上没有对应控件，拖任何滑条都影响不到它们（死控件）。
- 系统「降低透明度」（`prefers-reduced-transparency`）现在会被尊重：只停用全窗铺开这一层，壁纸本身仍按不透明度透出。系统设置变化实时生效，卸载时正确拆除监听。

### Changed

- 拖动任何滑条由「每个像素一次全量 `applyAll()`」降为「每帧一次」。数值框输入与双击复位仍走同步路径 —— 延迟一帧会让「点一下没反应」的错觉回来。
- `applyAll()` 的 8 个引擎改为按输入签名门控，输入没变就跳过。`applyWallpaper` 与 `applyTokens` 刻意保持无条件：前者是 `data-we-wallpaper` 握手与轮播计时的唯一入口，后者负责铺开层的挂 / 拆。
- 壁纸元素的 `style.cssText` 与渐变规则的 `<style>` 文本在内容未变时不再重写。

### Fixed

- **换素材后指针环绕失灵**：`orbit` 引擎的签名里含「壁纸元素是否存在」，图片换视频时该项恒为真，导致引擎永不重跑。改用元素标签名，并纳入 `prefers-reduced-motion`。
- **换壁纸后可能白屏**：壁纸元素被销毁时，内存里「上次画了什么」的记账必须一起作废，否则新元素拿到同样的样式会被跳过。
- 卸载时补拆 `prefers-reduced-transparency` 的 `matchMedia` 监听（此前只在安装侧注册）。

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
