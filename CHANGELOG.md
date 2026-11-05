# Changelog

## 0.1.11 — 2026-11-05

两批改动：① 遮挡门控（不改外观，可见像素与 0.1.10 一致）；② 入口从侧栏底部按钮迁到设置页，面板九个分区合并成四个。滑条值与壁纸像素都不变，变的是「去哪儿调」。

### Added

- **入口迁到 设置 → 皮肤**：注册改为宿主的 `settings.section` 插槽（`id: "keymark"`、`order: 40`），侧栏底部的调色盘按钮与其整套防遮挡守卫（`installTriggerGuard` 等 50 余行）一并删除。宿主的 `settings.launcher` / `settings.trigger` 都是 `kind: "single"`，插件占用会与已注册方冲突，`settings.section` 是唯一可用的通道。
- **搬家而不是重画**：面板 DOM 只有一份，第一次需要时建好，之后设置页把它搬进自己的容器并打 `data-hosted="true"`，切走时搬回 `document.body`。若改成「按分区重建」，`syncPanel()` 里几十个 `refs.*` 回读点全部要重写，且每次切页都会丢滚动位置与 textarea 草稿。
- **面板九个分区合并成四个**：壁纸 / 本地素材库 / 外观 / 高级。原「预设」只写「标注字体颜色」那六个键（`native` 全空 = 每行「继承」），是同一批数据的第二套 UI，已下沉为该分区末尾一行；原「更新检查」「主题包」与皮肤无关，收进默认折叠的「高级」。原「界面透明 / 文字配色」一节 13 个控件混了透明 / 字体 / 配色 / 玻璃四类语义，现按语义拆成三个小节并归到「外观」。
- **遮挡时停掉所有周期性开销**：窗口被别的最大化窗口盖住（或切到别的标签 / 最小化 / 用电电池）时，除了视频停播，还一并停掉三条「看不见却仍在跑」的工作：
  - 自动可读性的 **8 秒帧回读**（drawImage + getImageData，每次都会打断硬解流水线）；
  - **渐变壁纸的漂移动画**（42 s 无限循环）；
  - **自动轮播换图**（换图要解码新素材并抓帧做过场）。
  切回前台后自动恢复，轮播最多顺延一个周期。漂移停下时**画布尺寸仍保持 220%**，只是不再位移，因此停 / 启那一帧构图不跳变。

### Fixed

- **渐变壁纸不受遮挡门控管**：`installPowerGuard()` 原本只在视频分支调用，渐变壁纸从不注册 focus / blur 与 visibilitychange，`windowFocused` 永远停在初值 `true`，门控永远不会翻转。现在提到 `applyWallpaper()` 通用路径（幂等，视频分支原有的调用保持不变）。

- **设置页里的排版塌陷**：面板被接走后仍是 `position:fixed` + `translateX(102%)` + `z-index:2147483000`，会在设置页内部再画一个抽屉。`[data-hosted="true"]` 一组规则把定位、尺寸、变换、边框、投影、背景全部退回内容块语义。
- **`ensurePanel()` 的 `document.body.contains()` 守卫**：面板被 React 容器接管后不在 `body` 下，用旧守卫会导致每次切回设置页重建整块面板。改为 `if (panelEl) return panelEl;`，并新增 `panelAttached()`（`isConnected`）同时覆盖「挂 body」与「挂 React 容器」两种形态。
- **设置页里的第二层玻璃**：`applyAcrylic()` 在宿主态下会叠出 `backdrop-filter` 并盖住宿主选项区背景，现在 hosted 时直接清掉 filter 与背景。
- **强调色少一条回显**：原先 12 个色板 + 取色器 + 文本框 + 只读 hex + 随机 + 跟随原生，六条输入改同一个值；只读 hex 已删，回显并入文本框。
- **主题包「下载文件」不再写 textarea**：它原本也执行一次 `ta.value = JSON.stringify(...)`，与「导出并复制」重复；现在只有导出会填框。

### Changed

- 面板上的「窗口失焦时暂停」改为「**窗口被遮挡或失焦时暂停动态**」—— 行为扩展了，名字也跟上。
- README 里「视频每 4 秒重采样」是错的，实际代码一直是 **8 秒**，已更正。

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
