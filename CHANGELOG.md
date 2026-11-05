# Changelog

## 0.1.13 — 2026-11-05

接管「菜单从哪来」这一整片：菜单面层用的不是 `--dsw-alias-*`，而是 `--dsw-menu-surface-fill`；浮层以前会跟着地板系数一起塌到和正文同透；设置页那块亚克力底是写死的 0.38。

### Added

- **`--dsw-menu-surface-fill` 纳入管控（令牌 29 → 30）**。前缀是 `--dsw-menu-` 而非 `--dsw-alias-`，按 alias 名字空间扫描时整片漏掉。宿主 `_material_ri079_21` 直接 `background:var(--dsw-menu-surface-fill)`，默认值写死 `#43454a73`（深）/ `#f8f9fa94`（浅）—— 不接管就是一块与壁纸无关的灰玻璃。地板：铺开 0.72、非铺开 0.94、抬升 0.03，并入 `menu` 分组。
- **`FLOATING_FLOOR` 硬地板（7 项）**。菜单、下拉、提示气泡、toast、菜单键帽压在正文之上，背后没有「自己那块半透明画布」可借：地板系数降到 0 时面板塌到画布 alpha 是对的，浮层塌到 0.08 会让背后的列表透上来叠成乱码。这张表不乘 `floorScale`，是物理下限而非美术参数；分部位系数仍乘在最后。值：`specific-menu` / `specific-selector` / `menu-surface-fill` 0.72，`specific-tip` 0.80，`tooltip-bg` 0.86，`tooltip-key-bg` 0.62，`toast-bg` 0.82。

### Changed

- **设置页亚克力底跟画布走**。`FROST_OVERLAY_ALPHA` 原写死 0.38、遮罩写死 0.34，叠起来让 `AnXs9G_nav`（本身一直透明）看起来像实底。改为 `ovAlpha = clamp(alpha + 0.12, 深 0.12 / 浅 0.10, 深 0.50 / 浅 0.58)`、`maskAlpha = clamp(alpha + 0.06, 0.06, 深 0.34 / 浅 0.24)`：壁纸越透这层玻璃越透，但仍永远比画布实一档。
- 浮层的 `floorScale` 独立后，「面板地板强度」滑条拉到 0 时，面板与画布同透而浮层仍保底 —— 以前这两者被同一个系数拖着一起塌。

### Fixed

- **设置页亚克力变量被写成非法值**。初版用 `toRgba(ovBase, ovAlpha)`，但 `ovBase` 是 `"30,30,33"` 逗号三元组、不是 CSS 颜色，`toRgba()` 原样返回 ⇒ 变量里留下 `30,30,33`，浏览器把整条 `background-color:var(...)` 丢掉（表现为「改了没反应」）。改为手写 `"rgba(" + ovBase + "," + ovAlpha.toFixed(3) + ")"`。
- `FLOATING_FLOOR` 定义后一度没被读取（死常量），现已接入 `applyTokens()` 的铺开与非铺开两条分支。

### Known limitation

- 壁纸素材在左侧 280px 接近纯黑时（暗背景人像），侧边栏即便完全透明也看不出皮肤 —— 把 `_frame`/`_sidebarCol` 底色强制 `transparent` 后采样仍是 `[0,0,0]`。这是素材没有亮度可透，不是透明度公式缺陷。

## 0.1.12 — 2026-11-05

把「插件管不到的地方」补齐：设置面板、导航行、输入框、账号/模型页的卡片网格，全部纳入同一套显隐公式。可见像素与 0.1.11 的区别只在透明强度大于 0 时出现 —— 这些表面以前是恒定实心，现在会跟着画布一起变淡。

### Added

- **设置页功能区卡片纳入管控**：新增 `--dsw-alias-settings-card-fill`。宿主在 theme 包里把它声明成 `var(--dsw-alias-bg-layer-2)`，而 `var()` 在**声明处**就替换完成 —— 插件写 layer-2 的透明值继承不到这里，所以设置页账号/模型/插件市场/外观预设的整片卡片网格一直是实心块。只能直接写别名令牌本身。地板：非铺开 0.95（与 layer-1..3 同档，它承载表单标签与小号说明文字）、铺开 0.36（坐在 layer-2 面板 0.33 之上，必须高过它才保住「卡片 / 面板」两级层次）、抬升 0.05（沿用 layer-2 的抬升量 —— 宿主本就把它定义成 layer-2 的别名，抬升不一致会让卡片在铺开时比所在面板还淡，边界消失）。
- **引导卡两层**：`--dsw-alias-onboarding-card-fill`（0.95 / 0.33 / 抬升 0.03）与 `--dsw-alias-onboarding-secondary-fill`（0.93 / 0.28 / 抬升 0.02）。副卡在主卡内部，全靠这点 floor 差值才看得出嵌套。
- **面板全局令牌 26 → 29**：三个新令牌全部并入 `menu` 分组（用户眼里它们就是「面板里的一块面」），因此直接受「菜单 / 面板」那根分部位滑条控制，不需要新增第七组之外的控件。覆盖率断言同步到 29/29。

### Changed

- **输入框确认无需新增令牌**：全库 `input`/`textarea` 规则的 `background` 只有五种 —— `--dsw-alias-bg-layer-1`（真正的填充）、`--dsw-alias-bg-layer-3`、`--dsw-alias-state-success-primary`、`--dsw-alias-brand-primary`、`--dsw-alias-border-l1`。前两种已是覆盖项，后三种是状态色与描边色（透明化会让勾选态、按钮、边框一起失真），故不动。
- **玻璃不叠两层**：设置页遮罩用的是 `--dsw-alias-bg-mask-1`（插件铺开态地板 0.30，已覆盖）；`--dsw-mask-blur` 默认 `none`，且设置页内嵌态下插件的 `backdrop-filter` 已由 `applyAcrylic()` 的 hosted 早退关闭（见 0.1.11「入口」）。

### Fixed

- **`SURFACE_GROUPS` 漏掉新令牌导致覆盖率断言失败**：首次只把 `--dsw-alias-settings-card-fill` 并进 `menu` 组，随后追加的两个 onboarding 令牌没跟进去，`km-coverage` 报 `CONTENT_TOKENS: 29 | distinct grouped: 27` → `missing: ["--dsw-alias-onboarding-card-fill","--dsw-alias-onboarding-secondary-fill"]` → `COVERAGE_FAIL`。补齐后 29/29 通过。

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
