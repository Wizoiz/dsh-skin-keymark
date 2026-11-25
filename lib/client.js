/**
 * dsh-skin-keymark — browser half.
 *
 * Two independent engines plus a settings drawer:
 *
 *  1. Wallpaper engine — a fixed layer at `z-index:-1` (image via
 *     background-image, video via a muted looping <video>), four fits
 *     (cover / contain / stretch / tile), blur, dim and a panel-opacity
 *     slider that turns the DSH base tokens translucent by writing them as
 *     **inline custom properties on `body`** (CSS vars inherit down to
 *     `.frame` / `.sidebarCol`, and inline wins over every stylesheet), so
 *     the wallpaper shows through the canvas and sidebar while message
 *     bubbles and the composer card stay opaque.
 *
 *  2. Keymark engine — a scoped stylesheet that colours only the *text* of
 *     marked-up content (body / bold / link / inline-code / heading / list
 *     marker). Every rule writes **only `color`** — never background, border,
 *     box-shadow or outline — so no boxes are ever introduced.
 *
 *  3. Settings drawer — a native-DOM panel (the module table only exposes
 *     `react`, not `react-dom`, so the drawer is built with DOM APIs and the
 *     slot entry is the only React node). Opened from the palette button in
 *     `sidebar.footer.action`.
 *
 * Persistence is three-layered: memory → localStorage (instant first paint)
 * → host file via `/dsh-skin-keymark/api` (authoritative; survives the
 * per-launch origin change of DSH Desktop).
 */
window.__ModuleLoader__.load({
	id: "dsh-skin-keymark",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require("react");

		// ── constants ──────────────────────────────────────────────────────

		const LS_KEY = "dsh-skin-keymark:state";
		const API_URL = "/dsh-skin-keymark/api";
		const STYLE_ID = "dsh-skin-keymark-mark";
		const PANEL_STYLE_ID = "dsh-skin-keymark-panel-style";
		// 用户自定义 CSS 的样式节点。单独一个 <style> 而不是拼进 STYLE_ID：
		// 后者每次按键都会整体重写，混进来等于把用户的稿子也一起覆盖。
		const USER_STYLE_ID = "dsh-skin-keymark-user";
		// 上限 64 KB：足够写几百条规则，又远小于宿主 api 的 32 MB 上限与
		// localStorage 的 5 MB 配额，塞不进状态文件时也不会把存档撑爆。
		const USER_CSS_MAX = 65536;
		const WALLPAPER_ID = "dsh-skin-keymark-wallpaper";
		const PANEL_ID = "dsh-skin-keymark-panel";
		const TOAST_ID = "dsh-skin-keymark-toast";
		const PANEL_EVENT = "dsh-skin-keymark:panel";
		const MAX_DATA_URL = 1800000;
		// Host-side store for local wallpaper files. Videos are far past the
		// localStorage / state-file budget, so the bytes are pushed here once and
		// only the returned same-origin URL is kept in `state`; same origin also
		// keeps the readability sampler's canvas untainted.
		const MEDIA_URL = "/dsh-skin-keymark/media";
		// Boot seed global: the host inlines the saved state into the page before
		// any module runs, so the first paint is correct even without localStorage.
		const BOOT_GLOBAL = "__DSH_SKIN_KEYMARK_BOOT__";
		// P6 film-grain overlay (opt-in). A tiled feTurbulence tile is painted by
		// a dedicated fixed layer that stacks just above the wallpaper but still
		// below the (opaque) app frame, so it reads as texture on the artwork.
		const GRAIN_ID = "dsh-skin-keymark-grain";
		const GRAIN_TILE =
			"data:image/svg+xml;utf8," +
			encodeURIComponent(
				'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">' +
					'<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>' +
					'<feColorMatrix type="saturate" values="0"/></filter>' +
					'<rect width="120" height="120" filter="url(#n)" opacity="0.5"/></svg>'
			);
		// P5 seamless loop: a second <video> that crossfades in before the first
		// reaches its end, so the loop point never shows a cut. Opt-in because it
		// keeps two decoders alive for the short fade window.
		const CROSS_ID = "dsh-skin-keymark-wallpaper-b";


		/** 安全软取服务：只走 ctx.get，绝不做属性访问（未声明 inject 时属性访问会抛错）。 */
		function softService(ctx, name) {
			try {
				return (ctx.get && ctx.get(name)) || null;
			} catch (error) {
				diagReport("soft-service", name + ": " + String(error && error.message ? error.message : error));
				return null;
			}
		}

		/**
		 * 诊断上报：把客户端半的启动阶段与异常写回宿主状态文件
		 * `$DSH_HOME/dsh-skin-keymark.json` 的 `diag` 键，用于离线定位
		 * 「web boot: entry did not activate」这类只有失败标记、没有原因的场景。
		 * 自身绝不抛异常，也绝不阻塞启动。
		 */
		function diagReport(phase, detail, key) {
			try {
				const text = detail instanceof Error
					? `${detail.message}\n${detail.stack || ""}`
					: (detail === undefined ? "" : String(detail));
				// 缺省写 `diag`（启动时序单值快照，后来的覆盖先前的）。需要长期
				// 留存的自报（装机/几何）传独立 key，避免被 slot-registered 覆盖。
				const patch = {};
				patch[key || "diag"] = JSON.stringify({ at: new Date().toISOString(), phase, detail: text.slice(0, 2000) });
				fetch(API_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ method: "set", patch })
				}).catch(() => {});
			} catch {
				/* 诊断通道本身失败不影响插件 */
			}
		}

		// Fallback base colours used when the live token cannot be read; only
		// their alpha matters because the wallpaper sits underneath.
		const BASE_LIGHT = "#ffffff";
		const BASE_DARK = "#161616";

		const FITS = [
			{ id: "cover", label: "铺满" },
			{ id: "contain", label: "完整" },
			// 居中 = 原始像素尺寸不缩放，只居中摆放（视频 object-fit:none /
			// 图片 background-size:auto），看清小尺寸素材的真实分辨率。
			{ id: "center", label: "居中" },
			{ id: "stretch", label: "拉伸" },
			{ id: "tile", label: "平铺" }
		];

		// 视频播放倍速档位（原生 playbackRate，改档即时生效、不重载不解码黑屏）。
		const RATE_MIN = 0.25;
		const RATE_MAX = 4;

		// ── 生成式壁纸（渐变） ─────────────────────────────────────────────
		// 借鉴两个高星皮肤插件：dsh-dream-skin 的「壁纸 2.0 · 渐变预设」与
		// dsh-any-background 的「动态生成背景」。这里刻意**只用 CSS**——不建
		// canvas、不跑 shader、不引入任何素材文件，所以在关闭漂移动画时每帧
		// 开销为零；打开后也只是 background-position 的合成器动画。
		//
		// 每个预设同时给出浅色与深色两套色标：渐变属于**素材**（和图片一样），
		// 因此跟随界面明暗变化是合理的；它绝不反过来改写界面主题。
		const GRADIENT_PRESETS = [
			{ id: "aurora", label: "极光", type: "linear", angle: 135,
				light: ["#eaf4ff", "#d9ecff", "#cdeee3", "#eff7ff"],
				dark: ["#070d18", "#0e2b3d", "#146457", "#070d18"] },
			{ id: "dusk", label: "暮色", type: "linear", angle: 160,
				light: ["#fff3e9", "#ffdfc9", "#f6d4e6", "#fff3e9"],
				dark: ["#120a18", "#3a1730", "#7a2f36", "#160b1c"] },
			{ id: "paper", label: "纸感", type: "linear", angle: 120,
				light: ["#fdfaf3", "#f7f1e4", "#eee6d4", "#fdfaf3"],
				dark: ["#1b1815", "#262019", "#33291f", "#1b1815"] },
			{ id: "ink", label: "墨韵", type: "radial",
				light: ["#ffffff", "#eef0f3", "#dde2e8", "#ffffff"],
				dark: ["#0b0b0c", "#17181a", "#232529", "#0b0b0c"] },
			{ id: "mesh", label: "弥散", type: "mesh",
				light: ["#dbeafe", "#fde68a", "#fecdd3", "#bbf7d0"],
				dark: ["#0b1220", "#3b1d5e", "#0e3b46", "#131a2a"] },
			{ id: "ember", label: "余烬", type: "linear", angle: 145,
				light: ["#fff7ed", "#ffe4c7", "#f9c9a8", "#fff7ed"],
				dark: ["#150a06", "#2c130a", "#5c2410", "#150a06"] },
			{ id: "sea", label: "深海", type: "conic", angle: 210,
				light: ["#eef7fb", "#d8ecf3", "#c2e0ea", "#eef7fb"],
				dark: ["#04121a", "#062a38", "#0a4a5c", "#04121a"] },
			// 冷调深蓝灰的「一层纸」：没有配图也能直接得到午夜蓝的底。
			// 色标取自实测：画布 #282D33、卡片 #4D4F64，中间用 #333A43 过渡，
			// 让渐变自己就有明度阶梯，而不是一整块平涂。
			{ id: "midnight", label: "午夜", type: "linear", angle: 155,
				light: ["#eef1f6", "#e2e8f2", "#d6dfee", "#eef1f6"],
				dark: ["#20242a", "#282d33", "#333a43", "#20242a"] },
			// 无色标：色相取自壁纸主色测量（ui.tuneHue），彩度压得很低，
			// 读起来是一层有色调的空气而不是彩色塑料。
						{ id: "porcelain", label: "靛青", type: "linear", angle: 165,
				light: ["#f1f3f5", "#e6ecf1", "#dbe4ec", "#f1f3f5"],
				dark: ["#0a1320", "#0c1622", "#17283b", "#0a1320"] },
			{ id: "ikb", label: "克莱因", type: "linear", angle: 120,
				light: ["#fafaf8", "#efefea", "#e2e2da", "#fafaf8"],
				dark: ["#080809", "#0b0b0c", "#1a1a1d", "#080809"] },
			{ id: "nightink", label: "墨金", type: "linear", angle: 155,
				light: ["#efe9dd", "#e7e0d1", "#ded4c0", "#efe9dd"],
				dark: ["#0b0a09", "#0e0d0c", "#1f1a16", "#0b0a09"] },
{ id: "follow", label: "跟随主色", type: "follow" }
		];
		// 渐变规则写在一个独立 <style> 上（而不是壁纸元素的内联样式）：内联
		// background-image 与 background-size 会被 applyWallpaper() 每次重写，
		// 而漂移需要在关闭时整条规则消失，两件事分开更好控。
		const GRADIENT_STYLE_ID = "dsh-skin-keymark-gradient-style";

		// ── 分部位透明度 ──────────────────────────────────────────────────
		// dsh-any-background 的核心卖点：每一个表面各自一根滑条。这里不复制
		// 它的十几组选择器（那套与宿主类名强耦合），而是把已经拥有的内容
		// 令牌按语义分成四组，各自给一个**系数**（0.2–1）。
		//
		// 用系数而不是绝对值是关键：底板透明度是用户自己的量，可读性守卫
		// 还会在其上做加法；若这里写死绝对值，两套数就会互相打架（历史上
		// 正是这样把不透明度搞成"拖了没反应"）。系数只在**地板之上**压缩
		// 余量，因此永远越不过 CONTENT_FLOOR。
		// 分组的意义：每根滑条是一个系数，作用在它 members 列出的令牌上。
		// 分组边界按「用户脑中是不是同一块面」划，不按 token 名的前缀划 ——
		// bg-layer-4 与 bg-layer-1 同属面板层级，sidebar-nav-item-* 与
		// interactive-bg-* 虽然都叫「悬停」，但一个在侧栏列内、一个遍布
		// 整个界面，混在一起调会让用户无法只压侧栏。
		//
		// 这份表的**完整性**有硬约束：CONTENT_TOKENS 里每一个令牌都必须
		// 落在某一组里，否则 surfaceScaleFor() 对它恒返回 1，面板上就没有
		// 任何控件能影响它 —— 用户看到的是「这个开关失效了」。新增令牌时
		// 必须同步在这里落位（selftest 会断言覆盖率为 100%）。
		const SURFACE_GROUPS = [
			{ id: "bubble", label: "消息气泡", tokens: ["--dsw-specific-bubble", "--dsw-specific-bubble-highlight"] },
			{ id: "composer", label: "输入卡", tokens: ["--dsw-specific-input-major"] },
			{ id: "menu", label: "菜单 / 面板", tokens: ["--dsw-specific-menu", "--dsw-specific-selector", "--dsw-specific-tip", "--dsw-alias-bg-overlay", "--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2", "--dsw-alias-bg-layer-3", "--dsw-alias-bg-layer-4", "--dsw-alias-bg-module-platform", "--dsw-alias-menu-group-header-fill", "--dsw-alias-bg-mask-1", "--dsw-alias-settings-card-fill", "--dsw-alias-onboarding-card-fill", "--dsw-alias-onboarding-secondary-fill", "--dsw-menu-surface-fill"] },
			{ id: "code", label: "代码块 / 行内码", tokens: ["--dsw-alias-markdown-code-block", "--dsw-alias-markdown-inline-code", "--dsw-alias-markdown-code-block-banner"] },
			{ id: "sidebar", label: "侧栏行（选中 / 悬停）", tokens: ["--dsw-specific-sidebar-nav-item-active", "--dsw-specific-sidebar-nav-item-hover"] },
			{ id: "hover", label: "全局悬停态", tokens: ["--dsw-alias-interactive-bg-hover", "--dsw-alias-interactive-bg-hover-accent", "--dsw-alias-interactive-bg-hover-solid", "--dsw-alias-interactive-bg-active"] },
			{ id: "floating", label: "提示气泡 / toast", tokens: ["--dsw-alias-tooltip-bg", "--dsw-alias-tooltip-key-bg", "--dsw-alias-toast-bg"] }
		];
		const SURFACE_SCALE_MIN = 0.2;
		const SURFACE_SCALE_DEFAULT = 1;

		// 构图（平移 / 缩放）：dsh-any-background 的「背景编辑器」。这里用
		// transform 实现，图片与视频走同一条链路，且是纯合成器操作。
		const ZOOM_MIN = 100;
		const ZOOM_MAX = 250;

		// ── 模糊死区 ───────────────────────────────────────────────────────
		// 滑条仍保留 0–60 的连续档位，但 1.5px 以下不下发 CSS blur。原因不是
		// 「省性能」，而是这一档的收支根本不成立：实测同一视频帧在 860×780
		// 区域的拉普拉斯方差，blur(1px) 把锐度从 905.3 压到 757.7（−16.3%），
		// 而 1px 的糊在 1×/2× 屏上都看不出来 —— 用户付了清晰度，没换到效果。
		// 阈值取 1.5 而不是 1：滑条步进是 1，用 1.5 让「0 和 1 等效、2 起才有
		// 可见变化」，边界不会因为浮点显示问题在 1 和 2 之间抖。
		const BLUR_DEAD_ZONE = 1.5;

		// ── 切换过场 ───────────────────────────────────────────────────────
		// 换壁纸时在新旧画面之间播一段过渡。做法是把「旧画面」冻成一张静态图
		// （视频抓帧 / 图片直接复用同一 URL），盖在新画面之上，再让这张静态图
		// 按所选效果退场；演完即销毁。之所以不直接动画原图层：视频层要持续解码，
		// 对它做 transform 会让每帧重算合成，而静态快照是一次性的。
		const TRANSITIONS = [
			{ id: "none", label: "硬切", ms: 0 },
			{ id: "fade", label: "淡化", ms: 420 },
			{ id: "slide", label: "推移", ms: 520 },
			{ id: "wipe", label: "擦除", ms: 480 },
			{ id: "iris", label: "光圈", ms: 520 },
			{ id: "zoom", label: "缩放", ms: 520 }
		];
		const TRANSITION_SPEEDS = [
			{ id: "fast", label: "快", scale: 0.6 },
			{ id: "normal", label: "标准", scale: 1 },
			{ id: "slow", label: "慢", scale: 1.6 }
		];
		const TRANSITION_ID = "dsh-skin-keymark-transition";
		let transitionEl = null;
		let transitionTimer = null;
		// The source the renderer last painted. `null` means "nothing painted yet",
		// which suppresses a transition on the very first apply after load.
		let lastAppliedUrl = null;

		const MARK_KEYS = ["body", "strong", "link", "code", "heading", "marker"];
		const MARK_LABELS = {
			body: "正文",
			strong: "加粗 / 强调",
			link: "链接 / 文件",
			code: "行内代码",
			heading: "标题",
			marker: "列表标记"
		};
		// Per-category fallback when the user has not picked a colour: keep the
		// native DSH colour, so an empty value is a true no-op.
		const MARK_FALLBACK = {
			body: "var(--dsw-alias-label-primary)",
			strong: "var(--dsw-alias-label-primary)",
			link: "var(--dsw-alias-link)",
			code: "var(--dsw-alias-label-primary)",
			heading: "var(--dsw-alias-label-primary)",
			marker: "var(--dsw-alias-label-secondary)"
		};

		const PRESETS = {
			native: {
				label: "原生",
				light: { body: "", strong: "", link: "", code: "", heading: "", marker: "" },
				dark: { body: "", strong: "", link: "", code: "", heading: "", marker: "" }
			},
			cool: {
				label: "冷调",
				light: { body: "", strong: "#2f6fed", link: "#0b8fd6", code: "#6d4bd6", heading: "#1f6fd6", marker: "#7a8699" },
				dark: { body: "", strong: "#7aabff", link: "#4cc3f0", code: "#b39dff", heading: "#6fb0ff", marker: "#8b95a6" }
			},
			warm: {
				label: "暖调",
				light: { body: "", strong: "#c2410c", link: "#b45309", code: "#a21caf", heading: "#b45309", marker: "#9a7b6b" },
				dark: { body: "", strong: "#fdba74", link: "#fbbf24", code: "#f0abfc", heading: "#fcd34d", marker: "#b8a396" }
			},
			// Each of the palettes below owns a different hue family, so picking
			// between them is a real choice rather than a nudge in saturation.
			// `body` stays empty in every one of them: the prose colour is either
			// derived from the artwork or hand-written, never a preset's job.
			forest: {
				label: "森野",
				light: { body: "", strong: "#15803d", link: "#0f766e", code: "#4d7c0f", heading: "#166534", marker: "#6f8f74" },
				dark: { body: "", strong: "#6ee7b7", link: "#5eead4", code: "#bef264", heading: "#86efac", marker: "#a3c4a8" }
			},
			sakura: {
				label: "樱霞",
				light: { body: "", strong: "#be185d", link: "#9333ea", code: "#c026d3", heading: "#9d174d", marker: "#a08b99" },
				dark: { body: "", strong: "#fda4c8", link: "#d8b4fe", code: "#f5d0fe", heading: "#fbcfe8", marker: "#d6bbc6" }
			},
			// Deliberately hueless. On a busy or strongly tinted wallpaper a grey
			// ladder stays legible where every coloured family fights the artwork.
			ink: {
				label: "墨韵",
				light: { body: "", strong: "#1f2937", link: "#374151", code: "#4b5563", heading: "#111827", marker: "#6b7280" },
				dark: { body: "", strong: "#e5e7eb", link: "#d1d5db", code: "#cbd5e1", heading: "#f9fafb", marker: "#9ca3af" }
			},
			neon: {
				label: "霓虹",
				light: { body: "", strong: "#7c3aed", link: "#0284c7", code: "#db2777", heading: "#6d28d9", marker: "#8b7fa8" },
				dark: { body: "", strong: "#a78bfa", link: "#38bdf8", code: "#f472b6", heading: "#c4b5fd", marker: "#b0a6c9" }
			},
			ocean: {
				label: "深海",
				light: { body: "", strong: "#0e7490", link: "#0369a1", code: "#155e75", heading: "#075985", marker: "#6e8b96" },
				dark: { body: "", strong: "#67e8f9", link: "#7dd3fc", code: "#a5f3fc", heading: "#38bdf8", marker: "#93b8c4" }
			},
			// 配「午夜蓝」界面主题的那一套字色：蓝紫做主语，不掺别的色相。
			// 深色档用的是实测采样 #8FA7E3 / #ABCEF6 一族 —— 比纯蓝灰一点、
			// 比紫淡一点，正好落在那个界面的强调色区间里；浅色档相应压暗，
			// 因为同一批蓝在白底上会直接掉到 3:1 以下。
			midnight: {
				label: "午夜蓝",
				light: { body: "", strong: "#3d6bcc", link: "#2f5fbf", code: "#5a4bbd", heading: "#2c53a8", marker: "#7b8593" },
				dark: { body: "", strong: "#8fa7e3", link: "#abcef6", code: "#b7a8ef", heading: "#9db4f0", marker: "#8d96a3" }
			}
,
			porcelain: {
				label: "靛蓝瓷",
					light: { body: "", strong: "#315d93", link: "#2a5285", code: "#4a3f8f", heading: "#234a7d", marker: "#7c8b9d" },
					dark: { body: "", strong: "#6f9cd4", link: "#9dc0e8", code: "#b3b8ee", heading: "#8ab4e0", marker: "#8a99ab" }
			},
			ikb: {
				label: "克莱因蓝",
					light: { body: "", strong: "#002FA7", link: "#002b96", code: "#1f4bd8", heading: "#002FA7", marker: "#8a8a83" },
					dark: { body: "", strong: "#4a6ff0", link: "#93a8ff", code: "#a8b8ff", heading: "#6f8cff", marker: "#93938d" }
			},
			nightink: {
				label: "午夜墨",
					light: { body: "", strong: "#8a6420", link: "#7d5a1c", code: "#6b4a63", heading: "#6f4f16", marker: "#83755f" },
					dark: { body: "", strong: "#d4a04a", link: "#e5c07b", code: "#d8b98a", heading: "#e3c07f", marker: "#7d7166" }
			}
		};

		// Scope root for the keymark stylesheet. `[class*="markdown"]` /
		// `[class*="userText"]` are hashed CSS-Module classes, so matching on the
		// stable substring is the only portable selector; the data-* hooks come
		// from dsh-client-ui-chat and widen the reach to the composer and
		// process steps.
		const SCOPE =
			':is([data-chat-flow],[data-composer-seat],[data-submission-echo],[data-step-process],[data-context-text],[data-context-summary],[class*="markdown"],[class*="userText"])';

		// ── small helpers ──────────────────────────────────────────────────

		function clamp(n, lo, hi) {
			const v = Number(n);
			if (!isFinite(v)) return lo;
			return v < lo ? lo : v > hi ? hi : v;
		}

		/** Apply an alpha to a hex / rgb() colour, returning `rgba(...)`. */
		function toRgba(color, alpha) {
			const a = clamp(alpha, 0, 1);
			if (typeof color !== "string") return color;
			const s = color.trim();
			let m = /^#([0-9a-f]{3})$/i.exec(s);
			if (m) {
				const h = m[1];
				return `rgba(${parseInt(h[0] + h[0], 16)}, ${parseInt(h[1] + h[1], 16)}, ${parseInt(h[2] + h[2], 16)}, ${a})`;
			}
			m = /^#([0-9a-f]{6})$/i.exec(s);
			if (m) {
				const h = m[1];
				return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
			}
			m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
			if (m) return `rgba(${Math.round(+m[1])}, ${Math.round(+m[2])}, ${Math.round(+m[3])}, ${a})`;
			return s;
		}

		/** Coerce any accent input to a canonical "#rrggbb", or "" for native. */
		function normalizeAccent(value) {
			if (typeof value !== "string") return "";
			const s = value.trim();
			let m = /^#([0-9a-f]{3})$/i.exec(s);
			if (m) {
				const h = m[1];
				return ("#" + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]).toLowerCase();
			}
			m = /^#([0-9a-f]{6})$/i.exec(s);
			if (m) return ("#" + m[1]).toLowerCase();
			return "";
		}

		function defaultState() {
			return {
				version: 1,
				// "" = keep the native DSH accent; otherwise one hex colour is
				// fanned out to the brand + primary-button tokens (see applyAccent).
				accent: "",
				// `rate` = 播放倍速（1 = 原速）；`flip` = 水平镜像（CSS scaleX(-1)，
				// 零主线程开销）；`pauseBlur` / `pauseBattery` 是遮挡暂停的另外两档
				// （窗口失焦 / 使用电池），与「最小化/切页」一起决定要不要解码。
				wallpaper: { enabled: true, url: "", kind: "auto", fit: "cover", blur: 0, dim: 0, contrast: 0, saturate: 0, opacity: 0.55, grain: 0, crossfade: false, orbit: false, rate: 1, flip: false, pauseBlur: true, pauseBattery: true, rotate: false, rotateUrls: "", rotateMin: 10, rotateMode: "seq", recent: [], transition: "fade", transitionSpeed: "normal", transitionDir: "left", gradient: "", zoom: 100, panX: 0, panY: 0 },
				// Interface-level look: `transparency` dials the content-layer
				// surfaces (bubbles / composer / cards) open, `contrast` picks the
				// panel scheme (theme | auto | light | dark), and `readability`
				// lets the sampler raise the backing layer until the worst tile
				// clears the AA contrast floor.
				// `theme` = the whole-app alias palette ("native" writes nothing
				// and leaves the DSH theme alone). It is a sibling of `accent`:
				// the theme paints the surfaces, the accent still wins for the
				// brand tokens because applyAccent() runs after applyUiTheme().
				ui: { theme: "native", transparency: 0, contrast: "theme", readability: true, autotint: false, tuneMarks: true, marksAuto: true, tuneHue: null, tuneSat: null, tuneHueUrl: "", collapsed: [], glass: { blur: 0, tint: 1 }, contrastFromTune: false,
					// 分部位透明度系数：每组 0.2–1，缺省 1 = 原样（不写任何额外值）。
					// 键必须与 SURFACE_GROUPS 对齐；normalizeState 会按那张表补全，
					// 这里写全只是为了让人读 defaultState 就知道有几组。
					surfaces: { bubble: 1, composer: 1, menu: 1, code: 1, sidebar: 1, hover: 1, floating: 1 },
					// 渐变漂移：只在渐变壁纸上生效，缺省关（纯静态画面最省电）。
					drift: false,
					// 全窗铺开：把皮肤从「对话画布」推到侧栏、各类面板、菜单、
					// 悬停态与窗口 chrome 遮罩。缺省开 —— 用户要的就是这个，
					// 而关掉它回到旧行为（只有画布透，面板全实心）。
					//
					// 旧行为靠 `ui.transparency`，但那个值的语义是「内容层缩
					// 放系数」，默认 0 时公式 `max(1 - 0, floor)` 恒为 1，等于
					// 什么都不做。铺开是另一件事：它以底板 alpha 为起点推导
					// 每个面板的 alpha，所以 transparency=0 时也会生效。
					spread: true,
					// 地板强度：1 = 面板按原地板保一层可读底；0 = 地板取消，
					// 面板与画布同透（用户要「所有部分都透明」时用这个）。
					floorScale: 1,
					// 主题可见度：把主题的强调色按这个比例**混进底色本身**，
					// 而不是另叠一层覆盖物。为什么非得这样：令牌那条路是
					// 「主题色 × 画布 alpha」，用户把 alpha 拖到 0.08 时
					// `#161616` 与 `#282D33` 合成到同一帧上每通道只差
					// 1.4/255（真机实测三张截图 Δ=0）—— 乘法把色差压平了，
					// 换任何主题画面都不动。也试过全屏 layer + `color` 混合，
					// 只改色相不改明暗，暗部实测 Δ 0–0.2/255，同样无效。
					// 唯一有效的是在基色里就把强调色混进去：alpha 一个数都
					// 不碰（那是用户直接掌握的量），只换 rgba 的前三个数。
					// 0.7 是实测档位：画布 Δ19.7/255 一眼可见，壁纸明暗纹理
					// 还剩 94%。
					themeInk: 0.7,
					// 正文字体：system = 微软雅黑 UI（Windows 原生），noto =
					// Noto Sans SC，oppo = OPPO Sans，stock = 交回宿主默认栈。
					// 宿主默认栈在 Windows 上会命中移植版 PingFang SC，
					// 14px 下笔画发虚，所以缺省用 system。
					fontFamily: "system",
					fontSmoothing: true,
					// 文字亮度：0 = 宿主原值（claude-style 从画布推算的那套，
					// 全透明时偏暗），1 = 最亮。0.6 是「明显提亮但不刺眼」。
					textBoost: 0.6,
					// 正文字重：宿主把 font-weight 写死（400 居多）且没有对应变量，
					// 400 = 跟随宿主，500/600 = 笔画加粗（正黑体配合看更实）。
					fontWeight: 400,
					// 用户自定义 CSS：整段原样写进一个独立的 <style>，最后加载，
					// 所以它是「最后说话的那一层」。空串 = 不生效（连节点都不建）。
					// 缺省空：这是逃生舱口，不是默认外观的一部分。
					userCss: "",
					// 分组折叠（0.1.23）：auto = 每个分区只展开第一组，其余收起。
					// 用户点过一次分组标题就转 manual，把实际收起的 key 写进
					// groupFolded —— 默认观感收敛，但不覆盖用户表达过的偏好。
					groupAuto: true,
					groupFolded: [] },
				marks: {
					preset: "native",
					editScheme: "light",
					light: Object.assign({}, PRESETS.native.light),
					dark: Object.assign({}, PRESETS.native.dark)
				}
			};
		}

		/** Coerce arbitrary parsed JSON into a valid state object. */
		function normalizeState(raw) {
			const out = defaultState();
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
			out.accent = normalizeAccent(raw.accent);
			const wp = raw.wallpaper;
			if (wp && typeof wp === "object") {
				out.wallpaper.enabled = wp.enabled !== false;
				out.wallpaper.url = typeof wp.url === "string" ? wp.url : "";
				out.wallpaper.kind = ["auto", "image", "video"].indexOf(wp.kind) >= 0 ? wp.kind : "auto";
				out.wallpaper.fit = FITS.some((f) => f.id === wp.fit) ? wp.fit : "cover";
				out.wallpaper.blur = clamp(wp.blur, 0, 60);
				out.wallpaper.dim = clamp(wp.dim, 0, 1);
				out.wallpaper.contrast = isFinite(Number(wp.contrast)) ? clamp(wp.contrast, -100, 100) : 0;
				out.wallpaper.saturate = isFinite(Number(wp.saturate)) ? clamp(wp.saturate, -100, 100) : 0;
				out.wallpaper.opacity = isFinite(Number(wp.opacity)) ? clamp(wp.opacity, 0, 1) : 0.55;
				out.wallpaper.grain = isFinite(Number(wp.grain)) ? clamp(wp.grain, 0, 1) : 0;
				out.wallpaper.crossfade = wp.crossfade === true;
				out.wallpaper.orbit = wp.orbit === true;
				out.wallpaper.rate = isFinite(Number(wp.rate)) ? clamp(wp.rate, RATE_MIN, RATE_MAX) : 1;
				out.wallpaper.flip = wp.flip === true;
				// 遮挡暂停三档默认开：最小化/切页必然停；失焦与电池各由这里控制。
				out.wallpaper.pauseBlur = wp.pauseBlur !== false;
				out.wallpaper.pauseBattery = wp.pauseBattery !== false;
				out.wallpaper.rotate = wp.rotate === true;
				out.wallpaper.rotateUrls = typeof wp.rotateUrls === "string" ? wp.rotateUrls : "";
				out.wallpaper.rotateMin = isFinite(Number(wp.rotateMin)) ? clamp(wp.rotateMin, 0.5, 720) : 10;
				out.wallpaper.rotateMode = wp.rotateMode === "random" ? "random" : "seq";
				// Only safe, non-empty strings survive: these get fed straight back
				// into the wallpaper sink on a chip click.
				out.wallpaper.recent = Array.isArray(wp.recent)
					? wp.recent.filter((u) => typeof u === "string" && u !== "" && isSafeWallpaperUrl(u)).slice(0, 8)
					: [];
				out.wallpaper.transition = TRANSITIONS.some((t) => t.id === wp.transition) ? wp.transition : "fade";
				out.wallpaper.transitionSpeed = TRANSITION_SPEEDS.some((s) => s.id === wp.transitionSpeed) ? wp.transitionSpeed : "normal";
				out.wallpaper.transitionDir = wp.transitionDir === "right" ? "right" : "left";
				// 生成式壁纸：一个 id 而已，非法 id 静默回落到空串（= 不用渐变），
				// 与「界面主题」的处理同理 —— 保留一个画不出来的 id 只会让面板
				// 显示"已选中"却什么都不出现。
				out.wallpaper.gradient = GRADIENT_PRESETS.some((g) => g.id === wp.gradient) ? wp.gradient : "";
				out.wallpaper.zoom = isFinite(Number(wp.zoom)) ? clamp(wp.zoom, ZOOM_MIN, ZOOM_MAX) : 100;
				// 平移以视口百分比存，窗口缩放后构图保持不变（与 dsh-any-background
				// 的位置编辑器同一个口径），钳到 ±50 避免整张画面被推出屏幕。
				out.wallpaper.panX = isFinite(Number(wp.panX)) ? clamp(wp.panX, -50, 50) : 0;
				out.wallpaper.panY = isFinite(Number(wp.panY)) ? clamp(wp.panY, -50, 50) : 0;
			}
			const mk = raw.marks;
			if (mk && typeof mk === "object") {
				// `preset` is a LABEL: it asserts the six colours are exactly
				// PRESETS[id]. `setMark()` blanks it on every manual edit, so an
				// empty string is a real value — "these are not a named preset" —
				// and must survive normalization. Letting it fall back to the
				// default "native" here would relabel a hand-edited set as the
				// stock palette, which the boot-time re-derivation then treats as
				// its own to overwrite: the "my settings keep reverting" failure,
				// reintroduced through the normalizer. An id we do not know cannot
				// describe colours we never shipped, so it is custom too.
				if (typeof mk.preset === "string") out.marks.preset = PRESETS[mk.preset] ? mk.preset : "";
				out.marks.editScheme = mk.editScheme === "dark" ? "dark" : "light";
				for (const scheme of ["light", "dark"]) {
					const src = mk[scheme];
					if (src && typeof src === "object") {
						for (const k of MARK_KEYS) {
							if (typeof src[k] === "string") out.marks[scheme][k] = src[k];
						}
					}
				}
			}
			const ui = raw.ui;
			if (ui && typeof ui === "object") {
				// Whole-app palette. An unknown id falls back to 跟随原生 rather
				// than being kept: a theme pack imported from a newer build would
				// otherwise name a palette whose tokens we cannot write, and the
				// panel would show a selected theme that paints nothing.
				if (typeof ui.theme === "string" && UI_THEMES[ui.theme]) out.ui.theme = ui.theme;
				out.ui.transparency = isFinite(Number(ui.transparency)) ? clamp(ui.transparency, 0, 1) : out.ui.transparency;
				if (["theme", "auto", "light", "dark"].indexOf(ui.contrast) >= 0) out.ui.contrast = ui.contrast;
				out.ui.readability = ui.readability !== false;
				out.ui.autotint = ui.autotint === true;
				// Tracks whether the CURRENT contrast value was written by auto-tune
				// (dark artwork). It is what lets a later bright artwork release the
				// surface back to 跟随主题 without ever clobbering a manual choice.
				out.ui.contrastFromTune = ui.contrastFromTune === true;
				// Auto-tune may also rewrite the six mark colours. That is a
				// per-wallpaper treatment like the tint, so it gets its own switch;
				// turning it off leaves the user's chosen preset alone.
				out.ui.tuneMarks = ui.tuneMarks !== false;
				// Tracks whether the six mark colours currently in the state were
				// DERIVED (by auto-tune) rather than picked by hand. This is the
				// permission slip the boot-time re-derivation runs on: a derived
				// set is the plugin's own output and may be recomputed at launch,
				// while a hand-edited set is the user's and must survive every
				// restart untouched. Without the flag, re-deriving at boot would
				// silently undo manual edits — the exact "my settings keep
				// reverting" complaint that the older round's opt-outs came from.
				//
				// States written before this flag existed have no answer stored,
				// and the state file cannot supply one: `setMark()` (hand edit) and
				// `autoTune()` (plugin derivation) BOTH leave `marks.preset` empty,
				// while `applyPreset()` — a deliberate user choice — is the one
				// writer that leaves a name. So a stored name does NOT mean "the
				// plugin's to restyle"; it means the user picked that preset, and
				// overwriting it at launch is precisely the "my settings keep
				// reverting" failure this flag exists to prevent.
				//
				// That leaves legacy states genuinely ambiguous, and the two errors
				// are not equal: refusing to re-derive costs nothing but a delay
				// until the next wallpaper pick (which re-authorizes via
				// `autoTune()`), while re-deriving over a hand-made set destroys
				// work the user did by hand. The colours already in the state stay
				// exactly as they are either way; the only thing withheld is the
				// launch-time refresh. So legacy migrates to false, deliberately
				// without a guess. Fresh installs are unaffected — they never had a
				// legacy state and get `defaultState()`'s true.
				out.ui.marksAuto = ui.marksAuto === true;
				// The dominant colour the last tune measured, remembered alongside
				// the URL it was measured for. `ensureTint()` gives the live element
				// ~1.5s to become readable and then gives up, so on a restart — when
				// nothing has been decoded yet — the measurement has to come from
				// the tune instead of from the screen. The saturation is stored too:
				// hue alone cannot reproduce the tint, since it sets the chroma.
				//
				// Tested with `typeof === "number"` rather than `isFinite(Number(x))`:
				// Number(null) and Number("") are both 0, so the numeric coercion
				// would turn "no measurement" into hue 0 — a real, red hue.
				//
				// The pair is only meaningful together, so a hue with no URL is
				// dropped rather than kept: `tuneSeedFor()` refuses to seed from a
				// URL-less record anyway, and leaving hue 0 sitting next to an empty
				// URL is indistinguishable from "measured red" to anything reading
				// the state file by eye.
				out.ui.tuneHueUrl = typeof ui.tuneHueUrl === "string" ? ui.tuneHueUrl : "";
				const hueKnown = out.ui.tuneHueUrl !== "";
				out.ui.tuneHue = hueKnown && typeof ui.tuneHue === "number" && isFinite(ui.tuneHue) ? ui.tuneHue : null;
				out.ui.tuneSat = hueKnown && typeof ui.tuneSat === "number" && isFinite(ui.tuneSat) ? clamp(ui.tuneSat, 0, 1) : null;
				// Section names are the fold keys; a malformed entry would only fold
				// the wrong section, so cap the list and keep strings only.
				out.ui.collapsed = Array.isArray(ui.collapsed)
					? ui.collapsed.filter((s) => typeof s === "string" && s !== "").slice(0, 24)
					: [];
				// Panel glass (this plugin's own surface). Independent of the
				// wallpaper's 模糊 slider: the drawer's glass and the artwork's blur
				// are different surfaces and are configured separately.
				const gl = ui.glass && typeof ui.glass === "object" ? ui.glass : {};
				out.ui.glass = {
					blur: isFinite(Number(gl.blur)) ? clamp(gl.blur, 0, 40) : 0,
					tint: isFinite(Number(gl.tint)) ? clamp(gl.tint, 0, 1) : 1
				};
				// 分部位透明度系数。缺省 1 = 完全原样；只接受 SURFACE_GROUPS 里
				// 声明过的四组键，其它键静默丢弃（与「主题包可能来自更新版本」
				// 的处理一致：认不出的键不写，而不是保留一个没人读的僵尸值）。
				const sf = ui.surfaces && typeof ui.surfaces === "object" ? ui.surfaces : {};
				for (const group of SURFACE_GROUPS) {
					const v = sf[group.id];
					out.ui.surfaces[group.id] = isFinite(Number(v)) ? clamp(v, SURFACE_SCALE_MIN, 1) : SURFACE_SCALE_DEFAULT;
				}
				// 渐变漂移：只对渐变壁纸有意义，但开关本身与素材无关，照样
				// 持久化 —— 换成图片期间它只是不生效，不该被静默清掉。
				out.ui.drift = ui.drift === true;
				// 全窗铺开。缺省开：老状态里没有这个键，必须迁移到 true 而不是
				// false —— 用户报的正是「只有对话窗口有皮肤」，旧状态本身就是
				// 那个缺陷的样子，把它当作用户选择保留下来等于不修。
				out.ui.spread = ui.spread !== false;
				// 地板强度系数：0 = 地板彻底取消（所有面板跟画布同透），
				// 1 = 保留原有地板（密排文字的最低可读底）。地板是
				// `max(alpha + lift, floor)` 里的 floor，也是侧栏
				// SIDEBAR_FLOOR 的那一档 —— 它是「壁纸滑条拉到底仍然
				// 半实心」的唯一原因，必须让它可被用户关掉。
				out.ui.floorScale = isFinite(Number(ui.floorScale)) ? clamp(ui.floorScale, 0, 1) : 1;
				// 主题可见度：强调色混进底色的比例。0 = 不混（回到「只换
				// 令牌」的旧行为，8% 画布下几乎看不出），1 = 底色就是强调色
				// 本身。老状态没有这个键 ⇒ 迁移到默认值而不是 0，否则升级
				// 后所有人仍看到「主题没变化」，等于没修。
				out.ui.themeInk = isFinite(Number(ui.themeInk)) ? clamp(ui.themeInk, 0, 1) : THEME_INK_DEFAULT;
				// 字体家族：只接受白名单 id，非法值静默回落到 system。
				// 不直接存字体串 —— 存串会让用户在面板外改出的任意名字
				// 跟着状态文件走，而字体名写错在 CSS 里不会报错，只会
				// 悄悄回落成另一种字体，排查时无从下手。
				out.ui.fontFamily = ["system", "noto", "oppo", "youyuan", "jhenghei", "stock"].indexOf(ui.fontFamily) >= 0 ? ui.fontFamily : "system";
				out.ui.fontSmoothing = ui.fontSmoothing !== false;
				out.ui.textBoost = isFinite(Number(ui.textBoost)) ? clamp(Number(ui.textBoost), 0, 1) : 0.6;
				out.ui.fontWeight = isFinite(Number(ui.fontWeight)) ? clamp(Math.round(Number(ui.fontWeight) / 100) * 100, 300, 800) : 400;
				// 自定义 CSS 只做两件事：非字符串一律当空、超长截断。
				// 不在这里做语法校验 —— CSS 的错误恢复是浏览器的事，写错了
				// 只有那一行失效，剩下的规则照常生效；提前过滤反而会删掉
				// 用户真正想写的东西（比如靠 @supports 试探的片段）。
				out.ui.userCss = typeof ui.userCss === "string"
					? (ui.userCss.length > USER_CSS_MAX ? ui.userCss.slice(0, USER_CSS_MAX) : ui.userCss)
					: "";
				// 分组折叠偏好：非 true/false 一律回落到 auto（true），
				// 只有字面 false 才算用户明确切成手动。
				out.ui.groupAuto = ui.groupAuto !== false;
				out.ui.groupFolded = Array.isArray(ui.groupFolded)
					? ui.groupFolded.filter((s) => typeof s === "string" && s !== "").slice(0, 40)
					: [];
			}
			return out;
		}

		// ── state + persistence ────────────────────────────────────────────

		let state = defaultState();
		let saveTimer = null;

		function loadLocal() {
			try {
				const raw = window.localStorage.getItem(LS_KEY);
				if (raw) {
					const parsed = JSON.parse(raw);
					if (parsed !== null && typeof parsed === "object") return parsed;
				}
			} catch {
				/* private mode / corrupt value — fall through to the boot seed */
			}
			// Boot seed: the host inlines the last saved state into the page
			// before any module runs, so a fresh origin (or cleared storage)
			// still paints correctly without waiting for the async /api pull.
			try {
				const seed = window[BOOT_GLOBAL];
				if (seed !== null && typeof seed === "object" && typeof seed.state === "string" && seed.state !== "") {
					return JSON.parse(seed.state);
				}
			} catch {
				/* absent or malformed seed — the async pull remains the fallback */
			}
			return null;
		}

		function saveLocal() {
			try {
				window.localStorage.setItem(LS_KEY, JSON.stringify(state));
			} catch {
				/* private mode / quota — the host file remains authoritative */
			}
		}

		async function pullHost() {
			try {
				const res = await fetch(API_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ method: "get" })
				});
				if (!res.ok) return;
				const data = await res.json();
				const value = data && data.ok ? data.value : null;
				if (value && typeof value.state === "string" && value.state !== "") {
					state = normalizeState(JSON.parse(value.state));
					applyAll();
					// The restored state can carry different opacity/dim — and a
					// different `marksAuto` — than the localStorage copy booted
					// from, but `applyAll()` will not re-solve the marks: its
					// `ensureLuminance()` sees an already-sampled URL and returns
					// early. Re-solve explicitly against the sample already retained
					// so the text matches the artwork and the settings that just
					// arrived, instead of the ones that were guessed a moment ago.
					repaintMarks();
					saveLocal();
					syncPanel();
				}
			} catch {
				/* host half unavailable — localStorage is the fallback */
			}
		}

		async function pushHost() {
			try {
				await fetch(API_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ method: "set", patch: { state: JSON.stringify(state) } })
				});
			} catch {
				/* ignore */
			}
		}

		// ── media library (host-side store) ────────────────────────────────
		//
		// The host keeps an ordered index of uploaded clips (content-addressed
		// files under $DSH_HOME/dsh-skin-keymark-media). The panel lists them so
		// a clip used before can be re-applied without a re-upload.

		async function listMedia() {
			try {
				const res = await fetch(API_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ method: "list-media" })
				});
				if (!res.ok) return [];
				const data = await res.json();
				return data && data.ok === true && Array.isArray(data.value) ? data.value : [];
			} catch {
				return [];
			}
		}

		async function deleteMedia(name) {
			try {
				const res = await fetch(API_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ method: "delete-media", name })
				});
				const data = await res.json().catch(() => null);
				return !!(res.ok && data && data.ok === true);
			} catch {
				return false;
			}
		}

		/** Human-readable byte size for the media-library rows. */
		function formatBytes(size) {
			const n = Number(size) || 0;
			if (n < 1024) return n + " B";
			if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
			return (n / (1024 * 1024)).toFixed(1) + " MB";
		}

		/**
		 * Render the host media library into the panel list. Each row offers a
		 * one-click re-apply (no re-upload) and a soft delete. A missing host
		 * half simply yields an empty list, never a throw.
		 */
		async function renderLibrary() {
			const refs = panelRefs;
			if (!refs || !refs.libList) return;
			const all = await listMedia();
			const box = refs.libList;
			box.textContent = "";
			if (!all.length) {
				box.appendChild(h("div", { class: "km-lib-empty", text: "暂无本地素材（上传图片 / 视频后出现在这里）" }));
				return;
			}
			// Filter + ordering are view-only, so they live in memory instead of
			// `state`: nothing here is worth persisting, and keeping them out of
			// state avoids two more normalise branches and a save per toggle.
			const mode = libView.mode;
			const list = all
				.filter((e) => {
					if (mode === "all") return true;
					const n = String((e && e.name) || "");
					return mode === "video" ? isVideoName(n) : !isVideoName(n);
				})
				.sort((a, b) => {
					// Newest first is the host's insertion order reversed; size is
					// the only other signal we actually carry.
					if (libView.sort === "size") return (Number(b.size) || 0) - (Number(a.size) || 0);
					if (libView.sort === "oldest") return all.indexOf(a) - all.indexOf(b);
					return 0;
				});
			if (!list.length) {
				box.appendChild(h("div", { class: "km-lib-empty", text: "当前筛选下没有素材" }));
				return;
			}
			for (const entry of list) {
				const name = String((entry && entry.name) || "");
				if (name === "") continue;
				const url = `${MEDIA_URL}/${name}`;
				const isVideo = isVideoName(name);
				const thumb = isVideo
					? h("video", { class: "km-thumb", src: url, muted: true, preload: "metadata" })
					: h("img", { class: "km-thumb", src: url, alt: "" });
				const meta = h("div", { class: "km-lib-meta" }, [
					h("div", { class: "km-lib-name", text: name }),
					h("div", { class: "km-lib-size", text: formatBytes(entry.size) })
				]);
				const apply = h("button", {
					class: "km-btn", type: "button", text: "应用",
					onclick: () => {
						state.wallpaper.url = url;
						state.wallpaper.gradient = "";
						state.wallpaper.kind = isVideo ? "video" : "image";
						state.wallpaper.enabled = true;
						commit();
						tuneOnPick(url);
						toast("已应用素材");
					}
				});
				const rot = h("button", {
					class: "km-btn km-mini", type: "button", text: "轮播", title: "加入自动轮播列表",
					onclick: () => {
						const lines = parseRotateList();
						if (lines.indexOf(url) >= 0) { toast("已在轮播列表中"); return; }
						lines.push(url);
						state.wallpaper.rotateUrls = lines.join("\n");
						if (lines.length > 1) state.wallpaper.rotate = true;
						commit();
						toast("已加入轮播列表");
					}
				});
				const del = h("button", {
					class: "km-btn km-danger", type: "button", text: "删除",
					onclick: async () => {
						const ok = await deleteMedia(name);
						if (ok) { toast("已删除素材"); renderLibrary(); }
						else toast("删除失败");
					}
				});
				box.appendChild(h("div", { class: "km-lib-item" }, [thumb, meta, apply, rot, del]));
			}
		}

		// How many recently-used sources the chip row keeps.
		const RECENT_MAX = 8;

		/** Whether a stored media file name is a video container. */
		function isVideoName(name) {
			return VIDEO_EXT.test(String(name || ""));
		}

		// Media-library view controls (filter + order). Deliberately NOT part of
		// `state`: they are throwaway view preferences, and keeping them out avoids
		// extra normalise branches plus a host write on every toggle.
		const libView = { mode: "all", sort: "newest" };

		/**
		 * Record a source as recently used. Kept newest-first, de-duplicated and
		 * capped, so the chip row stays one glance wide however long the session
		 * runs. Returns true when the list actually changed.
		 */
		function markRecent(url) {
			if (typeof url !== "string" || url.trim() === "") return false;
			const value = url.trim();
			const list = Array.isArray(state.wallpaper.recent) ? state.wallpaper.recent.slice() : [];
			const at = list.indexOf(value);
			if (at >= 0) list.splice(at, 1);
			// The current wallpaper is already shown big; a chip for it is noise.
			list.unshift(value);
			const next = list.slice(0, RECENT_MAX);
			const same = next.length === (state.wallpaper.recent || []).length &&
				next.every((v, i) => v === (state.wallpaper.recent || [])[i]);
			state.wallpaper.recent = next;
			return !same;
		}

		/** Paint the recent-source chips from state. */
		function renderRecent() {
			const refs = panelRefs;
			if (!refs || !refs.recentList) return;
			const box = refs.recentList;
			box.textContent = "";
			const list = Array.isArray(state.wallpaper.recent) ? state.wallpaper.recent : [];
			if (!list.length) {
				box.appendChild(h("div", { class: "km-lib-empty", text: "暂无最近使用" }));
				return;
			}
			const current = typeof state.wallpaper.url === "string" ? state.wallpaper.url.trim() : "";
			for (const url of list) {
				const label = url.startsWith(MEDIA_URL + "/")
					? url.slice(MEDIA_URL.length + 1).slice(0, 10) + "…"
					: url.length > 16 ? url.slice(0, 16) + "…" : url;
				const isVideo = isVideoUrl(url);
				const chip = h("button", {
					class: "km-chip", type: "button",
					title: url,
					"data-active": url === current ? "true" : "false",
					onclick: () => {
						state.wallpaper.url = url;
						state.wallpaper.gradient = "";
						state.wallpaper.kind = isVideo ? "video" : "image";
						state.wallpaper.enabled = true;
						commit();
						tuneOnPick(url);
						toast("已切换壁纸");
					}
				}, [h("span", { class: "km-chip-dot", "data-video": isVideo ? "true" : "false" }), h("span", { text: label })]);
				box.appendChild(chip);
			}
		}

		function scheduleSave() {
			saveLocal();
			if (saveTimer) clearTimeout(saveTimer);
			saveTimer = setTimeout(() => {
				saveTimer = null;
				pushHost();
			}, 400);
		}

		// ── wallpaper engine ───────────────────────────────────────────────

		// Container extensions Chromium can decode in a plain <video> element.
		// HLS (.m3u8) / DASH (.mpd) are excluded on purpose: they need MSE + a
		// JS player, which a bare <video src> cannot drive.
		const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|ts)(\?|#|$)/i;

		function isVideoUrl(url) {
			if (/^data:video\//i.test(url)) return true;
			if (/^data:image\//i.test(url)) return false;
			return VIDEO_EXT.test(url);
		}

		function resolveKind(url, kind) {
			if (kind === "image" || kind === "video") return kind;
			return isVideoUrl(url) ? "video" : "image";
		}

		// Wallpaper URL allowlist: the image branch builds a CSS `url("...")`
		// and the video branch sets a <video src>, so an unguarded value could
		// smuggle `javascript:` / `data:text/html` / control characters into a
		// sink (the panel's URL field and the shared theme-pack JSON are both
		// untrusted input). Only http(s), blob:, image/video data URLs, and
		// same-origin relative paths are accepted; anything else leaves the
		// wallpaper off rather than rendering an arbitrary string.
		function isSafeWallpaperUrl(url) {
			if (typeof url !== "string") return false;
			const value = url.trim();
			if (value === "") return false;
			// No control chars, and nothing that could break out of the quoted
			// CSS string or the src attribute.
			if (/[\u0000-\u001f\u007f"'\\]/.test(value)) return false;
			if (/^(\/|\.\/|\.\.\/)/.test(value)) return true;
			if (/^(https?:\/\/|blob:)/i.test(value)) return true;
			if (/^data:(image|video)\//i.test(value)) return true;
			return false;
		}

		// 壁纸元素的全屏样式是一条完整 cssText（含 filter / transform）：每次
		// 无条件重写会让浏览器重新解析字符串并让整层重新合成。签名由「元素
		// 身份 + 所有参与拼接的输入」组成，元素被 ensureWallpaperEl() 换掉时
		// 身份不同，必然重画；只是拖动透明度滑条则签名不变。
		let paintedEl = null;
		let paintedCss = "";
		/**
		 * 写壁纸样式；与上次完全一致时返回 false（没写）。
		 *
		 * 直接拿 css 字符串当签名：它本来就由全部输入拼成，任何一处变化都会
		 * 让字符串不同，不需要再手工维护一份「哪些输入该进签名」的清单 —— 那种
		 * 清单漏一项就会让某个滑条失灵，而且很难被发现。
		 */
		function paintWallpaperEl(el, css) {
			if (el === paintedEl && css === paintedCss) return false;
			el.style.cssText = css;
			paintedEl = el;
			paintedCss = css;
			return true;
		}

		function ensureWallpaperEl(kind) {
			const wantVideo = kind === "video";
			let el = document.getElementById(WALLPAPER_ID);
			if (el && (el.tagName === "VIDEO") !== wantVideo) {
				el.remove();
				el = null;
				// 换的是元素本身（图片↔视频），画过的样式没跟过去。
				paintedEl = null;
				paintedCss = "";
			}
			if (!el) {
				el = document.createElement(wantVideo ? "video" : "div");
				el.id = WALLPAPER_ID;
				el.setAttribute("aria-hidden", "true");
				if (wantVideo) {
					// No `autoplay`: playback is driven by applyVideoPlayback() so the
					// power guard (hidden / fully covered / reduced-motion) always wins.
					el.autoplay = false;
					el.muted = true;
					el.loop = true;
					el.playsInline = true;
					el.setAttribute("muted", "");
					el.setAttribute("playsinline", "");
					el.referrerPolicy = "no-referrer";
				}
				(document.body || document.documentElement).prepend(el);
			}
			return el;
		}

		function removeWallpaperEl() {
			// 元素要没了，记住的「上次画了什么」随之失效：新元素即便拿到
			// 完全相同的 css 也必须真写一次。
			paintedEl = null;
			paintedCss = "";
			const el = document.getElementById(WALLPAPER_ID);
			if (!el) return;
			if (el.tagName === "VIDEO") {
				try { el.pause(); } catch { /* ignore */ }
				el.removeAttribute("src");
				try { el.load(); } catch { /* ignore */ }
			}
			el.remove();
		}

		// ── transition engine ──────────────────────────────────────────────
		//
		// A transition freezes the outgoing artwork into a throwaway layer and
		// animates THAT, leaving the real wallpaper element untouched. Live
		// animating the primary layer would force a compositor rebuild of a
		// decoding <video> on every frame; a still snapshot costs one paint.

		function transitionSpec() {
			const wp = state.wallpaper;
			const chosen = TRANSITIONS.find((t) => t.id === wp.transition);
			if (!chosen || chosen.id === "none" || chosen.ms <= 0) return null;
			// The OS "reduce motion" preference wins over the skin setting: a
			// full-screen wipe is exactly the kind of motion it asks us to drop.
			if (prefersReducedMotion()) return null;
			const speed = TRANSITION_SPEEDS.find((s) => s.id === wp.transitionSpeed);
			const ms = Math.round(chosen.ms * (speed ? speed.scale : 1));
			return { id: chosen.id, ms, dir: wp.transitionDir === "right" ? "right" : "left" };
		}

		function clearTransition() {
			if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }
			if (transitionEl) {
				try { transitionEl.remove(); } catch { /* ignore */ }
				transitionEl = null;
			}
			// Restore any layer a previous effect may have hidden. The current
			// design never hides the primary element (the snapshot covers it), but
			// this keeps teardown idempotent and self-healing.
			const el = document.getElementById(WALLPAPER_ID);
			if (el) el.style.visibility = "";
		}

		/**
		 * Keyframe pair for one effect. Web Animations needs per-property objects
		 * (camelCase keys) — `cssText` is not a valid keyframe field, so the
		 * declarations are assembled as plain objects and only stringified when
		 * they also need to be written as inline style.
		 */
		function transitionFrames(spec) {
			const sign = spec.dir === "right" ? 1 : -1;
			switch (spec.id) {
				case "fade":
					return [{ opacity: 1 }, { opacity: 0 }];
				case "slide":
					return [
						{ transform: "translateX(0%)", opacity: 1 },
						{ transform: `translateX(${sign * 100}%)`, opacity: 1 }
					];
				case "wipe":
					return [
						{ clipPath: "inset(0 0 0 0)" },
						{ clipPath: sign > 0 ? "inset(0 0 0 100%)" : "inset(0 100% 0 0)" }
					];
				case "iris":
					return [
						{ clipPath: "circle(120% at 50% 50%)" },
						{ clipPath: "circle(0% at 50% 50%)" }
					];
				case "zoom":
					return [
						{ transform: "scale(1)", opacity: 1 },
						{ transform: "scale(1.18)", opacity: 0 }
					];
				default:
					return [{ opacity: 1 }, { opacity: 0 }];
			}
		}

		/** Inline-style string mirroring a keyframe, for the no-WebAnimations path. */
		function frameToCss(frame) {
			return Object.keys(frame)
				.map((k) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${frame[k]};`)
				.join("");
		}

		/**
		 * Freeze the currently painted wallpaper into a disposable overlay layer.
		 * The layer is appended LAST, so at equal z-index it paints on top of the
		 * incoming artwork and can be animated away to reveal it.
		 *
		 * A video is grabbed to a canvas (same-origin, so our own uploads are
		 * never tainted; a cross-origin clip yields no snapshot and the caller
		 * falls back to a plain cut). A still simply reuses the same URL.
		 */
		function buildTransitionLayer() {
			const from = document.getElementById(WALLPAPER_ID);
			if (!from) return null;
			const layer = document.createElement("div");
			layer.id = TRANSITION_ID;
			layer.setAttribute("aria-hidden", "true");
			layer.style.cssText =
				"position:fixed;inset:0;z-index:-1;pointer-events:none;" +
				"background-size:cover;background-position:center;will-change:transform,opacity,clip-path;" +
				// Carry the live layer's filter onto the snapshot, otherwise a switch
				// would pop from unfiltered to filtered.
				`filter:${window.getComputedStyle(from).filter || "none"};`;
			if (from.tagName === "VIDEO") {
				try {
					const c = document.createElement("canvas");
					c.width = Math.max(1, Math.min(640, from.videoWidth || 640));
					c.height = Math.max(1, Math.round(c.width * ((from.videoHeight || 360) / (from.videoWidth || 640))));
					c.getContext("2d").drawImage(from, 0, 0, c.width, c.height);
					layer.style.backgroundImage = `url("${c.toDataURL("image/jpeg", 0.82)}")`;
				} catch {
					// Tainted (cross-origin clip): no snapshot is possible, so skip
					// the effect rather than flashing a placeholder colour.
					return null;
				}
			} else {
				// A still can reuse the exact same URL — no copy, no decode cost.
				const src = window.getComputedStyle(from).backgroundImage;
				if (!src || src === "none") return null;
				layer.style.backgroundImage = src;
			}
			(document.body || document.documentElement).appendChild(layer);
			return layer;
		}

		// Bumped on every switch so a slow readiness probe from an earlier
		// transition cannot resurrect its effect over a newer wallpaper.
		let transitionToken = 0;

		/**
		 * Begin a switch transition. Returns true when an effect is in flight, in
		 * which case the caller has already had its artwork replaced underneath
		 * the frozen layer.
		 *
		 * The effect is held at its first frame until the INCOMING source can
		 * actually paint. Starting immediately would animate the snapshot away
		 * from a not-yet-decoded image (or a <video> without its first frame),
		 * exposing the page base colour for a few frames — worse than a hard cut.
		 * A bounded wait keeps a dead source from stalling the switch forever.
		 */
		function runTransition(url, kind) {
			const spec = transitionSpec();
			if (!spec) { clearTransition(); return false; }
			clearTransition();
			const layer = buildTransitionLayer();
			if (!layer) return false;
			transitionEl = layer;
			const my = ++transitionToken;
			const frames = transitionFrames(spec);
			// Hold the opening frame (fully opaque, unclipped) while we wait. The
			// layer is appended last, so it covers the incoming artwork on its own —
			// no need to hide the primary element (hiding it would blank the
			// wallpaper outright if a restore path were ever missed).
			layer.style.cssText += frameToCss(frames[0]);

			const begin = () => {
				if (my !== transitionToken || !transitionEl) return;
				try {
					layer.animate(frames, {
						duration: spec.ms,
						easing: "cubic-bezier(.4,0,.2,1)",
						fill: "forwards"
					});
				} catch {
					layer.style.cssText += frameToCss(frames[1]);
				}
				transitionTimer = setTimeout(() => {
					transitionTimer = null;
					if (my !== transitionToken) return;
					clearTransition();
				}, spec.ms + 40);
			};

			// `whenSourceReady` resolves false on error/timeout rather than
			// rejecting, so a single `.then` is enough and no source can hang us.
			Promise.resolve()
				.then(() => whenSourceReady(url, kind))
				.then(() => begin())
				.catch(() => begin());
			return true;
		}

		// ── video power guard ──────────────────────────────────────────────
		//
		// A full-screen wallpaper <video> decodes every frame for the whole
		// session. On a laptop iGPU that is the single biggest idle cost of this
		// skin, and most of it is wasted: the frames are invisible while the
		// window is minimised or in the background, while an opaque backing layer
		// (panel opacity ≈ 100%) covers them, or when the OS asks for reduced
		// motion. Decide playback from every signal instead of blindly looping.
		function prefersReducedMotion() {
			try {
				return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
			} catch {
				return false;
			}
		}

		/**
		 * OS-level "reduce transparency" (macOS 降低透明度 / Windows 关闭透明效果)。
		 *
		 * 宿主的 layout CSS 自己就尊重这个开关（它会改用
		 * `color-mix(... sidebar-fill 90%, transparent)`），但本插件在 body 上
		 * 写的是内联变量，内联声明压过媒体查询里的规则 —— 于是系统设置了
		 * 「不要透明效果」，本插件仍然把面板全部压成半透明，用户的系统级
		 * 无障碍选择被静默无视。
		 *
		 * 处置不是关掉壁纸（那是用户的美术选择，不是无障碍问题），而是
		 * 只停用「全窗铺开」这一层：面板/菜单/侧栏行回到不透明底板，画布
		 * 仍按用户的不透明度透出壁纸。文字面不再和自己的背景打架。
		 */
		function prefersReducedTransparency() {
			try {
				return typeof matchMedia === "function" && matchMedia("(prefers-reduced-transparency: reduce)").matches;
			} catch {
				return false;
			}
		}

		/**
		 * 系统「降低透明度」在这台机器上是个**静默的隐形开关**：Windows
		 * 设置里「透明效果」关掉时 Chrome 报 reduce，于是「全窗铺开」整
		 * 层被跳过 —— 用户明明在面板里打开了铺开（state.ui.spread 为
		 * true），侧栏、面板、菜单却一个都不透，`data-km-spread` 从不
		 * 上身，看起来就像「换皮肤没反应」。
		 *
		 * 处置原则：**用户的显式开关优先于系统默认偏好**。
		 *   • 铺开照旧执行（用户点过那个 checkbox，那是明确意愿）；
		 *   • 但地板抬到 SOFTENED_FLOOR —— 面板仍留一块能读的底，不把
		 *     密排文字压到半透明的画面上；
		 *   • 只在运行时算，绝不写回 state.ui.floorScale（那是用户直接
		 *     掌握的滑条，安全余量不许变成他的设置值）。
		 */
		const SOFTENED_FLOOR = 0.62;

		// Two extra occlusion signals, both opt-in per the state flags: whether the
		// window currently holds focus, and whether the machine runs on battery.
		let windowFocused = true;
		let onBattery = false;

		/**
		 * Whether the skin is currently out of sight: minimised, on another tab,
		 * behind another window, or on battery (when that tier is on).
		 *
		 * This is the single gate every per-frame and periodic cost asks. Before
		 * it existed the three tiers only stopped the decoder, so a window that
		 * was merely *covered* still paid for the 8 s luminance readback and for
		 * the gradient drift animation — nothing was on screen, yet both kept
		 * running. Keeping one predicate means a new periodic job cannot forget
		 * to check it.
		 */
		function occlusionPaused() {
			const wp = state.wallpaper;
			if (!wp || wp.enabled === false) return false;
			if (typeof document === "undefined" || document.hidden) return true;
			// Another window is in front (maximised app, full-screen video, alt-tab
			// to anything): in Electron this is the OS window losing focus.
			if (wp.pauseBlur !== false && !windowFocused) return true;
			// Unplugged. Decoding 4K frames is the first thing to give up when the
			// machine is living on the battery.
			if (wp.pauseBattery !== false && onBattery) return true;
			return false;
		}

		function videoShouldPlay() {
			const wp = state.wallpaper;
			if (!wp || wp.enabled === false) return false;
			if (typeof document === "undefined" || document.hidden) return false;
			// Occlusion tier 2: another window is in front, so decode would be wasted.
			if (wp.pauseBlur !== false && !windowFocused) return false;
			// Occlusion tier 3: unplugged. Decoding 4K frames is the first thing to
			// give up when the machine is living on the battery.
			if (wp.pauseBattery !== false && onBattery) return false;
			if (prefersReducedMotion()) return false;
			// Orbit mode scrubs the clip by mouse instead of playing it, so no
			// decode loop should run.
			if (wp.orbit === true) return false;
			// A backing surface at full strength hides the video completely, so the
			// decoded frames would never be seen.
			if (clamp(wp.opacity, 0, 1) >= 0.995) return false;
			return true;
		}

		/** Push the playback-rate tier onto whichever layer(s) exist right now. */
		function applyPlaybackRate() {
			if (typeof document === "undefined") return;
			const rate = isFinite(Number(state.wallpaper && state.wallpaper.rate)) ? clamp(state.wallpaper.rate, RATE_MIN, RATE_MAX) : 1;
			for (const id of [WALLPAPER_ID, CROSS_ID]) {
				const el = document.getElementById(id);
				if (el && el.tagName === "VIDEO" && el.playbackRate !== rate) {
					try { el.playbackRate = rate; } catch { /* ignore */ }
				}
			}
		}

		function applyVideoPlayback() {
			if (typeof document === "undefined") return;
			const el = document.getElementById(WALLPAPER_ID);
			if (!el || el.tagName !== "VIDEO") return;
			// While crossfading the two layers are driven by the ticker, so the
			// guard only starts/stops that ticker instead of touching one node.
			if (crossEnabled()) { kickCross(); return; }
			stopCross();
			if (videoShouldPlay()) {
				el.muted = true;
				const played = el.play();
				if (played && typeof played.catch === "function") played.catch(() => { /* autoplay policy */ });
			} else {
				try { el.pause(); } catch { /* ignore */ }
			}
		}

		let powerHandler = null;
		let focusHandler = null;
		let batteryObj = null;
		let batteryBound = false;
		// 系统「降低透明度」的监听句柄：需要在系统设置变化时重跑 applyTokens()，
		// 否则一次判定管到进程结束（用户改完设置看不到任何变化）。
		let reducedTransparencyQuery = null;
		let transparencyHandler = null;

		function onBatteryChange() {
			onBattery = !!(batteryObj && batteryObj.charging === false);
			applyVideoPlayback();
			refreshGradientMotion();
		}

		function installPowerGuard() {
			if (powerHandler || typeof document === "undefined") return;
			powerHandler = () => {
				applyVideoPlayback();
				// 渐变的漂移动画不在 <video> 上，applyVideoPlayback() 管不到它。
				refreshGradientMotion();
			};
			document.addEventListener("visibilitychange", powerHandler, { passive: true });
			// 系统的「降低透明度」可能在运行中被切换（macOS 辅助功能面板、
			// Windows 设置里的透明效果开关）。它是**一次性判定**的输入项：
			// 不在变化时重算，用户改完要重启 DSH 才看得到效果 —— 那就等于
			// 又变成「设置不生效」。这里只重跑 token 层（轻量），不碰壁纸元素。
			try {
				if (typeof matchMedia === "function") {
					reducedTransparencyQuery = matchMedia("(prefers-reduced-transparency: reduce)");
					transparencyHandler = () => {
						try { applyTokens(); } catch (error) { diagReport("reduced-transparency-throw", String((error && error.message) || error)); }
					};
					if (typeof reducedTransparencyQuery.addEventListener === "function") {
						reducedTransparencyQuery.addEventListener("change", transparencyHandler);
					}
				}
			} catch { /* 不支持 reduced-transparency 的宿主静默跳过 */ }
			// Tier 2: focus/blur. `blur` in DSH fires both for the OS window losing
			// focus and for an embedded view stealing it; either way the frames are
			// not on screen, so the pause is safe and instantly reversible.
			windowFocused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
			focusHandler = () => {
				windowFocused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
				applyVideoPlayback();
				// 渐变壁纸没有 <video>，applyVideoPlayback() 直接 return，所以
				// 漂移动画的停/启必须单独重算一次 —— 否则它会一直保持 focus
				// 切换前的那个状态，直到用户下次碰到任何滑条。
				refreshGradientMotion();
			};
			window.addEventListener("focus", focusHandler, { passive: true });
			window.addEventListener("blur", focusHandler, { passive: true });
			// Tier 3: battery. The API is Chromium-only; absence just means the tier
			// stays off instead of throwing.
			try {
				const nav = typeof navigator === "undefined" ? null : navigator;
				if (nav && typeof nav.getBattery === "function") {
					Promise.resolve(nav.getBattery()).then((b) => {
						batteryObj = b;
						batteryBound = true;
						onBatteryChange();
						b.addEventListener("chargingchange", onBatteryChange);
					}).catch(() => { /* unsupported */ });
				}
			} catch { /* unsupported */ }
		}

		function uninstallPowerGuard() {
			// 「降低透明度」的监听必须独立于 powerHandler 拆除：它挂在
			// matchMedia 对象上，与 visibilitychange 不是同一批，且
			// powerHandler 已空时（极端时序）也不能漏掉它。
			if (reducedTransparencyQuery && transparencyHandler) {
				try { reducedTransparencyQuery.removeEventListener("change", transparencyHandler); } catch { /* ignore */ }
			}
			reducedTransparencyQuery = null;
			transparencyHandler = null;
			if (!powerHandler || typeof document === "undefined") return;
			document.removeEventListener("visibilitychange", powerHandler);
			powerHandler = null;
			if (focusHandler) {
				window.removeEventListener("focus", focusHandler);
				window.removeEventListener("blur", focusHandler);
				focusHandler = null;
			}
			if (batteryObj && batteryBound) {
				try { batteryObj.removeEventListener("chargingchange", onBatteryChange); } catch { /* ignore */ }
			}
			batteryObj = null;
			batteryBound = false;
			onBattery = false;
			windowFocused = true;
		}

		// ── film-grain overlay ─────────────────────────────────────────────
		//
		// A tiled SVG turbulence tile painted at low opacity over the artwork.
		// It is a cheap, static texture — no per-frame work and no canvas, just
		// one repeated background image guarded by a single element.

		function removeGrainEl() {
			const g = document.getElementById(GRAIN_ID);
			if (g) g.remove();
		}

		// ── acrylic (frosted glass) ────────────────────────────────────────
		//
		// Two independent surfaces:
		//   1. the drawer panel — a real backdrop-filter over whatever is behind it
		//   2. the wallpaper itself — a blur + saturation frost applied to the
		//      artwork layer, without touching the app's own surfaces
		//
		// A note on the old "backdrop-filter is unsafe here" verdict: that applied
		// to liteglass, which painted the filter across the whole app SHELL and so
		// re-anchored every descendant `position:fixed` to that element (the
		// settings page slid into the sidebar). The drawer is a single self-contained
		// node with no fixed descendants, and it ALREADY establishes a containing
		// block via its own `transform` + `z-index`. Adding backdrop-filter to it
		// therefore changes nothing about descendant positioning.

		/** `backdrop-filter` value for a given blur radius (0 disables). */
		function acrylicFilter(amount) {
			if (!(amount > 0)) return "";
			return `blur(${amount.toFixed(1)}px) saturate(1.35)`;
		}

		// ── app-surface frost ──────────────────────────────────────────────
		//
		// The drawer's acrylic above only ever covered `panelEl`（本插件自己的
		// 抽屉）。把地板清到 0、壁纸不透明度压到 0.08 之后，**宿主自己的**
		// 输入卡与设置页就变成「文字直接压在照片上」——那是最难读的状态。
		// 它们不吃 `--dsw-*` 的 background（已经被铺开层扒成透明），所以只能
		// 靠 `backdrop-filter` 在它们背后就地糊一层玻璃：字还在最上面，
		// 底下的画面被磨砂，对比度回来，壁纸也不再被整块遮死。
		//
		// 复用同一组 `ui.glass` 参数（设置面板「面板毛玻璃 / 玻璃通透度」两根
		// 滑条），不新增控件：用户调一次，抽屉与宿主面一起变。
		const FROST_ATTR = "data-km-frost";
		const FROST_STYLE_ID = "dsh-skin-keymark-frost";
		const FROST_FILTER_VAR = "--km-frost";
		const FROST_TINT_VAR = "--km-frost-tint";
		// 宿主面比抽屉大得多，同半径的模糊会贵得多，观感上也更容易糊过头，
		// 所以这里对滑条值打个折。
		const FROST_SCALE = 0.75;
		// 输入卡/dock 行自带的模糊半径。它们只盖住一小块区域，用不着
		// 大半径；10px 刚好把卡片后面透上来的对话文字糊成色块，
		// 又不会把壁纸本身抹平。
		const FROST_CARD_BLUR = 18;
		// 输入卡在"全窗铺开"下的底色地板。卡片是一块固定面积、悬在壁纸
		// 之上的表面，如果跟画布一样降到 8%，它就会变成"一扇窗"——
		// 背后是什么颜色就显示什么颜色。实测三次：卡内比同高度的画布
		// 亮 92.7/85.6/85.7（0.08 时），把卡片整个隐藏后亮度几乎不变
		// （152.2 → 152.3），说明亮面来自背后的壁纸而不是卡片自己。
		// 0.78 是实测里卡内外基本同色（Δ 0.8/2.4/1.7）的那一档；
		// 0.60 仍差 26/26/27，0.88 起反而比画布更暗（-12.9/-11.3/-11.8）。
		const FROST_CARD_FLOOR_SPREAD = 0.78;
		// 卡片相对画布的那点抬升（与侧栏 sideLift 同一个思路）：地板被关到
		// 0 时卡片仍要严格实于画布一丁点，否则输入框与正文糊在同一层里，
		// 光标的落点都看不清。0.03 是侧栏铺开档用的同一量级 —— 看得出托底，
		// 看不出接缝。
		const CARD_LIFT_SPREAD = 0.03;
		// 地板档不能直接拿 `cardBase` 去铺。`cardBase` 已经混过 70% 的
		// 强调色（midnight 下是 116,134,179 的亮蓝），按 0.78 铺出来
		// 会变成一块亮蓝板 —— 实测 Δ 70/81/104，比修复前更刺眼。
		// 实验里"卡内外同色"那一档用的是压深后的基色 28,33,45。
		// 这里把 cardBase 朝深锚点推到 85%，得到同一片明度：
		//   13 + (116-13)*0.15 ≈ 28 / 16 + (134-16)*0.15 ≈ 34 / 21 + (179-21)*0.15 ≈ 45
		// 浅色主题同理朝近白推，不然浅色下卡片会变成一块暗板。
		const FROST_CARD_DEEP_ANCHOR_DARK = "#0d1015";
		const FROST_CARD_DEEP_ANCHOR_LIGHT = "#f7fafd";
		const FROST_CARD_DEEP_MIX = 0.85;
		// 输入卡/dock 行的投影。不能沿用浮层那套大半径深投影：
		// 卡片与 dock 行都是通栏宽，36px 大半径黑投影会在四周铺出一圈灰云，
		// 叠在壁纸上看起来就是「输入框外面套了个黑框」，而且 dock 与卡的
		// 投影在两者之间重叠加倍，正是用户报的「重叠」。这里改成贴着边缘的
		// 极轻投影，只负责把玻璃与壁纸分开一点点。
		const FROST_CARD_SHADOW_DARK = "0 1px 3px rgba(0,0,0,.22)";
		const FROST_CARD_SHADOW_LIGHT = "0 1px 3px rgba(15,23,42,.10)";
		// 只认**后缀锚定**的容器，不写死 `mP3x-q_` 这类构建期哈希类名 ——
		// 宿主每次升级都会换前缀，写死等于下次升级静默失效。
		//   · `_composerSeat` / `data-queue-dock`：输入区与闲时队列 dock
		//   · `_overlay > _panel`：设置页整块面板（settings-general 的
		//     `.AnXs9G_overlay > .AnXs9G_panel`，`background:var(--dsw-alias-bg-layer-2)`）
		//   · `_dialog` / `_popover` / `_popover-card`：弹窗类浮层
		// 两组目标必须分开：正文区（输入座位）用户明确要求「不糊」，
		// 而设置页/弹层用户明确要求「亚克力一点」—— 同一个 blur 滑条
		// 没法同时表达这两种诉求，所以浮层单独一档，且**不受 blur=0 关闭**。
		const FROST_SURFACE_TARGETS = [
			// 输入卡与 dock 行各自一块玻璃，**座位本身不给底色**。
			// 早先把座位也糊上，座位（通栏、圆角 16px）与卡片（宽度只有
			// card-max-width、radius-panel）两块矩形边线错开，视觉上就是
			// 用户说的「重叠」——两条贴得很近却不重合的边。
			// 现在座位只做透明容器，玻璃由卡与 dock 行各自提供，两块
			// 玻璃用同一个 alpha 变量，观感统一。
			'[class*="_composerSeat"] [class*="_card"]',
			// 输入区元素（_input）本身**不再单独成玻璃**：它铺在卡片里侧、
			// 四角圆度与卡片不同，再加一层 tint 就在卡内多出一个深色圆角矩形，
			// 看起来正是用户报的「重叠」。玻璃只由卡片这一层提供。
			// dock 行**不给玻璃**：它与输入卡走两条不同的宽度链（dock 由
			// composerStack 决定、卡由 composer-card-max-width 决定），实测
			// dock 972px 左缘 288、卡 818px 左缘 365 —— 两块玻璃错开 77px，
			// 正好是用户说的「重叠」。dock 只放文字，透明行即可，不再与卡争位置。
		];
		// 浮层族：设置页整块面板、设置页遮罩、各类 dialog/popover。
		// `.AnXs9G_panel` 自带 `background:var(--dsw-alias-bg-layer-2)`，而
		// 该令牌被 dsh-claude-style 在深色下写死成不透明 `#282828` ⇒ 全透
		// 皮肤下它仍是一块实心黑板。这里把底色换成半透明 tint + 真模糊。
		const FROST_LAYER_TARGETS = [
			// 用**后代**而不是子选择器：宿主 `.AnXs9G_overlay > .AnXs9G_panel`
			// 之间可能还夹着包装层（实测子选择器命中 0），后代写法对两种结构都成立。
			'[class*="_overlay"] [class*="_panel"]',
			'[class*="_overlay"] [class*="_content"]',
			'[class*="_dialog"]',
			'[class*="_popover"]',
			'[class*="_popover-card"]'
		];
		// 第三方插件自己的浮层面板。它们不在宿主的 `_overlay`/`_dialog`/
		// `_popover` 命名空间里，所以上面那张表一个都命中不了，全透皮肤下
		// 它们只剩自己那层 8% 的半透明令牌 —— 背后的会话列表直接透上来，
		// 与面板里的文字叠成乱码（用户报的就是「点开互联面板背景透明、
		// 干扰阅读」）。
		//
		// 名字是逐个查出来的，不是猜的：全 profile 扫过
		// `panel|drawer|sheet|popover|flyout|overlay|dropdown|tooltip` 的
		// 类名全集，浮层族一共只有四个，且这几个名字在其余插件里零碰撞。
		// 用精确类名而不是 `[class*="__panel"]` 这种前缀：双下划线在
		// BEM 里太常见，宽前缀会把内容卡片一起变成玻璃。
		//
		// 只收「底板读 `--dsw-alias-bg-layer-2`」的那两个（实测它们的
		// background 就是该令牌，而该令牌在铺开模式下被压到 0.08）。
		// 另外两个故意不收：
		//   • `usg_panel`（用量/余额）读 `--dsw-specific-menu`，已经有
		//     0.72 的浮层地板 + 宿主 40px 菜单模糊，观感正是用户认可的
		//     「纯黑毛玻璃」；再套一层 0.36 的 tint 只会把它变淡。
		//   • `tqdCrG_drawer` 读 `--dsw-specific-tip`，地板 0.55，本身
		//     不透明，不构成「透到看不清字」。
		const FROST_FLOAT_TARGETS = [
			'[class*="dsh-mobile-control__panel"]',
			'[class*="dsh-mobile-control__provider-info-popover"]'
		];
		// 浮层专用参数：blur 滑条为 0 时正文区保持不糊，浮层仍按这组走。
		const FROST_OVERLAY_BLUR = 14;
		const FROST_OVERLAY_ALPHA = 0.38;
		// 曾经这里还有一个 `FROST_OVERLAY_VAR = "--km-frost-ov"`：它是最早那版
		// 「一整条 backdrop-filter 字符串」方案的残留，后来拆成 tint / mask 两个
		// 变量就没人读了。留着它只会让下一次改浮层的人误以为是活变量，故删除。
		const FROST_OVERLAY_TINT_VAR = "--km-frost-ov-tint";
		const FROST_OVERLAY_MASK_VAR = "--km-frost-ov-mask";
		// 输入卡/dock 行的底色。必须由 applyTokens 每帧写（那里才知道
		// 壁纸 alpha），不能直接读 `--dsw-alias-bg-base` —— 该令牌被
		// dsh-claude-style 的属性选择器在元素级改成不透明 `#191919`，
		// 卡片读到的就是纯色，反而比周围更实。
		const FROST_CARD_TINT_VAR = "--km-card-fill";
		// 第三方浮层面板的底色。与 `--km-frost-ov-tint`（设置页那层薄玻璃）
		// 刻意分开：设置页面板背后是自己那块半透明画布，0.2 上下就够；
		// 而这些浮层是**悬在正文之上**的一块独立面板，背后是会话列表的
		// 密集文字，没有同 alpha 的底板可借 —— 给太低就是用户报的
		// 「背景透明、干扰阅读」。所以它自己带一个 0.72 起的地板。
		const FROST_FLOAT_TINT_VAR = "--km-float-fill";

		/**
		 * 玻璃质感参数（参照 macOS Vibrancy / iOS 控制中心的观感）：
		 * ① 模糊之外还要抬饱和与亮度 —— 只 blur 会把画面洗成灰浆，抬饱和才
		 *    让透出来的壁纸「有色」；② 顶缘一道 1px 亮线模拟受光面；③ 四周
		 *    一圈极淡的内描边把玻璃和背后的画面分开，避免边界糊掉；④ 外投
		 *    影让面板浮起来，而不是贴在壁纸上。
		 */
		const FROST_SATURATE = 1.7;
		const FROST_BRIGHTNESS = 1.06;
		const FROST_RIM = "inset 0 1px 0 rgba(255,255,255,0.14)," +
			"inset 0 0 0 1px rgba(255,255,255,0.055)";
		const FROST_DROP_DARK = "0 12px 36px rgba(0,0,0,0.34)";
		const FROST_DROP_LIGHT = "0 12px 36px rgba(15,23,42,0.14)";
		// 真实亚克力/毛玻璃都带极细颗粒：没有颗粒的纯 blur 会显得「像糊了一层
		// 塑料膜」，有颗粒才读得出是材质。用 feTurbulence 生成、baseFrequency
		// 高、不透明度极低，只贡献质感不贡献明暗。
		/** 当前是否需要真的做模糊：blur 为 0 时整层退化成平铺底色。 */
		function isFrostBlurring() {
			const g = state && state.ui && state.ui.glass ? state.ui.glass : null;
			return !!(g && clamp(g.blur, 0, 40) > 0);
		}

		const FROST_GRAIN =
			"url(\"data:image/svg+xml," +
			"%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E" +
			"%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E" +
			"%3C/filter%3E" +
			"%3Crect width='120' height='120' filter='url(%23g)' opacity='0.10'/%3E" +
			"%3C/svg%3E\")";

		function frostCss() {
			const sel = FROST_SURFACE_TARGETS.map((s) => "body[" + FROST_ATTR + "] " + s).join(",");
			const layerSel = FROST_LAYER_TARGETS.map((s) => "body[" + FROST_ATTR + "] " + s).join(",");
			const floatSel = FROST_FLOAT_TARGETS.map((s) => "body[" + FROST_ATTR + "] " + s).join(",");
			const drop = isDarkTheme() ? FROST_DROP_DARK : FROST_DROP_LIGHT;
			return (
				// 浮层（设置页/弹层）：恒定亚克力，与正文区的 blur 滑条解耦。
				// 半透明 tint + 真模糊 + 一圈描边，让字压在模糊后的壁纸上能看清，
				// 同时保留「背后有画」的亚克力观感 —— 用户要的正是这一档。
				layerSel + "{" +
				"backdrop-filter:blur(" + FROST_OVERLAY_BLUR + "px) saturate(" + FROST_SATURATE + ") brightness(" + FROST_BRIGHTNESS + ") !important;" +
				"-webkit-backdrop-filter:blur(" + FROST_OVERLAY_BLUR + "px) saturate(" + FROST_SATURATE + ") brightness(" + FROST_BRIGHTNESS + ") !important;" +
				"background-color:var(" + FROST_OVERLAY_TINT_VAR + ") !important;" +
				"box-shadow:" + FROST_RIM + "," + drop + " !important" +
				"}" +
				// 第三方插件自己的浮层面板：同样走亚克力，但底色换成一个
				// 有地板的实色（`--km-float-fill`，0.72 起）。原因见
				// FROST_FLOAT_TINT_VAR 的注释：它们悬在正文之上，背后
				// 是会话语料，没有画布 alpha 可借。模糊半径比设置页那档
				// 再大一点（+6px），因为背后文字更密、面积更小。
				floatSel + "{" +
				"backdrop-filter:blur(" + (FROST_OVERLAY_BLUR + 6) + "px) saturate(" + FROST_SATURATE + ") brightness(" + FROST_BRIGHTNESS + ") !important;" +
				"-webkit-backdrop-filter:blur(" + (FROST_OVERLAY_BLUR + 6) + "px) saturate(" + FROST_SATURATE + ") brightness(" + FROST_BRIGHTNESS + ") !important;" +
				"background-color:var(" + FROST_FLOAT_TINT_VAR + ") !important;" +
				"box-shadow:" + FROST_RIM + "," + drop + " !important" +
				"}" +
				// 设置页遮罩本来就带 `background:var(--dsw-alias-bg-mask-1)` +
				// `backdrop-filter:var(--dsw-mask-blur)`；全透皮肤下遮罩若仍是实色，
				// 面板再亚克力也白搭（外面一圈死黑）。压暗但保留透明。
				"body[" + FROST_ATTR + "] [class*=\"_overlay\"] [class*=\"_mask\"]{" +
				"background-color:var(" + FROST_OVERLAY_MASK_VAR + ") !important;" +
				"backdrop-filter:blur(8px) !important;" +
				"-webkit-backdrop-filter:blur(8px) !important" +
				"}" +
				sel + "{" +
				// 输入卡/输入座位的底色改成与画布同一个变量（--km-canvas-fill），
				// 这样它和四周面板是同一个 alpha —— 用户要的「跟后面的透明度同步」。
				// 但底色降到画布级以后，卡片后面的对话文字会直接透上来，与
				// 「输入 / 以使用命令」叠成乱码；所以给这一类面挂一层小半径
				// blur：字被糊成色块、看不出笔画，玻璃本身仍然是透的。
				//
				// **输入端不加 saturate / brightness 的提亮**（2026-11-20 实测）：
				// 那两个算子本来是给「浮起来的浮层」用的，放在贴底的输入卡上就会
				// 让这一块比四周亮一档、蓝一档 —— 用户报的「这一块颜色不一样」。
				// 同一帧上逐项摘除测得的贡献（卡片区均值 − 正上方画布区均值）：
				//   带 saturate(1.7)+brightness(1.06)+颗粒 → (9.7, 10.6, 20.0)
				//   去掉 brightness                          → (3.8,  4.9, 13.3)
				//   去掉 saturate                            → (9.4, 11.4, 13.4)
				//   两个都去掉（只留 blur）                   → (3.5,  5.6,  7.0)
				// 即：蓝通道的 13/20 来自 saturate —— 卡片底色是混过强调色的冷蓝，
				// 再乘 1.7 倍饱和度就把「比周围蓝」放大到一眼可见。输入卡与画布
				// 同一个 alpha，本来就不该有提亮。
				"backdrop-filter:blur(" + FROST_CARD_BLUR + "px) !important;" +
				"-webkit-backdrop-filter:blur(" + FROST_CARD_BLUR + "px) !important;" +
				// 输入卡/dock 行的底色取 `--km-card-fill`：由 applyTokens
				// 每帧写成与画布完全相同的 rgba（同一个 alpha），所以卡片
				// 与四周面板天生同透 —— 这正是用户要的「跟后面的透明度同步」。
				// 不能直接读 `--dsw-alias-bg-base`：那个令牌被 claude-style
				// 在元素级改成不透明 `#191919`，卡片会反而比周围更实。
				"background-color:var(" + FROST_CARD_TINT_VAR + ",var(" + FROST_TINT_VAR + ")) !important;" +
				(isFrostBlurring() ? "background-image:" + FROST_GRAIN + " !important;background-blend-mode:overlay !important;" : "background-image:none !important;") +
				"box-shadow:" + (isDarkTheme() ? FROST_CARD_SHADOW_DARK : FROST_CARD_SHADOW_LIGHT) + " !important" +
				"}" +
				// 输入座位只是贴底的布局容器，**不给它任何底色**。
				// 早先这里画过一条 36px 渐隐带，用来把座位与壁纸过渡开；
				// 但它比输入卡宽（座位=通栏，卡片=card-max-width）、圆角也不同，
				// 两条边线贴在一起就是用户报的「重叠」。去掉后，
				// 玻璃由输入卡与 dock 行各自提供，座位彻底透明。
				"body[" + FROST_ATTR + "] [class*=\"_composerSeat\"]{" +
				"background-color:transparent !important;" +
				"background-image:none !important;" +
				"border-radius:0 !important;" +
				"box-shadow:none !important" +
				"}"
			);
		}

		/**
		 * 把 `ui.glass` 换算成宿主面的毛玻璃层。blur = 0 时整层撤掉并清空
		 * body 上的两个变量 —— 否则关掉滑条后 body 会留着一份没人读的声明。
		 */
		function applyFrostSurface(blur, tint) {
			const body = document.body;
			if (!body) return;
			const style = document.getElementById(FROST_STYLE_ID);
			const hasBlur = blur > 0;
			// 模糊与底色是两个效果，不是一个开关：
			//   blur > 0  → 模糊负责可读性，底色只做很淡的一层（原行为）；
			//   blur == 0 → 不要任何 backdrop-filter（用户嫌糊），改由平铺
			//               底色单独撑可读性，alpha 必须反过来抬高，否则
			//               字直接压在壁纸上。
			const alpha = hasBlur
				? clamp(0.34 - blur * 0.004 - (1 - tint) * 0.12, 0.08, 0.5)
				: clamp(0.20 + tint * 0.42, 0, 0.64);
			// 正文区在 blur=0 时可以整层撤掉；但**浮层永远保留**（设置页要亚克力）。
			const bodySurfaceOn = hasBlur || alpha > 0;
			body.setAttribute(FROST_ATTR, "");
			if (bodySurfaceOn) {
				body.style.setProperty(
					FROST_FILTER_VAR,
					hasBlur
						? `blur(${(blur * FROST_SCALE).toFixed(1)}px) saturate(${FROST_SATURATE}) brightness(${FROST_BRIGHTNESS})`
						: "none"
				);
				const base = isDarkTheme() ? "22,22,24" : "252,252,254";
				body.style.setProperty(FROST_TINT_VAR, `rgba(${base},${alpha.toFixed(3)})`);
			} else {
				body.style.removeProperty(FROST_FILTER_VAR);
				body.style.removeProperty(FROST_TINT_VAR);
			}
			// 浮层三个变量：底色、遮罩底色。深色底压暗一点、浅色提亮，
			// 保证「字在模糊层上」的对比度稳定，而不依赖壁纸本身明暗。
			const ovBase = isDarkTheme() ? "30,30,33" : "250,250,252";
			const ovAlpha = isDarkTheme() ? FROST_OVERLAY_ALPHA : 0.58;
			const maskAlpha = isDarkTheme() ? 0.34 : 0.24;
			body.style.setProperty(FROST_OVERLAY_TINT_VAR, `rgba(${ovBase},${ovAlpha.toFixed(3)})`);
			body.style.setProperty(FROST_OVERLAY_MASK_VAR, `rgba(0,0,0,${maskAlpha.toFixed(3)})`);
			// 第三方浮层面板的地板色。0.62 起（用户把玻璃通透度拉到最低时
			// 仍能读清），通透度给到满时抬到 0.78 —— 它悬在正文之上，
			// 不该比设置页面板更透。applyTokens 会用画布 alpha 再算一次
			// （那里才知道壁纸不透明度），这里只是保证首次挂载就有值。
			const floatAlpha = clamp(0.62 + clamp(tint, 0, 1) * 0.16, 0, 0.96);
			body.style.setProperty(FROST_FLOAT_TINT_VAR, `rgba(${ovBase},${floatAlpha.toFixed(3)})`);
			applyTextGuard(hasBlur ? alpha : alpha);
			const css = frostCss();
			if (style) {
				if (style.textContent !== css) style.textContent = css;
				return;
			}
			const el = document.createElement("style");
			el.id = FROST_STYLE_ID;
			el.textContent = css;
			(document.head || document.documentElement).appendChild(el);
		}

		/**
		 * Apply frosted glass to the drawer. The panel keeps its own token-driven
		 * background, but its alpha is pulled down as the blur rises, otherwise an
		 * opaque layer would hide exactly the thing being blurred.
		 */
		function applyAcrylic() {
			if (!panelEl) return;
			// 抽屉玻璃只在抽屉形态下有意义。被设置页接走后面板是一块普通内容，
			// 再给它画 backdrop-filter + 半透明底会在设置页里叠出第二层玻璃，
			// 而且会盖住宿主自己的 options 背景。这里只负责把之前写过的清干净。
			if (panelEl.getAttribute("data-hosted") === "true") {
				panelEl.style.removeProperty("backdrop-filter");
				panelEl.style.removeProperty("-webkit-backdrop-filter");
				panelEl.style.removeProperty("background");
				return;
			}
			const g = state.ui && state.ui.glass ? state.ui.glass : { blur: 0, tint: 1 };
			const blur = clamp(g.blur, 0, 40);
			const filter = acrylicFilter(blur);
			if (filter === "") {
				panelEl.style.removeProperty("backdrop-filter");
				panelEl.style.removeProperty("-webkit-backdrop-filter");
				panelEl.style.removeProperty("background");
				return;
			}
			panelEl.style.setProperty("backdrop-filter", filter);
			panelEl.style.setProperty("-webkit-backdrop-filter", filter);
			// Reuse the theme's own overlay colour so the tint tracks light/dark,
			// then dial its alpha by the user's 通透度. Higher blur ⇒ lower alpha,
			// which is what makes it read as glass instead of fog.
			//
			// This alpha is this plugin's OWN surface only. It is not a wallpaper
			// setting and does not touch the artwork's filter chain.
			const tint = clamp(g.tint, 0, 1);
			const alpha = clamp(0.72 - blur * 0.012 - (1 - tint) * 0.3, 0.12, 0.9);
			const base = isDarkTheme() ? "22,22,24" : "252,252,254";
			panelEl.style.setProperty("background", `rgba(${base},${alpha.toFixed(3)})`);
		}

		/**
		 * 宿主面的毛玻璃。与 `applyAcrylic` 共用参数但落在另一层 CSS：
		 * 抽屉是单个节点、可以就地写 style；宿主面是一族容器、且会随路由
		 * 反复挂载，只能靠一条常驻 `<style>` + body 变量。
		 */
		function applyFrost() {
			const g = state.ui && state.ui.glass ? state.ui.glass : { blur: 0, tint: 1 };
			applyFrostSurface(clamp(g.blur, 0, 40), clamp(g.tint, 0, 1));
		}

		/**
		 * 正文可读性兜底：面板够透时，给正文补一层极轻的文字阴影。
		 * 这是「不模糊也要看得清」的另一半 —— 底色只压住背景亮度，
		 * 字的轮廓靠阴影从壁纸里拔出来，比加深底色更不损失通透感。
		 */
		function applyTextGuard(alpha) {
			const body = document.body;
			if (!body) return;
			const id = "dsh-skin-keymark-textguard";
			let el = document.getElementById(id);
			const strong = alpha < 0.9;
			if (!strong) { if (el) el.remove(); return; }
			const css =
				"body{" +
				"--km-text-shadow:0 1px 1px rgba(0,0,0,.34)" +
				"}" +
				// text-shadow 会继承：挂在容器上就够了，不必枚举每个内联标签。
				// 用继承而非逐个命中，是为了让 markdown 里任意深度的文字都吃到，
				// 同时不碰代码块（它们有自己的底色，加阴影反而脏）。
				"body[data-km-spread] [data-pane=conversation]{text-shadow:var(--km-text-shadow)}" +
				"body[data-km-spread] [class*=\"_composerSeat\"]{text-shadow:var(--km-text-shadow)}" +
				"body[data-km-spread] [class*=\"_composerSeat\"] :is(pre,code)" +
				"{text-shadow:none !important}";
			if (el) { if (el.textContent !== css) el.textContent = css; return; }
			el = document.createElement("style");
			el.id = id;
			el.textContent = css;
			(document.head || document.documentElement).appendChild(el);
		}

		/**
		 * 正文字体：宿主默认栈的第二个中文字是 `"PingFang SC"`，而 Windows
		 * 上这个家族通常来自第三方移植的 `pingfang_yahei.ttc`，14px 下
		 * hinting / 字重 / 字距都和 macOS 原生差很远，笔画发虚、字重不稳。
		 * 这里把 `--dsw-font-family` 与 `--ds-font-family-code` 直接改成本机
		 * 已安装的原生家族，宿主文件一个字都不用动。
		 */
		const FONT_ATTR = "data-km-font";
		const FONT_STYLE_ID = "dsh-skin-keymark-font";
		const FONT_PRESETS = {
			system: "\"Microsoft YaHei UI\", \"Microsoft YaHei\", \"Segoe UI\", system-ui, sans-serif",
			noto: "\"Noto Sans SC\", \"Microsoft YaHei UI\", \"Segoe UI\", system-ui, sans-serif",
			oppo: "\"OPPO Sans\", \"Microsoft YaHei UI\", \"Segoe UI\", system-ui, sans-serif",
			// 更「圆」的两族：幼圆是本机唯一的中文圆体（笔画端点收圆、结构偏方块），
			// Arial Rounded MT Bold 是唯一西文圆体，用它托住拉丁与数字，避免中文
			// 圆、西文方的错位感。
			youyuan: "\"YouYuan\", \"幼圆\", \"Arial Rounded MT Bold\", \"Microsoft YaHei UI\", sans-serif",
			// 微软正黑体（JhengHei）笔画比方正黑体更厚、字面更大，同字号下明显「粗一点」。
			jhenghei: "\"Microsoft JhengHei UI\", \"Microsoft JhengHei\", \"Microsoft YaHei UI\", \"Segoe UI\", sans-serif",
			stock: ""
		};
		const FONT_CODE = "\"Cascadia Code\", \"JetBrains Mono\", Consolas, \"Microsoft YaHei UI\", monospace";
		// 面板下拉的显示名，与 FONT_PRESETS 的键一一对应。
		const FONT_LABELS = {
			system: "微软雅黑（系统原生）",
			noto: "Noto Sans SC",
			oppo: "OPPO Sans",
			youyuan: "幼圆（圆体）",
			jhenghei: "微软正黑体（更粗）",
			stock: "跟随宿主"
		};

		function fontFamilySpec(id) {
			const key = typeof id === "string" && Object.prototype.hasOwnProperty.call(FONT_PRESETS, id) ? id : "system";
			return { id: key, family: FONT_PRESETS[key] };
		}

		function applyFontFamily() {
			const body = document.body;
			if (!body) return;
			const spec = fontFamilySpec(state.ui && state.ui.fontFamily);
			const smooth = !(state.ui && state.ui.fontSmoothing === false);
			const id = FONT_STYLE_ID;
			let el = document.getElementById(id);
			if (spec.family === "" && !smooth) {
				body.style.removeProperty("--dsw-font-family");
				body.style.removeProperty("--ds-font-family-code");
				body.removeAttribute(FONT_ATTR);
				if (el) el.remove();
				return;
			}
			if (spec.family !== "") {
				// 两组变量都要写：
				// ① 宿主自己的 --dsw-font-family / --dsh-font-family-text(-default)；
				// ② dsh-claude-style 在 `body[data-dsh-claude-style][data-dsh-claude-typeface=claude]`
				//    上另起的一套 --dsh-claude-font-prose/serif/code/brand —— 思考块
				//    正文（span._text_…）读的正是 font-family:var(--dsh-claude-font-prose)，
				//    它排在前面的 "Anthropic Serif Web Text" / "Claude Style Noto Serif"
				//    在本机都不存在，于是 Latin 落到 Georgia+Times New Roman（衬线）、
				//    中文落到 Noto Sans SC/PingFang（黑体）—— 衬线拉丁混黑体中文，
				//    就是「字体怪怪的看着不舒服」的真正来源。
				body.style.setProperty("--dsw-font-family", spec.family);
				body.style.setProperty("--dsh-font-family-text", spec.family);
				body.style.setProperty("--dsh-font-family-text-default", spec.family);
				body.style.setProperty("--ds-font-family-code", FONT_CODE);
				body.style.setProperty("--dsh-claude-font-prose", spec.family);
				body.style.setProperty("--dsh-claude-font-serif", spec.family);
				body.style.setProperty("--dsh-claude-font-brand", spec.family);
				body.style.setProperty("--dsh-claude-font-code", FONT_CODE);
			} else {
				body.style.removeProperty("--dsw-font-family");
				body.style.removeProperty("--dsh-font-family-text");
				body.style.removeProperty("--dsh-font-family-text-default");
				body.style.removeProperty("--ds-font-family-code");
				body.style.removeProperty("--dsh-claude-font-prose");
				body.style.removeProperty("--dsh-claude-font-serif");
				body.style.removeProperty("--dsh-claude-font-brand");
				body.style.removeProperty("--dsh-claude-font-code");
			}
			body.setAttribute(FONT_ATTR, spec.id);
			// Windows 上 Chrome 默认用 ClearType（子像素）渲染，浅色壁纸上会
			// 出现彩边；灰度抗锯齿（antialiased）把彩边去掉，笔画也更匀。
			const css = smooth
				? "body{" + "-webkit-font-smoothing:antialiased;" + "-moz-osx-font-smoothing:grayscale;" + "text-rendering:optimizeLegibility" + "}"
				: "";
			// 字重：宿主把 font-weight 写死在各处（400×16 / 500×8 / 600×6 / 700×3），
			// 没有任何 --dsh-*-font-weight 变量可覆盖 ⇒ 只能对正文容器强制。
			// 只加在消息正文与 markdown 块上，不碰按钮/标签/代码，避免整屏变糊。
			const fw = clamp(isFinite(Number(state.ui && state.ui.fontWeight)) ? Number(state.ui.fontWeight) : 400, 300, 800);
			// 全局生效：宿主把字重写死在各处（侧边栏导航项 500、设置页标题 600、
			// 正文 400…），只给消息正文加规则会出现「对话里粗、侧边栏和设置里细」
			// 的割裂感。做法是先把 body 的字重设成目标值，再让所有元素 `inherit`
			// ——inherit + !important 能压过各处写死的 400/500/600，又不改变层级
			// 关系（标题原本靠字号而不是字重区分）。三类例外必须排除：
			//   ① SVG 图标（不受 font-weight 影响，但 `svg *` 会被规则命中、
			//      个别图标用 stroke-width 模拟字重，命中后无副作用，留着更省心）；
			//   ② 等宽代码块（变粗会糊，且代码本身靠背景区分）；
			//   ③ 自己不需要：pseudo-element 由父元素继承，无需单独处理。
			const cssWeight = fw > 400
				? "body{font-weight:" + fw + " !important}" +
					"body *:not(svg):not(svg *){font-weight:inherit !important}" +
					"body :is(b,strong){font-weight:" + Math.min(800, fw + 100) + " !important}" +
					"body :is(pre,code,kbd,samp),body :is(pre,code,kbd,samp) *{font-weight:400 !important}"
				: "";
			const cssAll = css + cssWeight;
			if (el) {
				if (el.textContent !== cssAll) el.textContent = cssAll;
			} else {
				el = document.createElement("style");
				el.id = id;
				el.textContent = cssAll;
				(document.head || document.documentElement).appendChild(el);
			}
			// 自报实际生效的家族：只有写进 computed style 才算真生效 —— 只改
			// :root 的默认栈、或只改 --dsw-font-family，都可能被更靠内的规则盖掉。
			try {
				// 不依赖某个具体 pane 选择器：直接扫「有文字的元素」，按家族计数，
				// 报最多的那一族与它的样本节点。宿主改 DOM 结构时这条探针不失效。
				const seen = new Map();
				const all = document.querySelectorAll("body *");
				for (let i = 0; i < all.length && i < 4000; i++) {
					const el2 = all[i];
					if (!el2.firstChild || el2.firstChild.nodeType !== 3) continue;
					const t = (el2.textContent || "").trim();
					if (t.length < 4) continue;
					const cs = getComputedStyle(el2);
					const fam = cs.fontFamily || "";
					const key = fam + " § " + cs.color;
					const rec = seen.get(key) || { n: 0, sample: "" };
					rec.n += 1;
					if (!rec.sample) rec.sample = el2.tagName.toLowerCase() + "." + String(el2.className || "").slice(0, 24) + " :: " + t.slice(0, 24);
					seen.set(key, rec);
				}
				const ranked = Array.from(seen.entries()).sort((a, b) => b[1].n - a[1].n).slice(0, 4);
				const inkEl = document.getElementById(INK_STYLE_ID);
				const cnt = (sel) => {
					try {
						return document.querySelectorAll(sel).length;
					} catch (e) {
						return -1;
					}
				};
				// 直接报「正文节点现在实际是什么颜色」——分组统计会被别的
				// 同色元素淹没，看不出这一条规则到底有没有吃上。
				let textColor = "none";
				try {
					const first = document.querySelector('span[class*="_text_"]');
					if (first) textColor = getComputedStyle(first).color;
				} catch (e) {
					textColor = "err";
				}
				diagReport(
					"font",
					"id=" + spec.id + " | body=" + getComputedStyle(body).fontFamily +
						" | LP=" + getComputedStyle(body).getPropertyValue("--dsw-alias-label-primary").trim() +
						" LS=" + getComputedStyle(body).getPropertyValue("--dsw-alias-label-secondary").trim() +
						" LT=" + getComputedStyle(body).getPropertyValue("--dsw-alias-label-tertiary").trim() +
						" | textColor=" + textColor +
						" | boost=" + (state.ui && state.ui.textBoost) +
						" lv2=" + (document.getElementById(INK_STYLE_ID) ? (document.getElementById(INK_STYLE_ID).textContent.match(/--dsh-tone-ink-2:([^;]+)/) || [])[1] : "noel") +
						" | n_text=" + cnt('[class*="_text_"]') +
						" ink_len=" + (inkEl ? (inkEl.textContent || "").length : -1) +
						" fw=" + (state.ui && state.ui.fontWeight) +
						" | bg1=" + getComputedStyle(body).getPropertyValue("--dsw-alias-bg-layer-1").trim() +
						" chg=" + getComputedStyle(body).getPropertyValue("--changes-fill").trim() +
						" dlv=" + getComputedStyle(body).getPropertyValue("--deliverable-fill").trim() +
						" | wBody=" + getComputedStyle(body).fontWeight +
				" | geo=" + (() => { try { const c = document.querySelector(String.fromCharCode(91)+"class*=" + String.fromCharCode(34) + "_composerSeat" + String.fromCharCode(34) + String.fromCharCode(93) + " [class*=" + String.fromCharCode(34) + "_card" + String.fromCharCode(34) + String.fromCharCode(93)); const d = document.querySelector("[class*=dockRow]"); const r1 = c && c.getBoundingClientRect(); const r2 = d && d.getBoundingClientRect(); const s2 = d && getComputedStyle(d); return (r1?Math.round(r1.left)+"/"+Math.round(r1.width):"noc")+" vs "+(r2?Math.round(r2.left)+"/"+Math.round(r2.width):"nod")+(s2?" bg="+s2.backgroundColor+" bf="+(s2.backdropFilter==="none"?"none":s2.backdropFilter):""); } catch(e){ return "err:"+e.message; } })() +
				" | cmp=" + (() => {
							// 输入卡判据：报出宿主 computed 背景/描边/阴影，以及
							// 占位符与输入文字是否同时可见（用户报的「重叠」）。
							try {
								const card = document.querySelector('[class*="_composerSeat"] [class*="_card"]') ||
									document.querySelector('[class*="GRgSLq_card"]');
								if (!card) return "none";
								const cs2 = getComputedStyle(card);
								const ph = document.querySelector('[class*="_placeholder"]');
								const inp = document.querySelector('[class*="_input"][contenteditable], [class*="_input"]');
								const phVis = ph ? getComputedStyle(ph).visibility + "/" + getComputedStyle(ph).display : "noph";
								const txt = inp ? (inp.textContent || "").trim().length : -1;
								return "bg=" + cs2.backgroundColor +
									" bc=" + cs2.borderColor +
									" bs=" + (cs2.boxShadow === "none" ? "none" : "set") +
									" | ph=" + phVis + " txtlen=" + txt;
							} catch (e) {
								return "err";
							}
						})() +
						" | ov=" + (() => {
							// 浮层亚克力判据：数出命中浮层选择器的元素，报第一个的
							// 实际 computed backdrop-filter 与底色 —— 设置页没打开时
							// 会是 0，属于正常；打开后必须是 blur(14px)… 而非 none。
							try {
								// 先报三类元素的原始命中数：结构是「overlay > panel」还是
								// 中间隔着若干层包装，只有数出来才知道该用子选择器还是
								// 后代选择器 —— 之前按 `_overlay>_panel` 写，设置页打开
								// 后仍报 0，就是因为血缘关系猜错了。
								const cOv = document.querySelectorAll('[class*="_overlay"]').length;
								const cPan = document.querySelectorAll('[class*="_panel"]').length;
								const cMask = document.querySelectorAll('[class*="_mask"]').length;
								const els = document.querySelectorAll(
									'[class*="_overlay"] [class*="_panel"],[class*="_dialog"],[class*="_popover-card"]'
								);
								if (!els.length) return "0 ov" + cOv + "/pan" + cPan + "/mask" + cMask;
								const cs = getComputedStyle(els[0]);
								return els.length + " ov" + cOv + "/pan" + cPan + "/mask" + cMask +
									" bf=" + (cs.backdropFilter || cs.webkitBackdropFilter || "?") +
									" bg=" + cs.backgroundColor;
							} catch (e) { return "err"; }
						})() +
						" wOff=" + (() => {
							// 统一性判据：数出「字重不等于目标的可见文本元素」有几个，
							// 以及它们最常见的类名。真正的验收看 wOff，而不是某个选择器命中没有。
							const want = String(fw);
							let off = 0;
							const tags = {};
							for (const el3 of document.querySelectorAll("body *")) {
								if (el3.closest("svg")) continue;
								if (el3.closest("pre,code,kbd,samp")) continue; // 代码块按设计保持 400
								let hasText = false;
								for (const n of el3.childNodes) {
									if (n.nodeType === 3 && n.textContent.trim().length >= 2) { hasText = true; break; }
								}
								if (!hasText) continue;
								const w = getComputedStyle(el3).fontWeight;
								if (w === want) continue;
								off++;
								const key = (el3.tagName.toLowerCase() + "." + String(el3.className || "").split(" ")[0].slice(0, 24));
								tags[key] = (tags[key] || 0) + 1;
							}
							const top = Object.keys(tags).sort((a, b) => tags[b] - tags[a]).slice(0, 3).map(k => tags[k] + "x " + k).join(" / ");
							return off + (top ? " [" + top + "]" : "");
						})() +
						" | " + ranked.map(([key, rec]) => rec.n + "x " + key + " @ " + rec.sample).join(" || "),
					"fontDiag"
				);
			} catch (error) {
				diagReport("font-probe-throw", error, "fontDiag");
			}
		}

		/**
		 * 正文文字亮度。
		 *
		 * dsh-claude-style 并不直接给 label 令牌写死颜色，而是从画布色**推算**
		 * 出来的（相对色语法）：
		 *   --dsh-tone-ink-3: oklch(from var(--dsh-claude-custom-canvas-dark) calc(l + .458) c h)
		 * 画布是 #191919（L≈0.23）时，tertiary 的 L 只有 ≈0.69，而正文主体
		 * 恰好大量用 tertiary —— 于是「全透明 + 文字发暗」是同一个算式的两面：
		 * 面板越透、画布越暗，字也一起变暗。
		 *
		 * 这里把这组令牌在 body 上直接写死（inline style 优先于任何样式表的
		 * 同属性声明），亮度按 ui.textBoost 在「宿主动过手感的原值」与
		 * 「明显提亮」之间取值；色相/彩度保持中性，避免和壁纸色温打架。
		 */
		const INK_TOKENS = [
			"--dsh-tone-ink", "--dsh-tone-ink-2", "--dsh-tone-ink-3", "--dsh-tone-ink-4",
			"--dsw-alias-label-primary", "--dsw-alias-label-secondary",
			"--dsw-alias-label-tertiary", "--dsw-alias-label-caption"
		];
		// 每档的 OKLab 亮度基准（primary / secondary / tertiary / caption），
		// 深色界面「越大越亮」，浅色界面「越小越深」。
		// 2026-11-21 用户 m02615「你看有些字体还是灰色的」：原来 secondary/tertiary/
		// caption 三档是 0.800 / 0.720 / 0.640，叠在半透明壁纸上（画布 alpha 0.15）
		// 亮度只剩一半，区块标题、时间戳、次要说明这类小字几乎看不见。
		// 整体抬到 0.870 / 0.820 / 0.760：与 primary 0.950 仍留三档层次，
		// 但小字在亮壁纸上也够读。只动深色档；浅色档方向相反，不受影响。
		const INK_BASE_DARK = [0.950, 0.870, 0.820, 0.760];
		const INK_BASE_LIGHT = [0.200, 0.380, 0.480, 0.560];
		// 2026-11-21 用户 m02692「可以」：同意把最后一档灰也接管。
		// 三组「别名之外」的来源，都不在 INK_TOKENS 的 % 4 轮转里，
		// 必须显式指定档位，否则档位会算错：
		//   ① `--dsw-alias-label-dimmed` —— 主题给它 #969696（midnight），
		//      侧栏底部「会话与工作区」这类条目用它，按 caption 档（3）写；
		//   ② `--ink` / `--ink-2` / `--ink-3` —— modern-ui 自己的三段灰阶
		//      （#ededed / #b0b0b0 / #969696），`--dsw-alias-label-*` 是从它
		//      们派生的，但大量规则**直接读 --ink-2 / --ink-3**（实测 color
		//      属性 37 处读者），只改别名管不到 —— 无头实测「记忆中枢」
		//      「Onsim」这类工作区名一直是 rgb(176,176,176) 就是这个原因。
		const INK_EXTRA_TOKENS = [
			["--dsw-alias-label-dimmed", 3],
			["--ink", 0],
			["--ink-2", 1],
			["--ink-3", 2]
		];

		function inkLevels(boost) {
			const k = clamp(isFinite(Number(boost)) ? Number(boost) : 0.6, 0, 1);
			const dark = isDarkTheme();
			return INK_BASE_DARK.map((base, i) => {
				const span = [0.030, 0.080, 0.100, 0.080][i];
				const l = dark ? base + span * k : INK_BASE_LIGHT[i] - span * k;
				return "oklch(" + clamp(l, 0, 1).toFixed(3) + " 0 0)";
			});
		}

		const INK_STYLE_ID = "dsh-skin-keymark-ink";

		function applyInk() {
			const body = document.body;
			if (!body) return;
			const boost = state.ui && state.ui.textBoost;
			const levels = inkLevels(boost);
			// 两路同时写：
			// ① body 的 inline 变量 —— 覆盖挂在 :root / body 上的定义；
			// ② 一条 !important 的样式表规则 —— 思考块正文（span._text_…）的
			//    颜色不是读上面那几个 label 令牌，而是直接吃
			//    `oklch(from var(--dsh-claude-custom-canvas-dark) calc(l + .458) …)`
			//    这条相对色算式所在的那层，只有 !important 才能压住它。
			for (let i = 0; i < INK_TOKENS.length; i += 1) {
				body.style.setProperty(INK_TOKENS[i], levels[i % 4]);
			}
			// 必须带 important：主题层（applyUiTheme）对这四档文本色写的就是 inline
			// `!important`（见 IMPORTANT_LABEL_TOKENS）。本函数原先按普通优先级写，
			// 于是 inline important 的 #e6e9ef 每次都赢，ink 明明算好了却从没上屏 ——
			// 实测 body 计算值一直是 #e6e9ef 而不是 oklch(0.968 0 0)。
			for (let i = 0; i < INK_TOKENS.length; i += 1) {
				body.style.setProperty(INK_TOKENS[i], levels[i % 4], "important");
			}
			for (let i = 0; i < INK_EXTRA_TOKENS.length; i += 1) {
				body.style.setProperty(INK_EXTRA_TOKENS[i][0], levels[INK_EXTRA_TOKENS[i][1]], "important");
			}
			// `--ink / --ink-2 / --ink-3` 光写 inline 不管用：宿主/主题层在更晚的
			// 时机用**普通优先级**再写一遍，CSSOM 会把原有的 `important` 标志一并
			// 清掉（实测 body style 里最终只剩 `--ink-2: #b0b0b0`，没有 important）。
			// 因此这三档必须走样式表 `!important`：inline 普通声明压不过它，
			// 而对方若也用 inline `!important` 则本插件的优先级本来也赢不了。
			let inkExtraDecls = "";
			for (let i = 0; i < INK_EXTRA_TOKENS.length; i += 1) {
				inkExtraDecls += INK_EXTRA_TOKENS[i][0] + ":" + levels[INK_EXTRA_TOKENS[i][1]] + " !important;";
			}
			const decls = INK_TOKENS.map((tok, i) => tok + ":" + levels[i % 4] + " !important").join(";");
			// 相对色语法的源色也要一起钉住：claude-style 用画布色当锚点推算
			// ink，画布全透明后这个锚点仍是 #191919，钉住源色才不会再被算暗。
			const anchor = isDarkTheme() ? "#191919" : "#f5f5f5";
			// 思考块 / 消息正文里真正承载文字的是 `span[class*="_text_"]`（构建期
			// 哈希前缀，只能后缀锚定）。它既不读 --dsw-alias-label-*，也不读
			// --dsh-tone-ink-*，而是由前端 bundle 直接算的 oklch —— 令牌级覆盖
			// 到不了它，必须直接给它一条 color 规则。只限定在正文容器内，
			// 避免把按钮/标签/徽章也一起刷白。
			const proseColor = levels[1];
			const css =
				":root, body, body[data-dsh-claude-style], body[data-dsh-claude-palette], " +
				"body[data-dsh-claude-typeface]{" +
				decls + ";" +
				inkExtraDecls +
				"--dsh-claude-custom-canvas-dark:" + anchor + " !important;" +
				"--dsh-claude-custom-canvas-light:" + anchor + " !important" +
				"}" +
				// 思考块正文的 class 形如 `_text_1rdzk_17 BE0jCW_label`（前缀是
				// 构建期哈希、层级是 BE0jCW 而不是带 _body 的容器）。
				// 不要挂 `body[data-km-spread]` 或 `[data-pane=conversation]` 两道
				// 门：本宿主版本里既没有 data-pane 属性（探针实测 0 个），
				// data-km-spread 也是在 applyTokens 里才设置的 —— 而本函数可能
				// 先跑，于是规则永远匹配不到。直接锚在 span[class*="_text_"]
				// 上，这类元素只出现在消息正文里，不会误伤按钮/徽章。
				// 2026-11-21 修「字色改了没反应」：原来这里直接写 proseColor，
				// 等于把正文钉成无彩度灰。改为优先吃抽屉里选的 --km-body。
				"body span[class*=\"_text_\"]{" +
				"color:var(--km-body," + proseColor + ") !important" +
				"}" +
				// 画布 alpha 只有 0.15 上下时，亮部壁纸会把浅色正文顶到同亮度区间；
				// 令牌再白也压不出对比。补一条极轻的暗描边阴影，只作用于正文 span。
				"body span[class*=\"_text_\"]{" +
				"color:var(--km-body," + proseColor + ") !important;" +
				"text-shadow:0 1px 2px rgba(0,0,0,0.55),0 0 8px rgba(0,0,0,0.32) !important" +
				"}" +
				// 2026-11-21 用户 m02615「有些字体还是灰色的」（截图指向「相关问题」这类
				// 区块小标题）：它们是 12px 上下、走 tertiary/secondary 档的小字，
				// 壁纸亮部一透上来就和底色糊在一起。除了把这两档亮度整体抬高
				// （见 INK_BASE_DARK），再给小字补一层极轻的暗描边 —— 亮底暗底都能读。
				"body [class*=\"_heading\"],body [class*=\"_sectionLabel\"]," +
				"body [class*=\"_copyVersion\"],body [class*=\"_time\"]," +
				"body [class*=\"_notice\"],body [class*=\"_navCell\"]{" +
				"text-shadow:0 1px 2px rgba(0,0,0,0.5) !important" +
				"}" +
				// 输出区卡片底：交付物卡片（已编辑 N 个文件）、工具调用卡片、
				// 代码块容器。它们的底色不是走 --dsw-alias-* 令牌链，而是
				// claude-style 里 `--dsh-tone-surface-1 = oklch(from 画布 +0.036)`
				// 这类相对色，以及 deliverables 包硬编码的
				// `--changes-fill / --deliverable-fill = --dsw-static-neutral-850`。
				// 那些静态中性色不在 CONTENT_TOKENS 里，floorScale 也管不到，
				// 所以变量级覆盖压不住 —— 只能按类名后缀直接清底色。
				// 同理不能挂 body[data-km-spread]（该属性在 applyTokens 里才设，
				// 本函数可能先跑），这里一律不带门。
				"body [class*=\"HOHHba_card\"],body [class*=\"HOHHba_header\"]," +
				"body [class*=\"K5rwea_root\"],body [class*=\"K5rwea_file\"]," +
				"body [class*=\"ioCard\"],body [class*=\"_1h1PMq_root\"]," +
				"body [class*=\"ZG377q_card\"],body [class*=\"EqXNNG_body\"]," +
				"body [class*=\"iFrn8G_body\"],body [class*=\"LOmM4q_bubble\"]," +
				"body [class*=\"LOmM4q_fileCard\"]{" +
				"background:transparent !important;" +
				"background-color:transparent !important;" +
				"backdrop-filter:none !important;" +
				"-webkit-backdrop-filter:none !important" +
				"}";
			let el = document.getElementById(INK_STYLE_ID);
			if (!el) {
				el = document.createElement("style");
				el.id = INK_STYLE_ID;
				(document.head || document.documentElement).appendChild(el);
			}
			if (el.textContent !== css) el.textContent = css;
		}

		// ── 主题着色层：让「换主题」在低不透明度下也看得见 ─────────────
		//
		// 背景：令牌那条路是「主题色 × 画布 alpha」。用户把画布不透明度拖到
		// 0.08 时，`#161616` 与 `#282D33` 合成到同一帧上每通道只差 1.4/255
		// （真机实测 SAME_FRAME_INVISIBLE：三张截图 Δ=0）—— 乘法把色差压平
		// 了，换任何主题画面都不动。所以主题必须另有一条「不乘 alpha」的
		// 通路 —— 但「通路」最终没有用一整块覆盖层：`mix-blend-mode:color`
		// 只取色相不改明暗，暗部实测 Δ 0–0.2/255，等于没加（km-0121-ink3 /
		// blend2 两组实验）。真正有效的做法是把强调色混进底色本身，见
		// `themeTintFor()` / `mixRgb()`：alpha 一个数都不碰，只换 rgba 的
		// 前三个数，同一画布不透明度下画布 Δ 从 0 跳到 19.7。
		const THEME_INK_DEFAULT = 0.7;

		function applyGrain() {
			const wp = state.wallpaper;
			const url = typeof wp.url === "string" ? wp.url.trim() : "";
			const amount = clamp(wp.grain, 0, 1);
			if (!wp.enabled || (!gradientSpec() && (url === "" || !isSafeWallpaperUrl(url))) || amount <= 0) {
				removeGrainEl();
				return;
			}
			let g = document.getElementById(GRAIN_ID);
			if (!g) {
				g = document.createElement("div");
				g.id = GRAIN_ID;
				g.setAttribute("aria-hidden", "true");
				g.style.cssText =
					"position:fixed;inset:0;z-index:-1;pointer-events:none;" +
					`background-image:url("${GRAIN_TILE}");background-repeat:repeat;background-size:120px 120px;`;
			}
			g.style.opacity = String(amount * 0.6);
			// Keep the tile directly above the wallpaper layer. Both sit at
			// z-index:-1, so paint order follows DOM order; this still stays
			// under the (opaque) app frame.
			const wpEl = document.getElementById(WALLPAPER_ID);
			if (wpEl && wpEl.parentNode) {
				if (wpEl.nextSibling !== g) wpEl.parentNode.insertBefore(g, wpEl.nextSibling);
			} else if (!g.parentNode) {
				(document.body || document.documentElement).appendChild(g);
			}
		}

		// ── seamless loop via two layers ───────────────────────────────────
		//
		// A single looping <video> always shows the clip's first frame right
		// after its last — a visible cut unless the clip was authored to loop.
		// This keeps a second <video> hidden behind the visible one and, shortly
		// before the visible layer ends, fades the second in from its start; once
		// the fade completes the two layers exchange roles. Both stay muted and
		// are driven by this ticker; the power guard only gates whether it runs.

		const CROSS_FADE_MS = 600;
		let crossRaf = null;
		let crossFading = false;

		function crossEnabled() {
			const wp = state.wallpaper;
			return Boolean(wp) && wp.crossfade === true && wp.orbit !== true &&
				resolveKind(typeof wp.url === "string" ? wp.url.trim() : "", wp.kind) === "video";
		}

		function crossEls() {
			const a = document.getElementById(WALLPAPER_ID);
			const b = document.getElementById(CROSS_ID);
			if (!a || !b || a.tagName !== "VIDEO" || b.tagName !== "VIDEO") return null;
			return [a, b];
		}

		function ensureCrossEl(style, url) {
			let b = document.getElementById(CROSS_ID);
			if (!b || b.tagName !== "VIDEO") {
				if (b) b.remove();
				b = document.createElement("video");
				b.id = CROSS_ID;
				b.setAttribute("aria-hidden", "true");
				b.autoplay = false;
				b.muted = true;
				b.loop = false;
				b.playsInline = true;
				b.setAttribute("muted", "");
				b.setAttribute("playsinline", "");
				b.referrerPolicy = "no-referrer";
				const a = document.getElementById(WALLPAPER_ID);
				if (a && a.parentNode) a.parentNode.insertBefore(b, a.nextSibling);
				else (document.body || document.documentElement).prepend(b);
			}
			b.style.cssText = style;
			if (b.getAttribute("src") !== url) b.setAttribute("src", url);
			return b;
		}

		function stopCross() {
			if (crossRaf) { cancelAnimationFrame(crossRaf); crossRaf = null; }
			crossFading = false;
			const a = document.getElementById(WALLPAPER_ID);
			if (a && a.tagName === "VIDEO") a.style.removeProperty("opacity");
			const b = document.getElementById(CROSS_ID);
			if (b) {
				try { b.pause(); } catch { /* ignore */ }
				b.remove();
			}
		}

		function tickCross() {
			crossRaf = null;
			if (!crossEnabled()) { stopCross(); return; }
			const els = crossEls();
			if (!els) return;
			const a = els[0];
			const b = els[1];
			if (!videoShouldPlay()) {
				try { a.pause(); } catch { /* ignore */ }
				try { b.pause(); } catch { /* ignore */ }
				return;
			}
			const fade = CROSS_FADE_MS / 1000;
			const dur = a.duration;
			if (!crossFading) {
				if (a.paused) {
					const p = a.play();
					if (p && p.catch) p.catch(() => { /* autoplay policy */ });
				}
				if (isFinite(dur) && dur > fade * 1.5 && a.currentTime >= dur - fade) {
					crossFading = true;
					try { b.currentTime = 0; } catch { /* ignore */ }
					const p = b.play();
					if (p && p.catch) p.catch(() => { /* ignore */ });
				}
			} else {
				const progress = fade > 0 ? Math.min(1, b.currentTime / fade) : 1;
				b.style.opacity = String(progress);
				a.style.opacity = String(1 - progress);
				if (progress >= 1) {
					try { a.pause(); } catch { /* ignore */ }
					try { a.currentTime = 0; } catch { /* ignore */ }
					// Exchange roles: the incoming layer becomes the primary and
					// is moved after the other in DOM order, so the *next* fade
					// paints over an opaque layer instead of behind it.
					a.id = "__dsh-cross-swap-tmp";
					b.id = WALLPAPER_ID;
					a.id = CROSS_ID;
					if (b.parentNode) b.parentNode.insertBefore(a, b.nextSibling);
					b.style.opacity = "1";
					a.style.opacity = "0";
					crossFading = false;
				}
			}
			if (crossRaf === null) crossRaf = requestAnimationFrame(tickCross);
		}

		function kickCross() {
			const els = crossEls();
			if (!els) return;
			if (!videoShouldPlay()) {
				if (crossRaf) { cancelAnimationFrame(crossRaf); crossRaf = null; }
				for (const v of els) { try { v.pause(); } catch { /* ignore */ } }
				return;
			}
			if (!crossFading) {
				els[0].muted = true;
				els[1].muted = true;
				els[0].style.opacity = "1";
				els[1].style.opacity = "0";
				if (els[0].paused) {
					const p = els[0].play();
					if (p && p.catch) p.catch(() => { /* ignore */ });
				}
			}
			if (!crossRaf) crossRaf = requestAnimationFrame(tickCross);
		}

		// ── orbit scrub ────────────────────────────────────────────────────
		//
		// With orbit on the clip is not played at all: the pointer angle around
		// the window centre selects a frame, so the footage reads as a 360°
		// turntable. The target is lerped toward so the motion stays smooth
		// without decoding the whole clip.

		let orbitHandler = null;
		let orbitRaf = null;
		let orbitTarget = 0;
		let orbitCurrent = -1;

		function stopOrbit() {
			if (orbitHandler && typeof window !== "undefined") {
				window.removeEventListener("pointermove", orbitHandler);
			}
			orbitHandler = null;
			if (orbitRaf) { cancelAnimationFrame(orbitRaf); orbitRaf = null; }
			orbitCurrent = -1;
		}

		function tickOrbit() {
			orbitRaf = null;
			const el = document.getElementById(WALLPAPER_ID);
			if (!el || el.tagName !== "VIDEO" || state.wallpaper.orbit !== true) return;
			const dur = el.duration;
			if (!isFinite(dur) || dur <= 0) return;
			const target = ((orbitTarget + Math.PI) / (2 * Math.PI)) * dur;
			const current = orbitCurrent >= 0 ? orbitCurrent : el.currentTime;
			const next = current + (target - current) * 0.3;
			orbitCurrent = next;
			try { el.currentTime = next; } catch { /* ignore */ }
			if (Math.abs(target - next) < 0.03) { orbitCurrent = -1; return; }
			orbitRaf = requestAnimationFrame(tickOrbit);
		}

		function applyOrbit() {
			const wp = state.wallpaper;
			const el = document.getElementById(WALLPAPER_ID);
			const want = wp.orbit === true && wp.crossfade !== true && wp.enabled !== false &&
				Boolean(el) && el.tagName === "VIDEO" && !prefersReducedMotion();
			if (!want) { stopOrbit(); return; }
			const dur = el.duration;
			if (!isFinite(dur) || dur <= 0) {
				// Metadata not parsed yet: arm a one-shot re-entry so orbit can
				// start the moment the duration is known, without polling.
				if (!el.__kmOrbitArmed) {
					el.__kmOrbitArmed = true;
					el.addEventListener("loadedmetadata", () => {
						el.__kmOrbitArmed = false;
						applyOrbit();
					}, { once: true });
				}
				return;
			}
			try { el.pause(); } catch { /* ignore */ }
			if (!orbitHandler && typeof window !== "undefined") {
				orbitHandler = (event) => {
					const w = window.innerWidth || 1;
					const h = window.innerHeight || 1;
					orbitTarget = Math.atan2(event.clientY - h / 2, event.clientX - w / 2);
					const v = document.getElementById(WALLPAPER_ID);
					if (orbitCurrent < 0 && v) orbitCurrent = v.currentTime;
					if (!orbitRaf) orbitRaf = requestAnimationFrame(tickOrbit);
				};
				window.addEventListener("pointermove", orbitHandler, { passive: true });
			}
		}

		// ── coexistence mark (local patch 2026-10-20) ──────────────────
		// Other theme plugins (dsh-claude-style and relatives) gate their
		// wallpaper-aware branch on `body[data-we-wallpaper]`: with the mark
		// they clear their own canvas and let this artwork through; without
		// it they paint an opaque canvas over our layer and re-enable the
		// windowed titlebar band. keymark never set it, so the handshake
		// never completed and the wallpaper looked gone. Stamp it whenever
		// our own layer is actually on screen.
		const WALLPAPER_MARK = "data-we-wallpaper";
		const WALLPAPER_MARK_STYLE_ID = "dsh-skin-keymark-wallpaper-mark";
		function syncWallpaperMark() {
			const wp = (state && state.wallpaper) || {};
			const url = typeof wp.url === "string" ? wp.url.trim() : "";
			const on = wp.enabled === true && (gradientSpec() !== null || (url !== "" && isSafeWallpaperUrl(url)));
			const style = document.getElementById(WALLPAPER_MARK_STYLE_ID);
			if (!on) {
				document.body.removeAttribute(WALLPAPER_MARK);
				if (style) style.remove();
				return;
			}
			document.body.setAttribute(WALLPAPER_MARK, "");
			if (style) return;
			// The foreign canvas tint (its own canvas colour at 86% opacity,
			// z-index:-1) paints straight over this artwork: the artwork layer
			// is body's first child, that veil is body::after, and a z-index
			// tie is broken by tree order. Left alone it pins the visible
			// artwork near 2% no matter where the user drags the opacity
			// slider. Drop the veil, so the slider this plugin exposes stays
			// the one and only strength dial.
			const el = document.createElement("style");
			el.id = WALLPAPER_MARK_STYLE_ID;
			el.textContent =
				"body[" + WALLPAPER_MARK + "]::after{background:transparent !important}";
			(document.head || document.documentElement).appendChild(el);
		}

		// ── 全窗铺开的最后一层：结构性容器（local patch 2026-11-02）──────
		// Token 铺开只能穿透"用 token 上色"的元素。宿主布局里还有一批
		// 直接写死的面：`[data-windows-titlebar] .mP3x-q_frame` 的标题栏
		// 拖拽带 `:before`、darwin 侧栏的 `linear-gradient(...)` 叠层、
		// 第三方面板自带的 `.dshDesktopSidebarSurface` 实底。它们不吃
		// `--dsw-*` 变量，所以无论 token 多透明都会在壁纸上留一块实心。
		//
		// 这里不逐个猜类名 —— 宿主的类名是 `mP3x-q_` 这种构建期哈希，
		// 升级就变。改用 `[class*="_sidebarCol"]` 这类**后缀锚定**，配合
		// 第三方插件的稳定 data 属性，把"结构性外框"统一压成透明，让
		// z-index:-1 的壁纸层透上来；真正承载文字的面板仍由上面的
		// SPREAD_FLOOR 保证有底。
		const SPREAD_ATTR = "data-km-spread";
		const SPREAD_STYLE_ID = "dsh-skin-keymark-spread";
		// 铺开层专用的两个私有变量。为什么不直接复用 `--dsw-*`：
		// dsh-claude-style 会在**元素级**重新声明 `--dsw-specific-sidebar-fill`
		// （`transparent` 或不透明的 canvas 色），元素级声明压过 body 的
		// 继承值 —— 直接引用公共令牌，铺开层的底色就会被它改掉。私有变量
		// 没有第二个写入方，指向的永远是本插件刚算出的那一份 alpha。
		// 变量名带 km 前缀并带 fallback，第三方即便丢掉了也不至于全黑。
		const SPREAD_SIDE_VAR = "--km-side-fill";
		const SPREAD_CANVAS_VAR = "--km-canvas-fill";
		// 明度阶梯的三个私有副本。SPREAD_CSS 必须用 `!important` 才能压住宿主
		// 与 dsh-claude-style 在元素级的硬编码底色，但 `!important` 的样式表声明
		// 又会盖掉 applyTokens 写在 inline 上的 layer-1..3 —— 于是主题里排好的
		// 明度阶梯在铺开时被统一拉回画布色，薄涂后整窗只剩一档灰。
		// 解法：applyTokens 把这三层各自算好的值写进这三个私有变量，
		// SPREAD_CSS 只负责 `!important` 地**指回**它们。
		const SPREAD_LAYER_VARS = {
			"--dsw-alias-bg-layer-1": "--km-layer-1",
			"--dsw-alias-bg-layer-2": "--km-layer-2",
			"--dsw-alias-bg-layer-3": "--km-layer-3"
		};
		// 侧栏族：宿主本来就用 `--dsw-specific-sidebar-fill` 上色，问题只出在
		// 第三方（dsh-claude-style 把 `--dsh-claude-canvas` 实底直接写死在这
		// 一族元素上）。所以这里**不把它们扒成透明**，而是把底色重新指回
		// 那个已经被本插件写成半透明的令牌 —— 用户的「壁纸不透明度」滑条
		// 因此对侧栏仍然有效，可读性也不会掉到「文字直接压在照片上」。
		const SPREAD_SIDEBAR_SELECTOR = [
			// `:not(iframe)` 不是洁癖：dsh-univer-office 的文档预览器用的是
			// `<iframe class="uvf_frame">`，它会命中 `[class*="_frame"]`。
			// iframe 没有自己的绘制树，改它的 background 只会让加载中的
			// 预览窗露出壁纸（半截白色文档框），而不是让皮肤更连续。
			// `:not([data-variant])` 是 2026-11-24 补的：宿主把聊天里的图片附件
			// 缩略图写成 `<button class="ImrCdW_frame" data-variant="tile">`，类名
			// 同样含 `_frame`，于是被这条「给满窗容器铺侧栏色」的规则误伤 ——
			// 64×64 的小缩略图被涂上一层侧栏底色。凡是宿主自己声明了
			// `data-variant` 的 `_frame` 都是**有尺寸的小组件**（tile / chip 之类），
			// 满窗容器不会带这个属性，因此用它当排除判据比逐个类名硬编码稳。
			'[class*="_frame"]:not(iframe):not([data-variant])',
			'[class*="_sidebarCol"]',
			'[class*="_leadingSeat"]',
			'[class*="_bottomRow"]',
			// 这里**曾经**有一条 `[class*="_overlayLayer"]`，已于 2026-11-03 删除：
			// 宿主的 `.mP3x-q_overlayLayer{z-index:20;pointer-events:none;
			// position:absolute;inset:0}` 是一层**整窗大小的透明托层**，它压在
			// 侧栏/画布之上（z-index 20），本身什么都不画。给它写 `background-color`
			// 等于在内容之上盖一张满屏实色纸：
			//   • `--km-side-fill` 的 alpha 由壁纸不透明度推导，用户把不透明度拉到
			//     100% 时 alpha = 1 ⇒ 整个内容区变成一块 #161616 的死板，只剩标题栏
			//     还能看见（初看像"界面空白/白屏"，实为被自己盖住）；
			//   • alpha = 0.55 时是半透明的雾，看起来像"面板不透明、壁纸没透上来"。
			// 它还是 `pointer-events:none`，所以 `document.elementFromPoint()` 永远
			// 命中不到它 —— 排查时用命中测试找不到元凶，只能靠读宿主 CSS 定位。
			// 教训：铺开层只该染"自己会画底色"的容器，凡是宿主明确写成
			// `background:透明 + inset:0` 的托层必须排除在外。
			'[data-pane="sidebar"]',
			'[data-dsh-claude-part~="sidebar-column"]',
			".dshDesktopSidebarSurface"
		].join(",");
		// 主画布族：同样走令牌回指，用的是 `--dsw-alias-bg-base`（TOKEN_BG）。
		const SPREAD_CANVAS_SELECTOR = [
			'[class*="_centerCol"]',
			'[class*="_rightbarCol"]',
			'[data-pane="conversation"]',
			'[data-dsh-claude-part~="center-column"]',
			'[data-dsh-claude-part~="layout-frame"]'
		].join(",");
		const SPREAD_CSS =
			// `background-image:none` 要留下：darwin 的侧栏渐变叠层是
			// `linear-gradient(...)`，只改 color 它会继续把壁纸糊掉。
			// fallback 用 0 透明之外的值没有意义 —— 变量一定由 applyTokens()
			// 写，缺值只可能出现在它刚被移除的那一帧。
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_SIDEBAR_SELECTOR + ")" +
			"{background-color:var(" + SPREAD_SIDE_VAR + ",transparent) !important;background-image:none !important}" +
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_CANVAS_SELECTOR + ")" +
			"{background-color:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;background-image:none !important}" +
			// modern-ui（0.1.22）的画布是 `_7LJ8Na_*` 一族，内层对话容器 `.sr5jka_root` 写的是
			// `background:var(--page,var(--dsw-alias-bg-base))`，而 `--page` 由 body 上的
			// `body[data-ds-dark-theme]{--page:#111}` 写死为不透明 #111 —— 上面的
			// background-color 只能染到列容器，染不到读 `--page` 的那一层，结果是列透、
			// 对话正文仍是整块深灰实底。`--page` 全库只有 5 处读者（frame / centerCol /
			// frame::before / sr5jka_root / :root body 的几个派生变量），在铺开态把两族容器
			// 的 `--page` 一起指空，对话正文才真正透出壁纸。
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_SIDEBAR_SELECTOR + ")," +
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_CANVAS_SELECTOR + ")" +
			"{--page:transparent !important}" +
			// 2026-11-21 侧栏导航区版块化：modern-ui 的 panelList 原本是一列透明按钮，
			// 浮在壁纸上没有边界（实测 bg:rgba(0,0,0,0)，13 项 gap 3px）。给它同材质的
			// 玻璃底 + 圆角 + 1px 内描边，读作一块版块；只动底色与几何，不动条目本身。
			// padding 取 4px（真实增高 8px），余量由 dsh-sidebar-layout-fix 的 footArea
			// 上限 150 -> 140 让出，regionArea 的 200px 保底不受影响。
			"body[" + SPREAD_ATTR + "] [class*=\"_panelList\"]" +
			"{background:color-mix(in srgb,var(--dsw-alias-label-primary,#ffffff) 9%,transparent) !important;" +
			"border-radius:16px !important;" +
			"box-shadow:none !important;" +
			"padding:4px !important;" +
			"box-sizing:border-box !important;" +
			"flex:0 1 auto !important;min-height:0 !important;" +
			// 2026-11-21 用户 m02591「这一块缩小一点」：导航版块原占侧栏 52%，
			// 一屏放不下要滚动。压到 34%，把高度让给下面的「工作区」会话版块。
			"max-height:34% !important;" +
			"overflow-y:auto !important;scrollbar-width:thin}" +
			// 会话/工作区区用同一块材质，两块并排才是「同一种版块」。
			"body[" + SPREAD_ATTR + "] [class*=\"_regionArea\"]" +
			"{background:color-mix(in srgb,var(--dsw-alias-label-primary,#ffffff) 9%,transparent) !important;" +
			"border-radius:16px !important;" +
			"box-shadow:none !important;" +
			"padding:4px !important;" +
			"margin:4px 0 0 0 !important;" +
			"box-sizing:border-box !important;overflow:hidden !important}" +
			// modern-ui 的侧栏面板 `._0dkgvG_root` 画的是 `background:var(--glass,#fafaf9d9)`
			// 且自带 `backdrop-filter:blur(16px)`；深色分支里 `--glass:#171717f5` 是 96%
			// 不透明的实底，把刚被 `--page` 放出的壁纸又盖回去。它全库只有 1 处读者
			// （就是这条 `._0dkgvG_root`，另有一条 darwin 特例同族），所以只需把 `--glass`
			// 指回本插件的侧栏私有 alpha，左面板与右侧对话就落在同一层透明度上。
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_SIDEBAR_SELECTOR + ")" +
			"{--glass:var(" + SPREAD_SIDE_VAR + ",transparent) !important}" +
			// modern-ui 的标题条与输入卡实底不是 background 直写，而是两条 color-mix 派生令牌：
			//   · --dsw-header-surface-fill: color-mix(in srgb, var(--page) 56%, transparent)
			//     —— 由 .sr5jka_header:before 读，`--page` 已被置空，但 mix 里 56% 的不透明
			//        份额仍来自 body 上的 #111，标题条于是维持一条近黑横带。
			//   · --dsw-composer-surface-fill: color-mix(in srgb, var(--surface) 88%, transparent)
			//     —— 88% 的 #171717 让输入卡在亮壁纸上仍是黑块，这就是「输入栏还是黑的」。
			// 两个令牌只在 :root body 定义、又被 body 的 inline 主题串覆盖，
			// 只能按族回指到本插件刚算出的私有 alpha 变量。
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_SIDEBAR_SELECTOR + ")," +
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_CANVAS_SELECTOR + ")" +
			"{" +
			"--dsw-header-surface-fill:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			"--dsw-composer-surface-fill:var(" + FROST_CARD_TINT_VAR + ",transparent) !important" +
			"}" +
			// 顶部标签条（对话 / 轨道 / 编辑栏 …）与用户消息气泡在 modern-ui 里是写死的
			// rgb(29,29,29) / rgb(23,36,55) 实底，既不吃 --page 也不吃 --glass。
			// 用后缀锚定它们（构建期哈希前缀不可预知），只在铺开态生效。
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_CANVAS_SELECTOR + ") [class*=\"_viewTabs\"]," +
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_CANVAS_SELECTOR + ") [class*=\"_bubble\"]" +
			"{" +
			"background-color:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			"background-image:none !important" +
			"}" +
			// ── modern-ui 适配：把模糊度滑条接到左右两块面板上 ──
			// modern-ui 的 _7LJ8Na_frame / _7LJ8Na_sidebarCol / _7LJ8Na_centerCol
			// 只写 background，从不写 backdrop-filter，所以本插件原有的
			// FROST_SURFACE_TARGETS 打不到它们 —— 表现为「拖模糊度滑条，面板毫无变化」。
			// 这里直接把插件自己的 --km-frost（由 ui.glass.blur 换算，
			// 形如 blur(2.3px) saturate(1.7) brightness(1.06)）挂上去：
			// 左右同一条声明、同一个变量，模糊强度天然一致。
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_SIDEBAR_SELECTOR + ")," +
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_CANVAS_SELECTOR + ")" +
			"{-webkit-backdrop-filter:var(" + FROST_FILTER_VAR + ",none) !important;" +
			"backdrop-filter:var(" + FROST_FILTER_VAR + ",none) !important}" +
			// ── 2026-11-21 用户要求：画布不要那圈半透明底板（"黑框"）──
			// 铺开态下面板底板由 --km-side-fill / --km-canvas-fill 供色，虽然只有
			// 0.15~0.17 的 alpha，叠在壁纸暗部仍像一块浮在半空的玻璃板，边界可见。
			// 这里把两族的 background-color 直接归零、同时撤掉 border / box-shadow /
			// outline —— 毛玻璃（backdrop-filter）与文字描边阴影保留，可读性不靠底板。
			// 左右两族同一条声明，因此"左右契合"不会因为去底板而破坏。
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_SIDEBAR_SELECTOR + ")," +
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_CANVAS_SELECTOR + ")" +
			"{background-color:transparent !important;background-image:none !important;" +
			"border-color:transparent !important;box-shadow:none !important;outline:none !important}" +
			// 设置页（.AnXs9G_panel）面板本体已由 frost 层压到 rgba(30,30,33,0.275)，
			// 但内部还有两块实底：左侧导航选中态 .AnXs9G_navCell.AnXs9G_active 写的是
			// --dsw-specific-sidebar-nav-item-active（= rgb(23,36,55)），右上"打开配置文件"
			// 的 outline 按钮走 body[data-modern-official-controls] 的
			// `background:var(--surface,transparent)`（= #171717）。两处都改回本插件的
			// 私有 alpha，并保留主按钮 ._primary_* 的品牌色（它是唯一该实的地方）。
			"body[" + SPREAD_ATTR + "] [role=\"dialog\"] [class*=\"_navCell\"][class*=\"_active\"]" +
			"{background-color:rgba(139,185,242,0.20) !important;background-image:none !important}" +
			"body[" + SPREAD_ATTR + "] [role=\"dialog\"] [class*=\"_outline_\"]" +
			"{background-color:transparent !important;background-image:none !important}" +
			// 弹窗 / 设置页内层兜底：modern-ui 的 body[data-ds-dark-theme] 把
			// --page:#111 / --surface:#171717 / --canvas:#1d1d1d 写死成不透明值，
			// 弹窗内部凡是 color-mix(... var(--surface) ...) 或 background:var(--surface)
			// 都会退回近黑。这里只在 dialog 作用域内把它们回指到皮肤已算好的层级 alpha，
			// 不碰 dialog 之外的任何东西（正文、侧栏、输入卡的既有桥不受影响）。
			"body[" + SPREAD_ATTR + "] [role=\"dialog\"]" +
			"{--page:var(--km-layer-1,transparent) !important;" +
			"--surface:var(--km-layer-2,transparent) !important;" +
			"--canvas:var(--km-layer-3,transparent) !important}" +
			// 2026-11-23 对 modern-ui 的令牌级适配（用户 m03646：再给皮肤插件做做适配）。
			// 实测（无头 Playwright 读计算值 + 逐个令牌换值复验）：modern-ui 在 body 上
			// 写死了三个不透明色 --surface:#171717 / --canvas:#1d1d1d / --accent-tint:#172437，
			// 由它们派生出界面上几处「死黑块」：
			//   --surface   -> KZgrfG_suggestionRow、KZgrfG_shuffleButton、TIKdXG_workspace
			//                  （原本 rgb(23,23,23)，壁纸上是一块一块的黑砖）；
			//   --canvas    -> TIKdXG_previewBadge（rgb(29,29,29)）；
			//   --accent-tint -> MqVSca_sessionRow.MqVSca_selected（rgb(23,36,55) 深蓝实底，
			//                  选中会话那一行在浅壁纸上特别扎眼）。
			// 只换令牌不换类名规则：消费者照旧写 var(--surface) 等，因此不会碰任何
			// modern-ui 的类名契约，也不会和它自己的 !important 打架（同层同优先级下
			// 我们写在后面，赢的是这条）。透明度取原生「面板白 9%~12%」同一档。
			"body[" + SPREAD_ATTR + "]{--surface:color-mix(in srgb,#ffffff 10%,transparent) !important;" +
			"--canvas:color-mix(in srgb,#ffffff 12%,transparent) !important;" +
			"--accent-tint:color-mix(in srgb,#8bb9f2 20%,transparent) !important}" +
			// 2026-11-23 适配 dsh-auto-memory 的「记忆设置」全屏页（用户 m04136「这里也全是黑框」）。
			// 它自带一套 i5 令牌：整页 background:var(--i5-bg)（深档 #151D2C 深蓝）、
			// 设置页再盖一层 --i5-settings-bg:#17191e，头/主体/选项卡/按钮/输入框/保存条
			// 全部铺 --i5-face:#1D293D —— 三层叠起来就是那块深色板。
			// 这里只改令牌不动类名规则：它的消费者照旧写 var(--i5-face)，不碰任何类名契约。
			// !important 是必须的 —— 插件自己的中性化档用了
			// [data-dam-theme][data-dam-theme]:not(...):not(...)[data-deep] 这种 (0,5,0) 的复合
			// 选择器，且设置页被它的 :not([data-dam-theme=settings]) 排除在外，所以设置页
			// 一直走的是深蓝基准表，普通特异性压不住。
			"body[" + SPREAD_ATTR + "] [data-dam-theme=settings] [data-iter5][data-i5-embedded]," +
			"body[" + SPREAD_ATTR + "] [data-dam-theme=settings] [data-i5-embedded]{" +
			"--i5-bg:transparent!important;" +
			"--i5-settings-bg:transparent!important;" +
			"--i5-face:color-mix(in srgb,#ffffff 8%,transparent)!important;" +
			"--i5-surface:color-mix(in srgb,#ffffff 7%,transparent)!important;" +
			"--i5-side:color-mix(in srgb,#ffffff 5%,transparent)!important;" +
			"--i5-soft:color-mix(in srgb,#ffffff 13%,transparent)!important;" +
			"--i5-line:rgba(20,22,27,.18)!important;" +
			"--i5-bezel:rgba(20,22,27,.24)!important;" +
			"--i5-text:#14161b!important;" +
			"--i5-secondary:rgba(20,22,27,.86)!important;" +
			"--i5-muted:rgba(20,22,27,.76)!important;" +
			"--i5-hair:rgba(20,22,27,.18)!important}" +
			// 整页透明后，背后的壁纸与对话正文会直接透进面板；加一层和抽屉同档的模糊
			// （8px：够透出壁纸，又不让背后的字读得清）。滑条动的是抽屉，这里固定值即可。
			"body[" + SPREAD_ATTR + "] [data-dam-theme=settings] [data-iter5][data-i5-embedded][data-expanded=true]{" +
			"backdrop-filter:blur(40px) saturate(1.2) brightness(1.25)!important;" +
			"-webkit-backdrop-filter:blur(40px) saturate(1.2) brightness(1.25)!important}" +
			// 2026-11-23 版式：auto-memory 把设置页内容卡在 max-width:1100px 并居中，
			// 1600px 窗口里两侧空出近 500px，块被挤成窄条，纵横比看着不对。
			// 这里放开上限、并压掉它容器查询里「宽了就分两列」的行为，让每组各占满一条。
			"body[" + SPREAD_ATTR + "] [data-dam-theme=settings] [data-iter5][data-i5-embedded] [data-dam-settings]{" +
			"max-width:none!important;width:100%!important;margin:0!important}" +
			"body[" + SPREAD_ATTR + "] [data-dam-theme=settings] [data-iter5][data-i5-embedded] [data-dam-settings-content]{" +
			"display:grid!important;grid-template-columns:minmax(0,1fr)!important;gap:14px!important;" +
			"padding:0 0 20px!important;background:transparent!important}" +
			// 每组做成独立的一块：淡白底 + 1px 亮边 + 14px 圆角，组间不再只靠一条分隔线。
			"body[" + SPREAD_ATTR + "] [data-dam-theme=settings] [data-iter5][data-i5-embedded] :is(.i5-card,[data-dam-settings-group]){" +
			"padding:16px 18px!important;border:1px solid rgba(255,255,255,.12)!important;border-radius:14px!important;" +
			"background:color-mix(in srgb,#ffffff 5%,transparent)!important;box-shadow:none!important;margin:0!important}" +
			"body[" + SPREAD_ATTR + "] [data-dam-theme=settings] [data-iter5][data-i5-embedded] :is(.i5-card,[data-dam-settings-group])+.i5-card{" +
			"border-top:1px solid rgba(255,255,255,.12)!important;padding-top:16px!important}" +
			// 引擎选择在宽屏里两列排，别一列拉到底。
			"body[" + SPREAD_ATTR + "] [data-dam-theme=settings] [data-iter5][data-i5-embedded] .i5-engine-grid{" +
			"grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:16px!important}" +
			"body[" + SPREAD_ATTR + "] [data-dam-theme=settings] [data-iter5][data-i5-embedded] [data-dam-settings-row]{" +
			"padding:12px 0!important}" +
			// 2026-11-23 适配：dsh-session-manager 的弹窗自己算底色，规则是
			//   .sm-nativeDialog/.sm-panelDialog/.sm-migrateDialog/.sm-settingsCard
			//   {--sm-dialog-surface: var(--dsw-alias-bg-layer-1, fallback#fff);
			//    --sm-dialog-fill: color-mix(in srgb, var(--sm-dialog-surface) var(--sm-dialog-opacity,100%), transparent)}
			// 宿主把 --dsw-alias-bg-layer-1 压成 rgba(22,22,22,.186) 之后，弹窗在壁纸上
			// 只剩一层 18.6% 的暗纱，里面的文字与卡片全糊成一片。这里把它的 surface
			// 换成皮肤自己的层级色：弹窗是 380~680px 的小浮层，0.86 的近实底正好和
			// 原生「模型下拉」的 0.72 同一档观感，又不会像整页抽屉那样透出双层叠影。
			"body[" + SPREAD_ATTR + "] :is(.sm-panelDialog,.sm-nativeDialog,.sm-migrateDialog,.sm-settingsCard,.sm-updateDialogLayer)" +
			"{--sm-dialog-surface:var(--km-dialog-fill,rgba(22,22,22,.86)) !important;" +
			"--sm-dialog-fill:color-mix(in srgb,var(--km-dialog-fill,rgba(22,22,22,.86)) var(--sm-dialog-opacity,100%),transparent) !important;" +
			"--page:transparent !important;--surface:var(--km-layer-2,transparent) !important}" +
			// 伪元素单独来一轮：`body[...] :is(...):before` 的优先级要压过
			// 宿主的 `[data-windows-titlebar] .mP3x-q_frame:before`（后者是
			// 0,2,0 + 元素），!important 在这里是必要的，不是懒。
			// 2026-11-22 用户 m03312「去掉所有文字之后……还有一块黑色的布」：
			// 这块布就是这一轮伪元素 —— :is(...)::before/::after 被涂上
			// --km-side-fill（rgba(22,22,22,.173)），而 _frame 是 1600×950 的
			// 满窗容器，于是整窗多了一层 17% 的暗纱；它挂在伪元素上，所以
			// 2026-11-21「去画布底板」那条只写元素本身的规则收不掉它。
			// 对伪元素只保留「清掉宿主自带的背景图」，不再涂任何色。
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_SIDEBAR_SELECTOR + ")::before," +
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_SIDEBAR_SELECTOR + ")::after," +
			"body[" + SPREAD_ATTR + "] :is(" + SPREAD_SIDEBAR_SELECTOR + ")>span[style*=\"--dsw-specific-sidebar-fill\"]" +
			"{background-color:transparent !important;background-image:none !important}" +
			// dsh-claude-style 的 Windows 特例直接把底色塞进 body 的直系
			// span（`>span[style*=--dsw-specific-sidebar-fill]`），那条不在
			// 上面的后代选择器覆盖范围内，单列一条。
			"body[" + SPREAD_ATTR + "]>span[style*=\"--dsw-specific-sidebar-fill\"]" +
			"{background-color:var(" + SPREAD_SIDE_VAR + ",transparent) !important;background-image:none !important}" +
			// dsh-claude-style 还留了两条不吃 background 的通路：①
			// `[data-dsh-claude-part~=layout-frame]>[data-dsh-claude-part~=sidebar-column]`
			// 用 `box-shadow:0 calc(-1*titlebar-height) 0 0 var(--dsh-claude-sidebar-canvas)`
			// 画顶部那条横带；② `#root{background-color:var(--dsh-claude-canvas)}`。
			// 两者都只读它自己的 canvas 变量，改 background-color 拦不住。
			// 变量级覆盖是唯一能同时收掉它们的口子：把 canvas 族重新指向本插件
			// 刚算出的私有 alpha 变量，横带与 #root 就跟画布同透了。
			"body[" + SPREAD_ATTR + "]{" +
			"--dsh-claude-canvas:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			"--dsh-claude-sidebar-canvas:var(" + SPREAD_SIDE_VAR + ",transparent) !important;" +
			"--dsh-claude-card:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			"--dsh-tone-canvas:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			"--dsh-tone-sidebar:var(" + SPREAD_SIDE_VAR + ",transparent) !important;" +
			"--dsh-tone-card:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			// 「正在思考」「工具调用」这一类 turn-trigger 容器（宿主
			// `.hSzSIW_root`）画的是 `background:var(--dsw-alias-turn-trigger-bg,
			// var(--dsw-alias-markdown-code-block))`，而 `--dsw-alias-markdown-code-block`
			// 在深色主题下是 `--dsw-static-neutral-bluish-900`（一块几乎不透明的
			// 深灰），所以哪怕面板已全透，这一整块仍像贴了张实底卡片。
			// 该令牌在整个宿主里只有 2 处读者（本体 + hover），全部指向同一块
			// 容器，变量级覆盖一次收干净，不必逐条改 background。
			"--dsw-alias-turn-trigger-bg:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			"--dsw-alias-turn-trigger-bg-hover:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			// 「已编辑 N 个文件」这类交付物卡片（deliverables 包）的实底走的是
			// `.HOHHba_card{background:var(--dsw-alias-bg-layer-1)}`，而卡片头
			// `.HOHHba_header{background:var(--changes-fill)}` 与每个文件行
			// `.K5rwea_file{background:var(--deliverable-fill)}` 用的是深色分支里
			// 硬编码的 `--changes-fill/--deliverable-fill: var(--dsw-static-neutral-850)`。
			// 这四个静态中性色**不在 CONTENT_TOKENS 里**，floorScale 管不到它们，
			// 所以面板全透之后这一整块仍是一张深灰实底。改成画布同透即可。
			"--changes-fill:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			"--changes-hover:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			"--deliverable-fill:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			"--deliverable-hover:var(" + SPREAD_CANVAS_VAR + ",transparent) !important;" +
			// claude-style 在 body 的属性选择器上把三层表面色写成不透明硬编码
			// （#212121 / #282828 / #323232），会盖住 CONTENT_TOKENS 写进去的
			// 半透明值（同一元素上属性选择器与 inline 之争，实测卡片仍偏实）。
			// 这里用 !important 把三档拉回画布色。bg-layer-1 全库 47 处读者
			// （15 个包），但它们的意图都是「比画布略抬一档的卡片底」，
			// 全透皮肤下统一归零正是想要的效果。
			"--dsw-alias-bg-layer-1:var(" + SPREAD_LAYER_VARS["--dsw-alias-bg-layer-1"] + ",transparent) !important;" +
			"--dsw-alias-bg-layer-2:var(" + SPREAD_LAYER_VARS["--dsw-alias-bg-layer-2"] + ",transparent) !important;" +
			"--dsw-alias-bg-layer-3:var(" + SPREAD_LAYER_VARS["--dsw-alias-bg-layer-3"] + ",transparent) !important;" +
			"}" +
			// 容器还剩一圈 `.5px solid var(--dsw-alias-border-l1)`；底色去掉后
			// 那圈描边会孤零零地框出一块矩形，比实底更碍眼，一并收掉。
			"body[" + SPREAD_ATTR + "] [class*=\"hSzSIW_root\"]{" +
			"border-color:transparent !important}" +
			// 闲时队列 dock 的接缝（local patch 2026-11-03）──────────────
			// dsh-lowtide 的 `.tqdCrG_dock` 写的是
			// `width:calc(100% - 16px);margin:0 8px -3px`，`.tqdCrG_dockRow`
			// 只有上圆角（`border-radius:12px 12px 0 0`）且底边直角，再靠
			// -3px 负外边距主动压到输入卡上 —— 它的意图是「dock 与输入卡
			// 拼成同一块」。面板不透明时看不出问题；现在两者底色都只有
			// 0.08，那条 -3px 重叠带上两层半透明 + 两层 backdrop-filter
			// 叠在一起，就成了一道比周围更亮更实的横向错位带；同时 dock
			// 比下方输入卡更宽，左右缘也对不齐。
			//
			// 改法：取消负外边距、四角全圆、左右各留 8px 让 dock 与输入卡
			// 同宽同心，变成一块独立的胶囊，不再假装和输入卡连体。
			// `[class$="_dock"]` 而不是 `[class*="_dock"]`：后者会把
			// `_dockRow` / `_dockTitle` / `_dockActions` 一并命中，
			// 给行内子元素灌 width:100% 会把 dock 排版撑坏。
			// 三处一起改才有效：① 宿主外层 `.F07MqG_dock` 自带
			// `margin:0 auto calc(0px - stack-gap - 3px)`，负底边距是
			// 主因，必须在外层清零；② lowtide 的 `_dock` 自带
			// `margin:0 8px -3px`，也要清零并收到与输入卡同宽同心；
			// ③ `_dockRow` 只有上圆角，补成全圆才有「独立胶囊」的样子。
			// 关键：dock 不再冒充输入卡的「上半截」。输入卡的宽度由
			// `.GRgSLq_root` 的 side-clearance 与 `--dsh-composer-card-max-width`
			// 两层决定，dock 走的是另一条链（`.F07MqG_dock` 自己再减一次
			// dock-inset），两条链算出的左缘天生差几十像素 —— 只要还让它们
			// 各自 100% 铺开，接缝处左右缘就永远对不齐。
			// 所以改成「独立居中胶囊」：宽度收成内容宽、居中、四角全圆、
			// 与输入卡之间留出真实间隙。宽度不必相同，关系就无从错位。
			// 宽度直接复刻输入卡自己的公式：卡片是 `width:100%` +
			// `max-width:min(calc(100% - 16px), 952px)`，所以这里也写同一个
			// `calc(100% - 16px)`。外层 padding 归零，不再多吃一份 clearance。
			"body[" + SPREAD_ATTR + "] [class*=\"_composerStack\"]{" +
			"margin:0 auto 8px !important;padding:0 !important;" +
			"width:100% !important;max-width:none !important;" +
			"box-sizing:border-box !important;" +
			"display:flex !important;justify-content:center !important}" +
			"body[" + SPREAD_ATTR + "] [class*=\"_composerStack\"] [class$=\"_dock\"]{" +
			"width:100% !important;" +
			"max-width:min(calc(100% - 16px), 952px) !important;" +
			"margin:0 auto !important;box-sizing:border-box !important}" +
			"body[" + SPREAD_ATTR + "] [class*=\"_composerStack\"] [class*=\"_dockRow\"]{" +
			"background:transparent !important;border-radius:12px !important;" +
			"border-bottom:1px solid color-mix(in srgb, currentColor 12%, transparent) !important}" +
			"body[" + SPREAD_ATTR + "] [class*=\"_composerStack\"] [class*=\"_drawer\"]{" +
			"background:transparent !important;border-radius:0 0 12px 12px !important}";

		/**
		 * 打开/关闭"结构性容器透明"这一层。
		 * 只在铺开模式且确有素材时落地 —— 否则等于把整窗扒成无底透明，
		 * 用户会看到桌面背景，那是另一种坏。
		 */
		function syncSpreadSurface(on) {
			const body = document.body;
			if (!body) return;
			const style = document.getElementById(SPREAD_STYLE_ID);
			if (!on) {
				body.removeAttribute(SPREAD_ATTR);
				if (style) style.remove();
				return;
			}
			body.setAttribute(SPREAD_ATTR, "");
			// 热更新时模块会重新求值，但上一版注入的 <style> 还留在 head 里。
			// 只判 `if (style) return` 会让补丁后的 CSS 永远进不了页面（旧规则
			// 继续生效），所以内容不同就重写一次。
			if (style) {
				if (style.textContent !== SPREAD_CSS) style.textContent = SPREAD_CSS;
				return;
			}
			const el = document.createElement("style");
			el.id = SPREAD_STYLE_ID;
			el.textContent = SPREAD_CSS;
			(document.head || document.documentElement).appendChild(el);
		}

		/** 当前是否有一个可绘制的美术素材（图片 / 视频 / 渐变）。 */
		function gradientSpec() {			const id = state.wallpaper && typeof state.wallpaper.gradient === "string" ? state.wallpaper.gradient : "";
			if (id === "") return null;
			return GRADIENT_PRESETS.find((g) => g.id === id) || null;
		}

		/**
		 * 「跟随主色」渐变的色标。色相来自 ui.tuneHue 的测量记录，彩度压到
		 * 0.06–0.16（读起来是一层有色调的空气，不是彩色塑料）；没有测量值时
		 * 退回中性灰阶 —— 与 deriveMarkColours 的"灰阶不凭空造色"同一条规则。
		 */
		function followGradientStops() {
			const px = state.ui && typeof state.ui.tuneHue === "number" && isFinite(state.ui.tuneHue) ? state.ui.tuneHue : null;
			const sat = state.ui && typeof state.ui.tuneSat === "number" && isFinite(state.ui.tuneSat) ? clamp(state.ui.tuneSat, 0, 1) : 0;
			const dark = isDarkTheme();
			const chroma = px === null ? 0 : clamp(0.06 + sat * 0.10, 0.06, 0.16);
			const stops = [];
			// 四档明度阶梯：深色主题从很暗走到中暗，浅色主题反过来。
			const ramp = dark ? [0.10, 0.16, 0.22, 0.12] : [0.97, 0.92, 0.95, 0.99];
			for (const l of ramp) {
				const rgb = px === null ? [l, l, l] : hslToRgb(px, chroma, l);
				stops.push(rgbHex(rgb[0], rgb[1], rgb[2]));
			}
			return stops;
		}

		/** 把一条渐变预设编译成可直接赋给 background-image 的 CSS。 */
		function gradientCss(spec, stopsOverride) {
			if (!spec) return "";
			const dark = isDarkTheme();
			const stops = stopsOverride && stopsOverride.length
				? stopsOverride
				: (spec.type === "follow" ? followGradientStops() : (dark ? spec.dark : spec.light));
			if (spec.type === "radial") {
				return `radial-gradient(ellipse 120% 90% at 50% 12%, ${stops.join(", ")})`;
			}
			if (spec.type === "conic") {
				const from = isFinite(Number(spec.angle)) ? Number(spec.angle) : 200;
				return `conic-gradient(from ${from}deg at 50% 45%, ${stops.join(", ")})`;
			}
			if (spec.type === "mesh") {
				// 四团径向光斑叠在底色上：这是「弥散光」的纯 CSS 表达，
				// 不建 canvas、不用 shader，静态时零每帧开销。
				const [a, b, c, d] = stops;
				const bg = dark ? "#0a0d14" : "#ffffff";
				return [
					`radial-gradient(circle at 18% 22%, ${a} 0%, transparent 52%)`,
					`radial-gradient(circle at 82% 18%, ${b} 0%, transparent 48%)`,
					`radial-gradient(circle at 30% 84%, ${c} 0%, transparent 50%)`,
					`radial-gradient(circle at 76% 78%, ${d} 0%, transparent 46%)`,
					`linear-gradient(${bg}, ${bg})`
				].join(", ");
			}
			const angle = isFinite(Number(spec.angle)) ? Number(spec.angle) : 135;
			// 线性渐变第一段与最后一段同色，首尾相接才不会在漂移时露出接缝。
			const loop = stops.concat([stops[0]]);
			return `linear-gradient(${angle}deg, ${loop.join(", ")})`;
		}

		/**
		 * 渐变漂移：只是 background-position 的合成器动画，没有 JS 逐帧。
		 * 需要 200% 的画布尺寸才动得起来，所以渐变背景恒用 background-size
		 * 放大一档；关闭漂移时位置沿用用户的平移构图。
		 */
		function ensureGradientRule(css, drifting) {
			let el = document.getElementById(GRADIENT_STYLE_ID);
			if (!el) {
				el = document.createElement("style");
				el.id = GRADIENT_STYLE_ID;
				(document.head || document.documentElement).appendChild(el);
			}
			if (!css) {
				if (el.textContent !== "") el.textContent = "";
				return;
			}
			// 漂移是合成器动画（background-position），最小化时 Chromium 本来
			// 就会降频，但窗口**只是被盖住**时它照跑 —— 于是加一道遮挡门控。
			// 几何量仍按 drifting 算（220% 画布），只摘掉 animation，这样
			// 停/启的一瞬构图不会跳变，只是不再位移。
			const animated = drifting && !occlusionPaused();
			const motion = animated
				? `animation:dsh-skin-keymark-drift 42s linear infinite;`
				: "";
			let next =
				`#${WALLPAPER_ID}{background-image:${css};background-size:${drifting ? "220% 220%" : "cover"};` +
				`background-position:${drifting ? "0% 0%" : "center"};${motion}}\n` +
				`@keyframes dsh-skin-keymark-drift{` +
				`0%{background-position:0% 0%}` +
				`25%{background-position:100% 0%}` +
				`50%{background-position:100% 100%}` +
				`75%{background-position:0% 100%}` +
				`100%{background-position:0% 0%}}`;
			// 尊重系统「减少动态效果」：动画整体不成立，退回静态构图。
			if (drifting && prefersReducedMotion()) next = next.replace(/animation:[^;]+;/, "");
			// 只在文本真变了才写：applyWallpaper() 每次 commit 都会跑到这里，
			// 无条件赋值会让浏览器把整段 @keyframes 重新解析（一次拖动上百次）。
			if (el.textContent !== next) el.textContent = next;
		}

		/**
		 * 只重算漂移动画的开关，不重画壁纸元素。
		 *
		 * 遮挡态（失焦/被覆盖/最小化/用电池）变化时调用：渐变壁纸没有
		 * <video>，applyVideoPlayback() 会直接返回，所以漂移必须单独刷新
		 * 一次，否则它会停在切换前的状态直到下一次 commit。
		 */
		function refreshGradientMotion() {
			if (typeof document === "undefined") return;
			if (!state.ui || state.ui.drift !== true) return;
			const grad = gradientSpec();
			if (!grad) return;
			ensureGradientRule(gradientCss(grad), true);
		}

		function applyWallpaper() {
			syncWallpaperMark();
			const wp = state.wallpaper;
			const url = typeof wp.url === "string" ? wp.url.trim() : "";
			const grad = gradientSpec();
			// 渐变优先：它不需要 URL，也不该被 URL 白名单判死。切到渐变时会
			// 显式清空 url（面板上点渐变按钮就做的事），所以两者不会同时存在。
			const artKey = grad ? "gradient:" + grad.id : url;
			if (!wp.enabled || (grad === null && (url === "" || !isSafeWallpaperUrl(url)))) {
				clearTransition();
				lastAppliedUrl = "";
				removeWallpaperEl();
				ensureGradientRule("", false);
				stopCross();
				stopOrbit();
				stopRotate();
				return;
			}
			// Fire the transition only on an actual source CHANGE. applyWallpaper()
			// re-runs on every commit (each slider tick), and replaying the effect
			// there would strobe the wallpaper while the user drags a slider.
			// It must also run BEFORE ensureWallpaperEl(), which may destroy the
			// outgoing element when the media kind flips (video <-> image).
			if (artKey !== lastAppliedUrl) {
				if (lastAppliedUrl === null) clearTransition();
				else if (!grad) runTransition(url, resolveKind(url, wp.kind));
				else clearTransition();
				lastAppliedUrl = artKey;
			}
			const kind = grad ? "gradient" : resolveKind(url, wp.kind);
			// The occlusion gate has to be armed for EVERY wallpaper kind, not just
			// video. It was only installed from the video branch below, so a
			// gradient wallpaper never registered focus/blur or visibilitychange:
			// `windowFocused` stayed at its initial `true`, `occlusionPaused()`
			// could never flip, and the drift animation kept running at 42 s per
			// cycle behind a maximised window. Idempotent, so the video branch's
			// own call stays harmless.
			installPowerGuard();
			const el = ensureWallpaperEl(kind === "video" ? "video" : "image");
			const blur = clamp(wp.blur, 0, 60);
			const dim = clamp(wp.dim, 0, 1);
			const contrast = clamp(wp.contrast, -100, 100);
			const saturate = clamp(wp.saturate, -100, 100);
			// One blur control only: the 模糊 slider (wp.blur) is the sole artwork
			// blur. An earlier duplicate "frost" slider fed this same filter chain
			// and did the identical thing, so it was deleted rather than kept as a
			// second knob with no distinct effect.
			// 模糊死区：1px 的 CSS blur 肉眼几乎看不出来，却要对整幅画面做一次
			// 真高斯卷积 —— 实测（定格同一视频帧，860×780 区域拉普拉斯方差）
			// blur(1px) 让锐度从 905.3 掉到 757.7（−16.3%），视觉上却等同于没糊。
			// 所以 1.5px 以下一律不下发，把「几乎无效果的清晰度损失」直接归零；
			// 真要柔化，从 2px 起才第一次出现可见差异。
			const blurPx = blur < BLUR_DEAD_ZONE ? 0 : blur;
			const filters = [];
			if (saturate !== 0) filters.push(`saturate(${(1 + saturate / 100).toFixed(3)})`);
			if (blurPx > 0) filters.push(`blur(${blurPx}px)`);
			if (dim > 0) filters.push(`brightness(${(1 - dim * 0.85).toFixed(3)})`);
			if (contrast !== 0) filters.push(`contrast(${(1 + contrast / 100).toFixed(3)})`);
			const filter = filters.length ? filters.join(" ") : "none";

			// 构图：平移（视口百分比）+ 缩放。纯合成器 transform，视频同样适用，
			// 且与暗化/对比度/饱和度共存在同一条链上（filter 与 transform 是
			// 两个不同的属性，不会互相覆盖）。
			const zoom = clamp(wp.zoom, ZOOM_MIN, ZOOM_MAX) / 100;
			const panX = clamp(wp.panX, -50, 50);
			const panY = clamp(wp.panY, -50, 50);
			const composition =
				(zoom !== 1 || panX !== 0 || panY !== 0)
					? `scale(${zoom.toFixed(3)}) translate(${panX.toFixed(2)}%, ${panY.toFixed(2)}%)`
					: "";

			if (kind === "gradient") {
				stopCross();
				stopOrbit();
				const drifting = state.ui.drift === true;
				ensureGradientRule(gradientCss(grad), drifting);
				paintWallpaperEl(el,
					`position:fixed;inset:0;z-index:-1;pointer-events:none;` +
					`filter:${filter};` +
					(wp.flip === true ? `transform:scaleX(-1)${composition ? " " + composition : ""};` : (composition ? `transform:${composition};` : "")));
				stopRotate();
				return;
			}
			ensureGradientRule("", false);

			if (kind === "video") {
				// "center" keeps the source's own pixel size (object-fit:none) so a
				// small clip is shown 1:1 in the middle instead of being blown up.
				const fit = wp.fit === "contain" ? "contain"
					: wp.fit === "center" ? "none"
					: wp.fit === "stretch" ? "fill"
					: "cover";
				// Mirroring is a pure compositor transform, so it costs no main-thread
				// work and survives in both the plain and the cross-fading layer.
				const flip = wp.flip === true ? " scaleX(-1)" : "";
				paintWallpaperEl(el,
					`position:fixed;inset:0;z-index:-1;pointer-events:none;width:100%;height:100%;` +
					`object-fit:${fit};filter:${filter};` +
					// Promote the full-screen video onto its own compositor layer so
					// the per-frame `filter` shader never repaints the page behind it.
					`transform:translateZ(0)${flip}${composition ? " " + composition : ""};backface-visibility:hidden;`);
				// Centred playback must not stretch the frame across the viewport.
				el.style.objectPosition = wp.fit === "center" ? "center" : "";
				if (el.getAttribute("src") !== url) el.setAttribute("src", url);
				// Keep the second layer in step with the primary one whenever the
				// seamless-loop option is on; tear it down otherwise so a single
				// decode context is used when the feature is off.
				if (crossEnabled()) {
					// The ticker owns the loop point: native looping would wrap the
					// clip underneath the running fade and flash the first frame
					// through the partial transparency.
					el.loop = false;
					ensureCrossEl(el.style.cssText, url);
				} else {
					el.loop = true;
					stopCross();
				}
				installPowerGuard();
				applyPlaybackRate();
				applyVideoPlayback();
			} else {
				// Switching video→image must drop the video-only companions, or
				// the twin <video> and the pointer handler would outlive the
				// primary element they belong to.
				stopCross();
				stopOrbit();
				let size = "cover";
				let repeat = "no-repeat";
				if (wp.fit === "contain") size = "contain";
				else if (wp.fit === "center") size = "auto";
				else if (wp.fit === "stretch") size = "100% 100%";
				else if (wp.fit === "tile") { size = "auto"; repeat = "repeat"; }
				const safe = url.replace(/"/g, '\\"');
				const flipSt = wp.flip === true ? `scaleX(-1)` : "";
				const tf = [flipSt, composition].filter(Boolean).join(" ");
				paintWallpaperEl(el,
					`position:fixed;inset:0;z-index:-1;pointer-events:none;` +
					`background-image:url("${safe}");background-size:${size};` +
					`background-position:${wp.fit === "tile" ? "left top" : "center"};` +
					`background-repeat:${repeat};` +
					(tf ? `transform:${tf};` : ``) +
					`filter:${filter};`);
			}
			scheduleRotate();
		}

		// ── auto rotation ──────────────────────────────────────────────────
		//
		// Borrowed from the wallpaper-engine plugin's "switch after ready" idea:
		// the next source is prepared to full readiness **before** it replaces the
		// current one, so the swap never flashes a black frame. If the next source
		// fails to become ready it is skipped and the one after is tried instead.
		const ROTATE_MAX_SKIP = 5;
		let rotateTimer = null;
		let rotateIndex = 0;
		let rotateBusy = false;
		// Signature of the inputs the countdown depends on. Without it, every
		// repaint (moving any slider calls applyAll -> applyWallpaper) would
		// re-arm the timer and a switch could be postponed forever.
		let rotateSig = "";

		/** Split the list textarea into a clean URL list (blank lines dropped). */
		function parseRotateList() {
			const raw = typeof state.wallpaper.rotateUrls === "string" ? state.wallpaper.rotateUrls : "";
			return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "" && isSafeWallpaperUrl(s));
		}

		function stopRotate() {
			if (rotateTimer !== null) {
				clearTimeout(rotateTimer);
				rotateTimer = null;
			}
		}

		/** Resolve once the source can be shown without a blank gap. */
		function whenSourceReady(url, kind) {
			return new Promise((resolve) => {
				let done = false;
				const finish = (ok) => {
					if (done) return;
					done = true;
					resolve(ok);
				};
				// A hard ceiling keeps one broken URL from stalling the rotation.
				const bail = setTimeout(() => finish(false), 12000);
				const settle = (ok) => { clearTimeout(bail); finish(ok); };
				try {
					if (kind === "video") {
						const probe = document.createElement("video");
						probe.muted = true;
						probe.preload = "auto";
						// The probe is only here to prove the URL loads; release its
						// buffer as soon as the verdict is in, or a queued 4K clip
						// would keep prefetching in the background forever.
						const release = () => { try { probe.removeAttribute("src"); probe.load(); } catch { /* ignore */ } };
						probe.addEventListener("canplaythrough", () => { settle(true); release(); }, { once: true });
						probe.addEventListener("loadeddata", () => { settle(true); release(); }, { once: true });
						probe.addEventListener("error", () => { settle(false); release(); }, { once: true });
						probe.src = url;
						try { probe.load(); } catch { /* ignore */ }
					} else {
						const img = new Image();
						img.referrerPolicy = "no-referrer";
						img.onload = () => settle(true);
						img.onerror = () => settle(false);
						img.src = url;
					}
				} catch {
					settle(false);
				}
			});
		}

		/** Arm the timer from the current state; no-op while the feature is off. */
		function scheduleRotate() {
			const wp = state.wallpaper;
			const list = parseRotateList();
			const on = wp.rotate === true && list.length > 1 && wp.enabled !== false;
			if (!on) {
				stopRotate();
				rotateSig = "";
				rotateIndex = 0;
				return;
			}
			const minutes = clamp(isFinite(Number(wp.rotateMin)) ? Number(wp.rotateMin) : 10, 0.5, 720);
			// Only restart the countdown when something that shapes it changed —
			// repaints from unrelated controls must not push the switch back.
			const sig = [wp.url, list.join("|"), minutes, wp.rotateMode === "random" ? "random" : "seq"].join("\u0000");
			if (sig === rotateSig && rotateTimer !== null) return;
			rotateSig = sig;
			stopRotate();
			rotateTimer = setTimeout(() => { stepRotate(); }, Math.round(minutes * 60000));
		}

		async function stepRotate() {
			if (rotateBusy) return;
			// 遮挡时不换图：换图要解码新素材、还要抓帧做过渡层，这些开销
			// 全落在看不见的时候。推迟到下一次可见 —— 计时器照常重排，
			// 所以回到前台后最多等一个周期，不会永久停摆。
			if (occlusionPaused()) { scheduleRotate(); return; }
			rotateBusy = true;
			try {
				const list = parseRotateList();
				if (!list.length) return;
				let cursor = list.indexOf(state.wallpaper.url);
				if (cursor < 0) cursor = rotateIndex;
				if (state.wallpaper.rotateMode === "random") {
					// Random mode still avoids immediately repeating the same source.
					let pick = cursor;
					let guard = 0;
					while (pick === cursor && guard++ < 20) pick = Math.floor(Math.random() * list.length);
					cursor = pick;
				}
				for (let i = 1; i <= Math.min(ROTATE_MAX_SKIP, list.length); i++) {
					const idx = (cursor + i) % list.length;
					const url = list[idx];
					const kind = resolveKind(url, "auto");
					// eslint-disable-next-line no-await-in-loop
					const ok = await whenSourceReady(url, kind);
					if (ok) {
						rotateIndex = idx;
						state.wallpaper.url = url;
						state.wallpaper.gradient = "";
						state.wallpaper.kind = kind;
						try { applyAll(); } catch { /* ignore */ }
						try { scheduleSave(); } catch { /* ignore */ }
						try { syncPanel(); } catch { /* ignore */ }
						return;
					}
				}
			} finally {
				rotateBusy = false;
				// Re-arm regardless of outcome so a transient failure self-heals.
				scheduleRotate();
			}
		}

		// ── token translucency ─────────────────────────────────────────────
		//
		// The wallpaper layer sits at `z-index:-1`, so the opaque base colour
		// that paints the app frame (and the sidebar) would hide it. We rewrite
		// exactly those two background tokens as translucent inline variables
		// **directly on <body>**.
		//
		// Why inline-on-body instead of `theme.overrideTokens(...)`: the override
		// layer only takes effect once the `theme` service exists and publishes,
		// so the old code (softService → maybe null → silent return) left the
		// wallpaper permanently hidden after a restart. Writing the variables on
		// body is the same channel the built-in ThemePresenter uses
		// (`dsh-client-ui-layout` writes alias tokens as body inline vars), and it
		// is deterministic — no service timing, no override validation.

		const TOKEN_BG = "--dsw-alias-bg-base";
		const TOKEN_SIDE = "--dsw-specific-sidebar-fill";

		// Content-layer surfaces that stay opaque natively and therefore keep
		// hiding the wallpaper even after the frame is translucent (chat
		// bubbles, the composer card, nested cards and code blocks). They are
		// only touched while `ui.transparency` > 0, so the default look stays
		// the untouched DSH theme.
		const CONTENT_TOKENS = [
			// User message bubble and the muted "highlight" variant.
			"--dsw-specific-bubble",
			"--dsw-specific-bubble-highlight",
			// The composer input card — this is the "chat bar" the user could
			// never make translucent; it natively uses `--dsw-specific-input-major`
			// (`dsh-client-ui-conversation` `.RlGAzG_card`), which the old list
			// simply omitted.
			"--dsw-specific-input-major",
			// Floating menus / popovers / selector + tooltip surfaces.
			"--dsw-specific-menu",
			"--dsw-specific-selector",
			"--dsw-specific-tip",
			// Generic layered + overlay + code surfaces.
			"--dsw-alias-bg-layer-1",
			"--dsw-alias-bg-layer-2",
			"--dsw-alias-bg-layer-3",
			"--dsw-alias-bg-overlay",
			"--dsw-alias-markdown-code-block",
			"--dsw-alias-markdown-inline-code",
			// 交互面（行 / 胶囊 / 悬停态 / 遮罩）。侧边栏与各类面板插件
			// （dsh-better-sidebar、dsh-solution-explorer、dsh-univer-office、
			// dsh-claude-style）的**行背景**都画在这些令牌上 —— 只把侧栏底板
			// 令牌调透没有用，因为它们在底板上又铺了一层自己画的行。
			// 这几个令牌在四个插件的 bundle 里合计出现 300+ 次，是「侧栏为什么
			// 一点壁纸都看不见」的直接原因。
			"--dsw-alias-interactive-bg-hover",
			"--dsw-alias-interactive-bg-hover-accent",
			"--dsw-alias-interactive-bg-hover-solid",
			"--dsw-alias-interactive-bg-active",
			"--dsw-alias-bg-mask-1",
			// 侧栏导航行自己的两个令牌（宿主 `.AnXs9G_navCell:hover`
			// /`.AnXs9G_active` 直接吃它们）。侧栏底座已经透了，但每一行
			// 还在底座上盖一层实色，整列看起来仍是实心 —— 这是「侧栏截图
			// 那部分没有皮肤」的最后一层。
			"--dsw-specific-sidebar-nav-item-active",
			"--dsw-specific-sidebar-nav-item-hover",
			// 模块级平台底色：宿主 36 处，`*_selector` 下拉、`blockquote`、
			// 卡片 active 态、warning 提示条都用它。第三方面板（插件市场
			// 的卡片网格、设置页分组）大量复用同一令牌，是最显眼的一块
			// 非对话实心面。
			"--dsw-alias-bg-module-platform",
			// 菜单粘性分组标题（宿主 5 处）与代码块标题条（5 处）：
			// 都压在已透明的菜单/代码块上，不透就留一条硬边。
			"--dsw-alias-menu-group-header-fill",
			"--dsw-alias-markdown-code-block-banner",
			// 浮层类：tooltip / toast / tooltip 键帽（宿主 5+5+6 处）。
			// 它们目前是唯一的「完全不受皮肤影响」的浮层。
			"--dsw-alias-tooltip-bg",
			"--dsw-alias-tooltip-key-bg",
			"--dsw-alias-toast-bg",
			// 悬停用的第四层（宿主仅 2 处，模型选择器行 hover）。补上是
			// 为了让「所有窗口」没有例外，代价为零。
			"--dsw-alias-bg-layer-4",
			// 设置页的「功能区卡片」底色。宿主把它声明成
			// `--dsw-alias-settings-card-fill: var(--dsw-alias-bg-layer-2)`，
			// 但那条声明写在 theme 包里、生效位置在 :root/主题选择器上 ——
			// var() 在**声明处**就替换掉了，所以插件在 body 上写 layer-2
			// 的透明值继承不到这里，卡片仍然是实心块。设置页里
			// 账号/模型/插件市场/外观预设的整片卡片网格都吃它（6 处读者），
			// 必须单独写。
			"--dsw-alias-settings-card-fill",
			// 设置页「引导卡」的两层底色（账号页的新手引导与插件市场首屏）。
			// 同样是别名型令牌，宿主在 :root 里就把它们解析成了具体色。
			"--dsw-alias-onboarding-card-fill",
			"--dsw-alias-onboarding-secondary-fill",
			// 宿主菜单/弹层的面层。它不在 alias 命名空间里（前缀是
			// `--dsw-menu-`），所以早先按 `--dsw-alias-` 前缀扫令牌时被
			// 整片漏掉：账号菜单、下拉选择器、右键菜单全都写死
			// `#43454a73` / `#f8f9fa94`，壁纸怎么调它们都不动。
			"--dsw-menu-surface-fill"
			// 刻意不收 `--dsw-alias-bg-skeleton`：它是 #ffffff14 这类
			// 「半透明微光」，本插件写进去的是 base 色 + 不透明度，两者
			// 语义不同 —— 收进来只会把加载占位从一层薄光变成一块实色方块。
		];
		// Surfaces that carry dense, short-lived text keep a readability floor:
		// they never go fully transparent, so labels stay legible at max strength.
		const CONTENT_FLOOR = {
			"--dsw-specific-menu": 0.92,
			"--dsw-specific-selector": 0.92,
			"--dsw-specific-tip": 0.94,
			"--dsw-alias-bg-overlay": 0.94,
			"--dsw-alias-bg-layer-1": 0.95,
			"--dsw-alias-bg-layer-2": 0.95,
			"--dsw-alias-bg-layer-3": 0.95,
			"--dsw-alias-markdown-code-block": 0.95,
			"--dsw-specific-input-major": 0.55,
			// 新增令牌的地板（非铺开模式同样生效）。数值口径与上面一致：
			// 「密排文字刚好还能读」的下限。浮层类（tooltip / toast）地板
			// 必须高于面板，因为它们压在正文之上、没有底板可以借用。
			"--dsw-specific-sidebar-nav-item-active": 0.86,
			"--dsw-specific-sidebar-nav-item-hover": 0.80,
			"--dsw-alias-bg-module-platform": 0.90,
			"--dsw-alias-menu-group-header-fill": 0.92,
			"--dsw-alias-markdown-code-block-banner": 0.92,
			"--dsw-alias-tooltip-bg": 0.92,
			"--dsw-alias-tooltip-key-bg": 0.88,
			"--dsw-alias-toast-bg": 0.90,
			"--dsw-alias-bg-layer-4": 0.88,
			// 设置页功能区卡片：卡片坐在 layer-2 面板之上，必须比面板实
			// 一档，否则卡片和面板会成为同一块无边界色面。0.95 与
			// layer-1..3 同档 —— 它承载的是表单标签与小号说明文字。
			"--dsw-alias-settings-card-fill": 0.95,
			// 引导卡两层：主卡承载标题与说明（同 layer-1..3 档），副卡
			// 是它上面更小的一块（略低一档，让主次仍分得开）。
			"--dsw-alias-onboarding-card-fill": 0.95,
			"--dsw-alias-onboarding-secondary-fill": 0.93,
			// 宿主菜单/弹层的**唯一**面层令牌。宿主把它写死成
			// `#43454a73`（深色）/ `#f8f9fa94`（浅色）—— 45% 的固定灰，
			// 与壁纸无关；读者是前端 bundle 里的 `_material_rio79_21`
			// （`background:var(--dsw-menu-surface-fill)`），账号菜单、
			// 下拉选择器、右键菜单全部走它。不收进来，这些浮层永远
			// 是一块灰玻璃，怎么调透明度都不动。
			"--dsw-menu-surface-fill": 0.94
		};
		// 全窗铺开模式的地板。旧公式 `max(1 - transparency, floor)` 在
		// transparency = 0 时恒为 1（完全不透明），而默认值就是 0 —— 这就是
		// 「只有对话画布有皮肤，侧栏和面板全是死板一块」的根因。铺开模式下
		// 面板不再从 1 起算，而是从底板 alpha 起算，所以地板必须同步下调，
		// 否则 max() 会把推导值整体抬回去。
		//
		// 每个值都是「密排文字刚好还能读」的下限，不是随手写的：菜单/选择器
		// 需要压住背后的高频纹路，代码块要保持行号可辨，输入卡最松（它背后
		// 本来就是空场）。
		const SPREAD_FLOOR = {
			"--dsw-specific-menu": 0.50,
			"--dsw-specific-selector": 0.50,
			"--dsw-specific-tip": 0.55,
			"--dsw-alias-bg-overlay": 0.45,
			"--dsw-alias-bg-layer-1": 0.30,
			"--dsw-alias-bg-layer-2": 0.33,
			"--dsw-alias-bg-layer-3": 0.36,
			"--dsw-alias-markdown-code-block": 0.52,
			"--dsw-alias-markdown-inline-code": 0.32,
			"--dsw-specific-input-major": 0.22,
			"--dsw-alias-interactive-bg-hover": 0.12,
			"--dsw-alias-interactive-bg-hover-accent": 0.12,
			"--dsw-alias-interactive-bg-hover-solid": 0.16,
			"--dsw-alias-interactive-bg-active": 0.16,
			"--dsw-alias-bg-mask-1": 0.30,
			// 侧栏导航行：底板已经完全透了，行背景若还实就会把整列重新填满。
			// 悬停/选中是用户自己指过去的那一行，必须**更实**（.34/.38 于
			// 画布之上），否则「选中项在哪」这个最基本的定位线索消失。
			"--dsw-specific-sidebar-nav-item-hover": 0.26,
			"--dsw-specific-sidebar-nav-item-active": 0.32,
			// 模块级平台底色（插件市场卡片网格、设置页分组、下拉 selector、
			// blockquote）：它是「一块一块的实心板」，地板设 0.34 让它跟着
			// 画布走，但仍明显比画布实，卡片边界不会糊掉。
			"--dsw-alias-bg-module-platform": 0.34,
			// 菜单粘性分组标题 / 代码块标题条：压在已透明的面板上，只需
			// 一层薄底把标题与正文分开。
			"--dsw-alias-menu-group-header-fill": 0.42,
			"--dsw-alias-markdown-code-block-banner": 0.44,
			// 浮层（tooltip / toast / 键帽）：没有底板可借用，完全压在正文
			// 之上，地板必须显著高于所有面板 —— 否则读不清胶囊里的字。
			"--dsw-alias-tooltip-bg": 0.78,
			"--dsw-alias-tooltip-key-bg": 0.52,
			"--dsw-alias-toast-bg": 0.70,
			"--dsw-alias-bg-layer-4": 0.24,
			// 设置页卡片：坐在 layer-2 面板（0.33）之上，必须高过它
			// 才能在铺开时保住「卡片 / 面板」两级层次。0.36 与 layer-3
			// 同档 —— 宿主原本也正是把它定义成 layer-2 的一个别名。
			"--dsw-alias-settings-card-fill": 0.36,
			// 引导卡：主卡与 layer-2 同档，副卡再低一点（它在主卡内部，
			// 全靠这点差值才看得出是一块嵌套的小面）。
			"--dsw-alias-onboarding-card-fill": 0.33,
			"--dsw-alias-onboarding-secondary-fill": 0.28,
			// 菜单/弹层面层：一块浮起来的整片玻璃，背后直接是壁纸或正文，
			// 没有任何垫底可借。0.72 与 toast 同档 —— 菜单打开时背后就是
			// 会话列表，两条清单的文字叠在一起就是用户报的「文字重叠」。
			"--dsw-menu-surface-fill": 0.72
		};
		// 浮层硬下限：与「地板强度」脱钩。
		//
		// 用户把地板强度拉到 0（`floorScale = 0`）时，所有表面都塌到画布
		// alpha —— 这是「面板不再比画布实」的正确行为，因为面板背后就是
		// 自己那块半透明画布。但浮层不是：菜单、下拉、tooltip、toast 压在
		// **正文文字**之上，背后没有任何同 alpha 的底板可借。它们跟着塌到
		// 0.08 时，背后的会话列表会直接透上来与菜单条目叠成乱码 —— 真机
		// 截图里的文字重叠正是这么来的。
		//
		// 所以这张表**不受 floorScale 影响**：它是「这块面必须有底」的
		// 物理下限，不是用户在调的美术参数。分部位系数仍然乘在最后，
		// 用户想单独把菜单调透依然可以（那是他自己点名要的）。
		const FLOATING_FLOOR = {
			"--dsw-specific-menu": 0.72,
			"--dsw-specific-selector": 0.72,
			"--dsw-specific-tip": 0.80,
			"--dsw-menu-surface-fill": 0.72,
			"--dsw-alias-tooltip-bg": 0.86,
			"--dsw-alias-tooltip-key-bg": 0.62,
			"--dsw-alias-toast-bg": 0.82
		};
		// The sidebar is the one navigation surface painted straight from the
		// frame alpha, so a low 「面板不透明度」 (15% → a 25% sidebar) leaves its
		// dense labels sitting on the artwork. It keeps its own floor: 0.55
		// matches the composer, and 45% of the wallpaper still shows through.
		// 铺开模式把这个地板降到 0.20 —— 用户明确要的是「侧栏也有皮肤」，
		// 55% 的下限意味着最多只能透 45%，视觉上仍是毛玻璃。0.20 仍然保住
		// 了导航文字的可读性（侧栏 alpha 由底板 alpha 推导，永远比画布更实）。
		const SIDEBAR_FLOOR = 0.55;
		const SIDEBAR_FLOOR_SPREAD = 0.20;
		// 铺开模式下每个面板**高出画布多少**。这是整个铺开公式的另一半：
		// 面板 alpha = 画布 alpha + lift（再受 SPREAD_FLOOR 兜底）。
		//
		// 为什么用「加法抬升」而不是「乘法缩放」：画布 alpha 是用户直接
		// 掌握的量（壁纸不透明度滑条），面板必须**跟着它动** —— 壁纸调透，
		// 侧栏和面板一起变透；壁纸调实，它们一起变实。加法是这套联动里
		// 唯一单调且不会在 alpha=0 处塌成 0 的形式。
		//
		// 数值按「这块面板要压住多少背后的纹路」排：整片容器（layer-*）
		// 抬得最少，浮层菜单抬得最多（它们只有几行字，没有别的东西帮忙
		// 托住对比度），悬停/选中态几乎不抬（它们只是行级高亮，一旦抬
		// 就等于又画了一排实心行，正好是这次要消灭的东西）。
		const SPREAD_LIFT = {
			"--dsw-alias-bg-layer-1": 0.03,
			"--dsw-alias-bg-layer-2": 0.05,
			"--dsw-alias-bg-layer-3": 0.07,
			"--dsw-alias-bg-overlay": 0.10,
			"--dsw-specific-menu": 0.12,
			"--dsw-specific-selector": 0.12,
			"--dsw-specific-tip": 0.10,
			"--dsw-alias-markdown-code-block": 0.10,
			"--dsw-alias-markdown-inline-code": 0.05,
			"--dsw-specific-input-major": 0.00,
			"--dsw-specific-bubble": 0.02,
			"--dsw-specific-bubble-highlight": 0.04,
			"--dsw-alias-interactive-bg-hover": 0.01,
			"--dsw-alias-interactive-bg-hover-accent": 0.03,
			"--dsw-alias-interactive-bg-hover-solid": 0.04,
			"--dsw-alias-interactive-bg-active": 0.04,
			"--dsw-alias-bg-mask-1": 0.06,
			// 侧栏导航行：只比画布实一丁点，行与行之间才看不出「一排实心条」；
			// 但悬停/选中必须留出可辨认的增量（+0.14 / +0.18），否则整列
			// 看不见「我现在在哪」。
			"--dsw-specific-sidebar-nav-item-hover": 0.10,
			"--dsw-specific-sidebar-nav-item-active": 0.14,
			// 模块级平台板：它本身就是「比底板亮一档」的层级，抬 0.04 够。
			"--dsw-alias-bg-module-platform": 0.04,
			"--dsw-alias-menu-group-header-fill": 0.10,
			"--dsw-alias-markdown-code-block-banner": 0.12,
			// 浮层抬得最狠：它们前面没有任何一层垫底。
			"--dsw-alias-tooltip-bg": 0.34,
			"--dsw-alias-tooltip-key-bg": 0.12,
			"--dsw-alias-toast-bg": 0.26,
			"--dsw-alias-bg-layer-4": 0.03,
			// 设置页卡片沿用 layer-2 的抬升量：宿主就是把它定义成 layer-2
			// 的别名，抬升也必须一致，否则卡片会在铺开时比它所在的面板
			// 还淡一档，边界消失。
			"--dsw-alias-settings-card-fill": 0.05,
			// 引导卡两层沿用同一口径：主卡抬 0.03（与模块板同档，它只是
			// 平铺在面板上的一块内容区），副卡 0.02 —— 两卡之间的层级由
			// floor 决定，抬升只负责「壁纸更透时一起变淡」这个方向。
			"--dsw-alias-onboarding-card-fill": 0.03,
			"--dsw-alias-onboarding-secondary-fill": 0.02,
			// 菜单面层抬升与 layer-1 同档：它是一整片浮起的容器，不是
			// 几行字；抬多少只负责「壁纸调透时它也一起透」的方向。
			"--dsw-menu-surface-fill": 0.03
		};

		const LABEL_TOKENS = ["--dsw-alias-label-primary", "--dsw-alias-label-secondary", "--dsw-alias-label-tertiary"];

		// Accent override — borrows the same token set a high-star peer skin
		// (dsh-dream-skin) shades, verified to exist in the live DSH theme:
		// brand + business primary + the two button fills. One accent colour is
		// written to all four so links, focus rings and primary buttons move
		// together; nothing here touches layout or adds boxes.
		const ACCENT_TOKENS = [
			"--dsw-alias-brand-primary",
			"--dsw-alias-state-business-primary",
			"--dsw-alias-button-primary-fill",
			"--dsw-alias-button-primary-dimmed"
		];
		// One-click swatches; the picker + random + reset sit beside them.
		const ACCENT_PRESETS = [
			"#4f83f2", "#2563eb", "#34d399", "#22d3ee", "#a78bfa",
			"#fb923c", "#f87171", "#fbbf24", "#e879f9", "#f472b6",
			"#2dd4bf", "#a3e635"
		];
		// A "panel scheme" picks the translucent base and the text tone
		// together: "light" = light canvas + dark text, "dark" = the reverse.
		// Text therefore always sits on a backing of the opposite tone.
		const TEXT_ON_LIGHT = ["#0f1115", "#4b5563", "#6b7280"];
		const TEXT_ON_DARK = ["#f9fafb", "#cfd3d6", "#adb2b8"];

		// ── interface themes (whole-app palettes) ──────────────────────────
		//
		// A theme is a bag of `--dsw-*` alias tokens per scheme, written through
		// the same body-inline channel applyTokens() already owns. Why not
		// `ctx.theme.register()` / `overrideTokens()`: this plugin deliberately
		// never touches the theme service (see the note above TOKEN_BG) — the
		// override layer only exists once that service has published, and an
		// absent service used to leave the wallpaper permanently hidden. Body
		// inline vars are the channel the built-in ThemePresenter itself uses,
		// so a theme lands deterministically with no service timing and no
		// restart of the host.
		//
		// The token names are not invented: they were enumerated from the shell's
		// own stylesheets (57 distinct `--dsw-alias-*` / `--dsw-specific-*`
		// properties). `native` carries `tokens: null`, which means "write
		// nothing" — the untouched DSH theme.
		//
		// Values are concrete CSS colours. The maps serve two jobs at once: the
		// literal value a token takes when the theme is shown on its own, and the
		// colour the wallpaper wash composites over when a wallpaper is active.
		// That is why the surface tokens below must stay opaque (no alpha) — an
		// alpha-bearing surface would be double-composited by applyTokens().
		// Where a theme can actually be seen. Measured, not assumed: with the
		// user's settings (opacity 0.15 + readability boost) applyTokens() paints
		// the surface tokens as `toRgba(themeBase, 0.176)`, then a second 0.45
		// content wash on top. A canvas that differs from native by 8/255
		// therefore lands at 1.5/255 on screen — invisible. So the palette is
		// built to spend its difference on the tokens the wash does NOT touch:
		// borders, the label ramp, states, diffs, scrollbars, tooltip/toast and
		// the brand colour. Those keep 100% of their delta.
		//
		// Native reference (resolved from dsh-client-ui-theme, dark):
		//   bg-base #151517  layer-1 #232324  layer-2 #2c2c2e  overlay #61666b
		//   border-l1 #ffffff0f(5.9%)  label 250 / 211 / 178 / 134 / 70 grey
		//   brand #f9fafb  menu-icon #ebeef2  tooltip+toast-bg #43454a
		// Light native is flat white (every layer #fff) with a blue-grey overlay.
		// Codex's identity is precisely the things native does quietly: a
		// *neutral* (never blue-cast) grey axis, hairlines you can actually see
		// — structure by line rather than by fill — a steeper text ramp, and one
		// restrained blue reserved for brand, links and diffs.
		const UI_THEMES = {
			native: { label: "跟随原生", tokens: null },
			codex: {
				label: "Codex",
				tokens: {
					dark: {
						"--dsw-alias-bg-base": "#0a0a0a",
						"--dsw-alias-bg-layer-1": "#111111",
						"--dsw-alias-bg-layer-2": "#181818",
						"--dsw-alias-bg-layer-3": "#1f1f1f",
						"--dsw-alias-bg-layer-4": "#272727",
						"--dsw-alias-bg-overlay": "#161616",
						"--dsw-alias-bg-mask-1": "rgba(0,0,0,0.65)",
						"--dsw-alias-bg-module-platform": "#111111",
						"--dsw-alias-border-l1": "rgba(255,255,255,0.14)",
						"--dsw-alias-border-l2": "rgba(255,255,255,0.22)",
						"--dsw-alias-border-l3": "rgba(255,255,255,0.30)",
						"--dsw-alias-border-l4": "rgba(255,255,255,0.40)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(255,255,255,0.12)",
						"--dsw-alias-label-primary": "#f7f7f7",
						"--dsw-alias-label-secondary": "#b8b8b8",
						"--dsw-alias-label-tertiary": "#909090",
						"--dsw-alias-label-dimmed": "#4d4d4d",
						"--dsw-alias-label-caption": "#7a7a7a",
						"--dsw-alias-label-shimmer": "rgba(255,255,255,0.07)",
						"--dsw-alias-label-primary-foreground": "#0a0a0a",
						"--dsw-alias-label-error": "#f85149",
						"--dsw-alias-brand-primary": "#79b8ff",
						"--dsw-alias-link": "#79b8ff",
						"--dsw-alias-state-business-primary": "#79b8ff",
						"--dsw-alias-state-error-primary": "#f85149",
						"--dsw-alias-state-success-primary": "#3fb950",
						"--dsw-alias-state-warn-primary": "#d29922",
						"--dsw-alias-state-idle-primary": "#6a6a6a",
						"--dsw-alias-interactive-bg-hover": "rgba(255,255,255,0.08)",
						"--dsw-alias-interactive-bg-active": "rgba(255,255,255,0.15)",
						"--dsw-alias-button-primary-fill": "#f7f7f7",
						"--dsw-alias-button-primary-hover": "#ffffff",
						"--dsw-alias-button-ghost-active-fill": "rgba(255,255,255,0.15)",
						"--dsw-alias-button-ghost-active-border": "rgba(255,255,255,0.30)",
						"--dsw-alias-button-tool-bar-fill": "rgba(255,255,255,0.07)",
						"--dsw-alias-button-tool-bar-hover": "rgba(255,255,255,0.15)",
						"--dsw-alias-markdown-code-block": "#0f0f0f",
						"--dsw-alias-markdown-code-block-banner": "#161616",
						"--dsw-alias-markdown-inline-code": "#1c1c1c",
						"--dsw-alias-markdown-tag": "#161616",
						"--dsw-alias-menu-icon": "#a6a6a6",
						"--dsw-alias-menu-group-header-fill": "#6a6a6a",
						"--dsw-alias-tooltip-bg": "#272727",
						"--dsw-alias-tooltip-key-bg": "rgba(255,255,255,0.12)",
						"--dsw-alias-toast-bg": "#1f1f1f",
						"--dsw-alias-toast-label": "#f7f7f7",
						"--dsw-alias-switch-thumb": "#d4d4d4",
						"--dsw-alias-scrollbar-bg-l2": "#333333",
						"--dsw-alias-scrollbar-hover-l2": "#4d4d4d",
						"--dsw-alias-code-diff-added": "rgba(63,185,80,0.18)",
						"--dsw-alias-code-diff-deleted": "rgba(248,81,73,0.18)",
						"--dsw-specific-sidebar-fill": "#0d0d0d",
						"--dsw-specific-sidebar-nav-item-active": "#1f1f1f",
						"--dsw-specific-sidebar-nav-item-hover": "#161616",
						"--dsw-specific-bubble": "#141414",
						"--dsw-specific-bubble-highlight": "#1c1c1c",
						"--dsw-specific-input-major": "#111111",
						"--dsw-specific-menu": "#161616",
						"--dsw-specific-selector": "#181818",
						"--dsw-specific-tip": "#181818"
					},
					light: {
						"--dsw-alias-bg-base": "#ffffff",
						"--dsw-alias-bg-layer-1": "#fafafa",
						"--dsw-alias-bg-layer-2": "#f4f4f4",
						"--dsw-alias-bg-layer-3": "#ededed",
						"--dsw-alias-bg-layer-4": "#e4e4e4",
						"--dsw-alias-bg-overlay": "#f0f0f0",
						"--dsw-alias-bg-mask-1": "rgba(0,0,0,0.35)",
						"--dsw-alias-bg-module-platform": "#f4f4f4",
						"--dsw-alias-border-l1": "rgba(0,0,0,0.12)",
						"--dsw-alias-border-l2": "rgba(0,0,0,0.18)",
						"--dsw-alias-border-l3": "rgba(0,0,0,0.26)",
						"--dsw-alias-border-l4": "rgba(0,0,0,0.36)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(0,0,0,0.12)",
						"--dsw-alias-label-primary": "#1c1c1c",
						"--dsw-alias-label-secondary": "#4d4d4d",
						"--dsw-alias-label-tertiary": "#737373",
						"--dsw-alias-label-dimmed": "#b3b3b3",
						"--dsw-alias-label-caption": "#8c8c8c",
						"--dsw-alias-label-shimmer": "rgba(0,0,0,0.06)",
						"--dsw-alias-label-primary-foreground": "#ffffff",
						"--dsw-alias-label-error": "#cf222e",
						"--dsw-alias-brand-primary": "#0969da",
						"--dsw-alias-link": "#0969da",
						"--dsw-alias-state-business-primary": "#0969da",
						"--dsw-alias-state-error-primary": "#cf222e",
						"--dsw-alias-state-success-primary": "#1a7f37",
						"--dsw-alias-state-warn-primary": "#9a6700",
						"--dsw-alias-state-idle-primary": "#8c8c8c",
						"--dsw-alias-interactive-bg-hover": "rgba(0,0,0,0.06)",
						"--dsw-alias-interactive-bg-active": "rgba(0,0,0,0.12)",
						"--dsw-alias-button-primary-fill": "#1c1c1c",
						"--dsw-alias-button-primary-hover": "#383838",
						"--dsw-alias-button-ghost-active-fill": "rgba(0,0,0,0.12)",
						"--dsw-alias-button-ghost-active-border": "rgba(0,0,0,0.26)",
						"--dsw-alias-button-tool-bar-fill": "rgba(0,0,0,0.06)",
						"--dsw-alias-button-tool-bar-hover": "rgba(0,0,0,0.12)",
						"--dsw-alias-markdown-code-block": "#f6f6f6",
						"--dsw-alias-markdown-code-block-banner": "#ededed",
						"--dsw-alias-markdown-inline-code": "#f0f0f0",
						"--dsw-alias-markdown-tag": "#ededed",
						"--dsw-alias-menu-icon": "#4d4d4d",
						"--dsw-alias-menu-group-header-fill": "#737373",
						"--dsw-alias-tooltip-bg": "#1c1c1c",
						"--dsw-alias-tooltip-key-bg": "rgba(255,255,255,0.16)",
						"--dsw-alias-toast-bg": "#1c1c1c",
						"--dsw-alias-toast-label": "#ffffff",
						"--dsw-alias-switch-thumb": "#ffffff",
						"--dsw-alias-scrollbar-bg-l2": "#d4d4d4",
						"--dsw-alias-scrollbar-hover-l2": "#adadad",
						"--dsw-alias-code-diff-added": "rgba(26,127,55,0.14)",
						"--dsw-alias-code-diff-deleted": "rgba(207,34,46,0.14)",
						"--dsw-specific-sidebar-fill": "#f7f7f7",
						"--dsw-specific-sidebar-nav-item-active": "#ededed",
						"--dsw-specific-sidebar-nav-item-hover": "#f4f4f4",
						"--dsw-specific-bubble": "#f4f4f4",
						"--dsw-specific-bubble-highlight": "#ededed",
						"--dsw-specific-input-major": "#ffffff",
						"--dsw-specific-menu": "#ffffff",
						"--dsw-specific-selector": "#ffffff",
						"--dsw-specific-tip": "#f4f4f4"
					}
				}
			},
			// ── 经典：暖米色的纸，文字一个字都不动 ───────────────────────
			//
			// The one theme that deliberately has NO opinion about text. It
			// defines surfaces and borders and nothing else — no label-*, no
			// state-*, no brand, no button fill. That omission is the feature,
			// not a hole: applyUiTheme() walks every token any theme ever uses
			// and REMOVES the ones the active table does not define, so with
			// 经典 selected the label tokens simply are not written by us and
			// the native DSH text colours stay in charge. "Don't touch the
			// text" is therefore enforced by the shape of the data, not by
			// discipline in the apply path.
			//
			// The warmth is all in the paper: a cream canvas with lighter
			// sheets stacked on it (layer-1 → layer-4) so cards read as paper
			// on a desk, and sepia ink borders at 0.16/0.24/0.32/0.42 — the
			// native light ramp sits at 0.04/0.08/0.12/0.16 and is very nearly
			// invisible on a coloured canvas, which is exactly why the layers
			// have to carry the separation here instead of leaving it all to
			// a white-on-white scheme.
			classic: {
				label: "经典",
				tokens: {
					dark: {
						"--dsw-alias-bg-base": "#191612",
						"--dsw-alias-bg-layer-1": "#211d17",
						"--dsw-alias-bg-layer-2": "#29241c",
						"--dsw-alias-bg-layer-3": "#322c22",
						"--dsw-alias-bg-layer-4": "#3b3428",
						"--dsw-alias-bg-overlay": "#241f18",
						"--dsw-alias-bg-mask-1": "rgba(0,0,0,0.65)",
						"--dsw-alias-bg-module-platform": "#211d17",
						"--dsw-alias-border-l1": "rgba(214,190,150,0.16)",
						"--dsw-alias-border-l2": "rgba(214,190,150,0.24)",
						"--dsw-alias-border-l3": "rgba(214,190,150,0.32)",
						"--dsw-alias-border-l4": "rgba(214,190,150,0.42)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(214,190,150,0.14)",
						"--dsw-alias-interactive-bg-hover": "rgba(214,190,150,0.10)",
						"--dsw-alias-interactive-bg-active": "rgba(214,190,150,0.18)",
						"--dsw-alias-button-ghost-active-fill": "rgba(214,190,150,0.18)",
						"--dsw-alias-button-ghost-active-border": "rgba(214,190,150,0.34)",
						"--dsw-alias-button-tool-bar-fill": "rgba(214,190,150,0.10)",
						"--dsw-alias-button-tool-bar-hover": "rgba(214,190,150,0.18)",
						"--dsw-alias-markdown-code-block": "#221d16",
						"--dsw-alias-markdown-code-block-banner": "#29241c",
						"--dsw-alias-markdown-inline-code": "#2c261e",
						"--dsw-alias-markdown-tag": "#29241c",
						"--dsw-alias-tooltip-bg": "#3b3428",
						"--dsw-alias-tooltip-key-bg": "rgba(255,255,255,0.12)",
						"--dsw-alias-toast-bg": "#322c22",
						"--dsw-alias-scrollbar-bg-l2": "rgba(214,190,150,0.22)",
						"--dsw-alias-scrollbar-hover-l2": "rgba(214,190,150,0.38)",
						"--dsw-specific-sidebar-fill": "#15120e",
						"--dsw-specific-sidebar-nav-item-active": "#322c22",
						"--dsw-specific-sidebar-nav-item-hover": "#241f18",
						"--dsw-specific-bubble": "#211d17",
						"--dsw-specific-bubble-highlight": "#2c261e",
						"--dsw-specific-input-major": "#211d17",
						"--dsw-specific-menu": "#241f18",
						"--dsw-specific-selector": "#29241c",
						"--dsw-specific-tip": "#29241c"
					},
					light: {
						"--dsw-alias-bg-base": "#f4ede0",
						"--dsw-alias-bg-layer-1": "#faf6ec",
						"--dsw-alias-bg-layer-2": "#fdfbf5",
						"--dsw-alias-bg-layer-3": "#ffffff",
						"--dsw-alias-bg-layer-4": "#ffffff",
						"--dsw-alias-bg-overlay": "#f7f1e4",
						"--dsw-alias-bg-mask-1": "rgba(58,44,26,0.35)",
						"--dsw-alias-bg-module-platform": "#efe7d6",
						"--dsw-alias-border-l1": "rgba(88,68,42,0.16)",
						"--dsw-alias-border-l2": "rgba(88,68,42,0.24)",
						"--dsw-alias-border-l3": "rgba(88,68,42,0.32)",
						"--dsw-alias-border-l4": "rgba(88,68,42,0.42)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(88,68,42,0.16)",
						"--dsw-alias-interactive-bg-hover": "rgba(88,68,42,0.08)",
						"--dsw-alias-interactive-bg-active": "rgba(88,68,42,0.14)",
						"--dsw-alias-button-ghost-active-fill": "rgba(88,68,42,0.14)",
						"--dsw-alias-button-ghost-active-border": "rgba(88,68,42,0.32)",
						"--dsw-alias-button-tool-bar-fill": "rgba(88,68,42,0.08)",
						"--dsw-alias-button-tool-bar-hover": "rgba(88,68,42,0.14)",
						"--dsw-alias-markdown-code-block": "#efe7d6",
						"--dsw-alias-markdown-code-block-banner": "#e6dcc6",
						"--dsw-alias-markdown-inline-code": "#efe7d6",
						"--dsw-alias-markdown-tag": "#e6dcc6",
						"--dsw-alias-tooltip-bg": "#2b241a",
						"--dsw-alias-tooltip-key-bg": "rgba(255,255,255,0.16)",
						"--dsw-alias-toast-bg": "#2b241a",
						"--dsw-alias-scrollbar-bg-l2": "rgba(88,68,42,0.22)",
						"--dsw-alias-scrollbar-hover-l2": "rgba(88,68,42,0.38)",
						"--dsw-specific-sidebar-fill": "#efe7d6",
						"--dsw-specific-sidebar-nav-item-active": "#e6dcc6",
						"--dsw-specific-sidebar-nav-item-hover": "#eae1cf",
						"--dsw-specific-bubble": "#faf6ec",
						"--dsw-specific-bubble-highlight": "#efe7d6",
						"--dsw-specific-input-major": "#fbf8f0",
						"--dsw-specific-menu": "#fbf8f0",
						"--dsw-specific-selector": "#fbf8f0",
						"--dsw-specific-tip": "#faf6ec"
					}
				}
			},
			// ── 午夜蓝：冷调深灰做底，蓝紫只用来点 ───────────────────────
			//
			// 色值不是凭感觉挑的，是逐帧量出来的：画布 #282D33、消息条
			// #393D49、输入卡 #3C4147、弹窗卡片 #4D4F64。这四层构成一条
			// 明度阶梯，所以 layer-1..4 直接沿用它们，而不是自己再摊一遍
			// 灰度 —— 阶梯感来自「每一层都比下一层亮一档」，一旦重排就散。
			//
			// 强调色只取实测的两个采样点 #8FA7E3 / #ABCEF6，且**刻意不用
			// 纯蓝**：那个界面里蓝是稀薄的、偏灰的，蓝到饱和就变成另一套
			// 审美（霓虹）。所以 brand 落在 #8FA7E3，链接再亮一档。
			//
			// 文字不动成纯白 #FFF：深蓝灰底上纯白会发飘、锐得像 LCD 测试
			// 图。用 #E6E9EF，比白暗一档、略带蓝，与底的色相同源。
			midnight: {
				label: "午夜蓝",
				tokens: {
					dark: {
						"--dsw-alias-bg-base": "#282d33",
						"--dsw-alias-bg-layer-1": "#2e333a",
						"--dsw-alias-bg-layer-2": "#343a43",
						"--dsw-alias-bg-layer-3": "#3c4147",
						"--dsw-alias-bg-layer-4": "#4d4f64",
						"--dsw-alias-bg-overlay": "#30353c",
						"--dsw-alias-bg-mask-1": "rgba(8,11,26,0.66)",
						"--dsw-alias-bg-module-platform": "#2e333a",
						"--dsw-alias-border-l1": "rgba(171,206,246,0.13)",
						"--dsw-alias-border-l2": "rgba(171,206,246,0.20)",
						"--dsw-alias-border-l3": "rgba(171,206,246,0.28)",
						"--dsw-alias-border-l4": "rgba(171,206,246,0.38)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(171,206,246,0.11)",
						"--dsw-alias-label-primary": "#e6e9ef",
						"--dsw-alias-label-secondary": "#b6bec9",
						"--dsw-alias-label-tertiary": "#8d96a3",
						"--dsw-alias-label-dimmed": "#5a626e",
						"--dsw-alias-label-caption": "#79828f",
						"--dsw-alias-label-shimmer": "rgba(171,206,246,0.08)",
						"--dsw-alias-label-primary-foreground": "#1b2028",
						"--dsw-alias-label-error": "#e88b8b",
						"--dsw-alias-brand-primary": "#8fa7e3",
						"--dsw-alias-link": "#abcef6",
						"--dsw-alias-state-business-primary": "#8fa7e3",
						"--dsw-alias-state-error-primary": "#e88b8b",
						"--dsw-alias-state-success-primary": "#7fc8a9",
						"--dsw-alias-state-warn-primary": "#e0bd7a",
						"--dsw-alias-state-idle-primary": "#6b7480",
						"--dsw-alias-interactive-bg-hover": "rgba(171,206,246,0.09)",
						"--dsw-alias-interactive-bg-hover-accent": "rgba(143,167,227,0.16)",
						"--dsw-alias-interactive-bg-hover-solid": "#343a43",
						"--dsw-alias-interactive-bg-active": "rgba(171,206,246,0.17)",
						"--dsw-alias-button-primary-fill": "#8fa7e3",
						"--dsw-alias-button-primary-hover": "#abcef6",
						"--dsw-alias-button-ghost-active-fill": "rgba(171,206,246,0.17)",
						"--dsw-alias-button-ghost-active-border": "rgba(171,206,246,0.32)",
						"--dsw-alias-button-tool-bar-fill": "rgba(171,206,246,0.09)",
						"--dsw-alias-button-tool-bar-hover": "rgba(171,206,246,0.17)",
						"--dsw-alias-markdown-code-block": "#23272d",
						"--dsw-alias-markdown-code-block-banner": "#2e333a",
						"--dsw-alias-markdown-inline-code": "#333942",
						"--dsw-alias-markdown-tag": "#2e333a",
						"--dsw-alias-menu-icon": "#9aa4b2",
						"--dsw-alias-menu-group-header-fill": "#7b8593",
						"--dsw-alias-tooltip-bg": "#4d4f64",
						"--dsw-alias-tooltip-key-bg": "rgba(171,206,246,0.14)",
						"--dsw-alias-toast-bg": "#4d4f64",
						"--dsw-alias-toast-label": "#e6e9ef",
						"--dsw-alias-switch-thumb": "#cfd7e3",
						"--dsw-alias-scrollbar-bg-l2": "#3c4147",
						"--dsw-alias-scrollbar-hover-l2": "#565b6b",
						"--dsw-alias-code-diff-added": "rgba(127,200,169,0.18)",
						"--dsw-alias-code-diff-deleted": "rgba(232,139,139,0.18)",
						"--dsw-specific-sidebar-fill": "#23272d",
						"--dsw-specific-sidebar-nav-item-active": "#3c4147",
						"--dsw-specific-sidebar-nav-item-hover": "#2e333a",
						"--dsw-specific-bubble": "#2e333a",
						"--dsw-specific-bubble-highlight": "#393d49",
						"--dsw-specific-input-major": "#3c4147",
						"--dsw-specific-menu": "#343a43",
						"--dsw-specific-selector": "#3c4147",
						"--dsw-specific-tip": "#2e333a",
						"--dsw-menu-surface-fill": "#343a43",
						"--dsw-menu-backdrop-filter": "blur(28px) saturate(1.15)"
					},
					light: {
						"--dsw-alias-bg-base": "#eef1f6",
						"--dsw-alias-bg-layer-1": "#f6f8fb",
						"--dsw-alias-bg-layer-2": "#ffffff",
						"--dsw-alias-bg-layer-3": "#ffffff",
						"--dsw-alias-bg-layer-4": "#ffffff",
						"--dsw-alias-bg-overlay": "#f2f5fa",
						"--dsw-alias-bg-mask-1": "rgba(24,32,48,0.34)",
						"--dsw-alias-bg-module-platform": "#e7ecf4",
						"--dsw-alias-border-l1": "rgba(40,45,51,0.13)",
						"--dsw-alias-border-l2": "rgba(40,45,51,0.19)",
						"--dsw-alias-border-l3": "rgba(40,45,51,0.27)",
						"--dsw-alias-border-l4": "rgba(40,45,51,0.37)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(40,45,51,0.13)",
						"--dsw-alias-label-primary": "#22262c",
						"--dsw-alias-label-secondary": "#4d545e",
						"--dsw-alias-label-tertiary": "#727a86",
						"--dsw-alias-label-dimmed": "#b3b9c2",
						"--dsw-alias-label-caption": "#8b929c",
						"--dsw-alias-label-shimmer": "rgba(40,45,51,0.06)",
						"--dsw-alias-label-primary-foreground": "#ffffff",
						"--dsw-alias-label-error": "#c0392b",
						"--dsw-alias-brand-primary": "#3d6bcc",
						"--dsw-alias-link": "#2f5fbf",
						"--dsw-alias-state-business-primary": "#3d6bcc",
						"--dsw-alias-state-error-primary": "#c0392b",
						"--dsw-alias-state-success-primary": "#1f7a5a",
						"--dsw-alias-state-warn-primary": "#8a6414",
						"--dsw-alias-state-idle-primary": "#8b929c",
						"--dsw-alias-interactive-bg-hover": "rgba(40,45,51,0.06)",
						"--dsw-alias-interactive-bg-hover-accent": "rgba(61,107,204,0.12)",
						"--dsw-alias-interactive-bg-hover-solid": "#e7ecf4",
						"--dsw-alias-interactive-bg-active": "rgba(40,45,51,0.12)",
						"--dsw-alias-button-primary-fill": "#3d6bcc",
						"--dsw-alias-button-primary-hover": "#2f5fbf",
						"--dsw-alias-button-ghost-active-fill": "rgba(40,45,51,0.12)",
						"--dsw-alias-button-ghost-active-border": "rgba(40,45,51,0.26)",
						"--dsw-alias-button-tool-bar-fill": "rgba(40,45,51,0.06)",
						"--dsw-alias-button-tool-bar-hover": "rgba(40,45,51,0.12)",
						"--dsw-alias-markdown-code-block": "#e9eef6",
						"--dsw-alias-markdown-code-block-banner": "#dfe6f1",
						"--dsw-alias-markdown-inline-code": "#e9eef6",
						"--dsw-alias-markdown-tag": "#dfe6f1",
						"--dsw-alias-menu-icon": "#4d545e",
						"--dsw-alias-menu-group-header-fill": "#727a86",
						"--dsw-alias-tooltip-bg": "#22262c",
						"--dsw-alias-tooltip-key-bg": "rgba(255,255,255,0.16)",
						"--dsw-alias-toast-bg": "#22262c",
						"--dsw-alias-toast-label": "#ffffff",
						"--dsw-alias-switch-thumb": "#ffffff",
						"--dsw-alias-scrollbar-bg-l2": "#cfd7e3",
						"--dsw-alias-scrollbar-hover-l2": "#aeb8c8",
						"--dsw-alias-code-diff-added": "rgba(31,122,90,0.14)",
						"--dsw-alias-code-diff-deleted": "rgba(192,57,43,0.14)",
						"--dsw-specific-sidebar-fill": "#e7ecf4",
						"--dsw-specific-sidebar-nav-item-active": "#dde4ef",
						"--dsw-specific-sidebar-nav-item-hover": "#f2f5fa",
						"--dsw-specific-bubble": "#f6f8fb",
						"--dsw-specific-bubble-highlight": "#e7ecf4",
						"--dsw-specific-input-major": "#ffffff",
						"--dsw-specific-menu": "#ffffff",
						"--dsw-specific-selector": "#ffffff",
						"--dsw-specific-tip": "#f2f5fa",
						"--dsw-menu-surface-fill": "rgba(255,255,255,0.78)",
						"--dsw-menu-backdrop-filter": "blur(28px) saturate(1.15)"
					}
				}
			}
,
			porcelain: {
				label: "靛蓝瓷",
				tokens: {
					dark: {
						"--dsw-alias-bg-base": "#0c1622",
						"--dsw-alias-bg-layer-1": "#111d2c",
						"--dsw-alias-bg-layer-2": "#162435",
						"--dsw-alias-bg-layer-3": "#1b2c40",
						"--dsw-alias-bg-layer-4": "#22374f",
						"--dsw-alias-bg-overlay": "#101b28",
						"--dsw-alias-bg-mask-1": "rgba(4,9,16,0.68)",
						"--dsw-alias-bg-module-platform": "#111d2c",
						"--dsw-alias-border-l1": "rgba(150,183,222,0.14)",
						"--dsw-alias-border-l2": "rgba(150,183,222,0.22)",
						"--dsw-alias-border-l3": "rgba(150,183,222,0.30)",
						"--dsw-alias-border-l4": "rgba(150,183,222,0.40)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(150,183,222,0.12)",
						"--dsw-alias-label-primary": "#e4ebf3",
						"--dsw-alias-label-secondary": "#b3c1d1",
						"--dsw-alias-label-tertiary": "#8a99ab",
						"--dsw-alias-label-dimmed": "#566475",
						"--dsw-alias-label-caption": "#77869a",
						"--dsw-alias-label-shimmer": "rgba(150,183,222,0.08)",
						"--dsw-alias-label-primary-foreground": "#0a1018",
						"--dsw-alias-label-error": "#e79a97",
						"--dsw-alias-brand-primary": "#6f9cd4",
						"--dsw-alias-link": "#9dc0e8",
						"--dsw-alias-state-business-primary": "#6f9cd4",
						"--dsw-alias-state-error-primary": "#e79a97",
						"--dsw-alias-state-success-primary": "#79c3a6",
						"--dsw-alias-state-warn-primary": "#d8b571",
						"--dsw-alias-state-idle-primary": "#64748a",
						"--dsw-alias-interactive-bg-hover": "rgba(150,183,222,0.09)",
						"--dsw-alias-interactive-bg-hover-accent": "rgba(111,156,212,0.16)",
						"--dsw-alias-interactive-bg-hover-solid": "#162435",
						"--dsw-alias-interactive-bg-active": "rgba(150,183,222,0.17)",
						"--dsw-alias-button-primary-fill": "#6f9cd4",
						"--dsw-alias-button-primary-hover": "#9dc0e8",
						"--dsw-alias-button-ghost-active-fill": "rgba(150,183,222,0.17)",
						"--dsw-alias-button-ghost-active-border": "rgba(150,183,222,0.33)",
						"--dsw-alias-button-tool-bar-fill": "rgba(150,183,222,0.09)",
						"--dsw-alias-button-tool-bar-hover": "rgba(150,183,222,0.17)",
						"--dsw-alias-markdown-code-block": "#0a1320",
						"--dsw-alias-markdown-code-block-banner": "#111d2c",
						"--dsw-alias-markdown-inline-code": "#14202f",
						"--dsw-alias-markdown-tag": "#111d2c",
						"--dsw-alias-menu-icon": "#93a2b5",
						"--dsw-alias-menu-group-header-fill": "#77869a",
						"--dsw-alias-tooltip-bg": "#22374f",
						"--dsw-alias-tooltip-key-bg": "rgba(150,183,222,0.14)",
						"--dsw-alias-toast-bg": "#22374f",
						"--dsw-alias-toast-label": "#e4ebf3",
						"--dsw-alias-switch-thumb": "#cfdbe8",
						"--dsw-alias-scrollbar-bg-l2": "#1b2c40",
						"--dsw-alias-scrollbar-hover-l2": "#2c4460",
						"--dsw-alias-code-diff-added": "rgba(121,195,166,0.18)",
						"--dsw-alias-code-diff-deleted": "rgba(231,154,151,0.18)",
						"--dsw-specific-sidebar-fill": "#0a1320",
						"--dsw-specific-sidebar-nav-item-active": "#1b2c40",
						"--dsw-specific-sidebar-nav-item-hover": "#111d2c",
						"--dsw-specific-bubble": "#162435",
						"--dsw-specific-bubble-highlight": "#1e3046",
						"--dsw-specific-input-major": "#1b2c40",
						"--dsw-specific-menu": "#162435",
						"--dsw-specific-selector": "#1b2c40",
						"--dsw-specific-tip": "#162435",
						"--dsw-menu-surface-fill": "#162435",
						"--dsw-menu-backdrop-filter": "blur(28px) saturate(1.15)"
					},
					light: {
						"--dsw-alias-bg-base": "#f1f3f5",
						"--dsw-alias-bg-layer-1": "#f8f9fb",
						"--dsw-alias-bg-layer-2": "#fcfdfe",
						"--dsw-alias-bg-layer-3": "#fcfdfe",
						"--dsw-alias-bg-layer-4": "#fcfdfe",
						"--dsw-alias-bg-overlay": "#eef1f4",
						"--dsw-alias-bg-mask-1": "rgba(10,31,61,0.30)",
						"--dsw-alias-bg-module-platform": "#e9edf1",
						"--dsw-alias-border-l1": "rgba(10,31,61,0.14)",
						"--dsw-alias-border-l2": "rgba(10,31,61,0.20)",
						"--dsw-alias-border-l3": "rgba(10,31,61,0.28)",
						"--dsw-alias-border-l4": "rgba(10,31,61,0.38)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(10,31,61,0.14)",
						"--dsw-alias-label-primary": "#0a1f3d",
						"--dsw-alias-label-secondary": "#3c4f66",
						"--dsw-alias-label-tertiary": "#61738a",
						"--dsw-alias-label-dimmed": "#a8b4c2",
						"--dsw-alias-label-caption": "#7c8b9d",
						"--dsw-alias-label-shimmer": "rgba(10,31,61,0.06)",
						"--dsw-alias-label-primary-foreground": "#fbfcfe",
						"--dsw-alias-label-error": "#a8342c",
						"--dsw-alias-brand-primary": "#315d93",
						"--dsw-alias-link": "#2a5285",
						"--dsw-alias-state-business-primary": "#315d93",
						"--dsw-alias-state-error-primary": "#a8342c",
						"--dsw-alias-state-success-primary": "#1f6b52",
						"--dsw-alias-state-warn-primary": "#8a5f14",
						"--dsw-alias-state-idle-primary": "#7c8b9d",
						"--dsw-alias-interactive-bg-hover": "rgba(10,31,61,0.06)",
						"--dsw-alias-interactive-bg-hover-accent": "rgba(49,93,147,0.12)",
						"--dsw-alias-interactive-bg-hover-solid": "#e9edf1",
						"--dsw-alias-interactive-bg-active": "rgba(10,31,61,0.11)",
						"--dsw-alias-button-primary-fill": "#315d93",
						"--dsw-alias-button-primary-hover": "#2a5285",
						"--dsw-alias-button-ghost-active-fill": "rgba(49,93,147,0.14)",
						"--dsw-alias-button-ghost-active-border": "rgba(49,93,147,0.34)",
						"--dsw-alias-button-tool-bar-fill": "rgba(10,31,61,0.05)",
						"--dsw-alias-button-tool-bar-hover": "rgba(10,31,61,0.11)",
						"--dsw-alias-markdown-code-block": "#e9eef3",
						"--dsw-alias-markdown-code-block-banner": "#dee5ec",
						"--dsw-alias-markdown-inline-code": "#e9eef3",
						"--dsw-alias-markdown-tag": "#dee5ec",
						"--dsw-alias-menu-icon": "#3c4f66",
						"--dsw-alias-menu-group-header-fill": "#61738a",
						"--dsw-alias-tooltip-bg": "#0a1f3d",
						"--dsw-alias-tooltip-key-bg": "rgba(255,255,255,0.16)",
						"--dsw-alias-toast-bg": "#0a1f3d",
						"--dsw-alias-toast-label": "#f2f6fa",
						"--dsw-alias-switch-thumb": "#fcfdfe",
						"--dsw-alias-scrollbar-bg-l2": "#ccd6e0",
						"--dsw-alias-scrollbar-hover-l2": "#adbacb",
						"--dsw-alias-code-diff-added": "rgba(31,107,82,0.14)",
						"--dsw-alias-code-diff-deleted": "rgba(168,52,44,0.13)",
						"--dsw-specific-sidebar-fill": "#e9edf1",
						"--dsw-specific-sidebar-nav-item-active": "#dfe6ee",
						"--dsw-specific-sidebar-nav-item-hover": "#f2f5f8",
						"--dsw-specific-bubble": "#f8f9fb",
						"--dsw-specific-bubble-highlight": "#e9edf1",
						"--dsw-specific-input-major": "#fcfdfe",
						"--dsw-specific-menu": "#fbfcfd",
						"--dsw-specific-selector": "#fcfdfe",
						"--dsw-specific-tip": "#f2f5f8",
						"--dsw-menu-surface-fill": "rgba(251,252,253,0.82)",
						"--dsw-menu-backdrop-filter": "blur(28px) saturate(1.15)"
					}
				}
			},
			ikb: {
				label: "克莱因蓝",
				tokens: {
					dark: {
						"--dsw-alias-bg-base": "#0b0b0c",
						"--dsw-alias-bg-layer-1": "#121213",
						"--dsw-alias-bg-layer-2": "#181819",
						"--dsw-alias-bg-layer-3": "#1f1f21",
						"--dsw-alias-bg-layer-4": "#26262a",
						"--dsw-alias-bg-overlay": "#111112",
						"--dsw-alias-bg-mask-1": "rgba(0,0,0,0.66)",
						"--dsw-alias-bg-module-platform": "#121213",
						"--dsw-alias-border-l1": "rgba(255,255,255,0.15)",
						"--dsw-alias-border-l2": "rgba(255,255,255,0.23)",
						"--dsw-alias-border-l3": "rgba(255,255,255,0.32)",
						"--dsw-alias-border-l4": "rgba(255,255,255,0.44)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(255,255,255,0.13)",
						"--dsw-alias-label-primary": "#f4f4f2",
						"--dsw-alias-label-secondary": "#c3c3bf",
						"--dsw-alias-label-tertiary": "#93938d",
						"--dsw-alias-label-dimmed": "#5c5c57",
						"--dsw-alias-label-caption": "#7c7c76",
						"--dsw-alias-label-shimmer": "rgba(255,255,255,0.07)",
						"--dsw-alias-label-primary-foreground": "#0b0b0c",
						"--dsw-alias-label-error": "#f08a84",
						"--dsw-alias-brand-primary": "#4a6ff0",
						"--dsw-alias-link": "#93a8ff",
						"--dsw-alias-state-business-primary": "#4a6ff0",
						"--dsw-alias-state-error-primary": "#f08a84",
						"--dsw-alias-state-success-primary": "#6fd1a3",
						"--dsw-alias-state-warn-primary": "#e0bb6a",
						"--dsw-alias-state-idle-primary": "#6d6d68",
						"--dsw-alias-interactive-bg-hover": "rgba(255,255,255,0.07)",
						"--dsw-alias-interactive-bg-hover-accent": "rgba(74,111,240,0.20)",
						"--dsw-alias-interactive-bg-hover-solid": "#181819",
						"--dsw-alias-interactive-bg-active": "rgba(255,255,255,0.13)",
						"--dsw-alias-button-primary-fill": "#4a6ff0",
						"--dsw-alias-button-primary-hover": "#93a8ff",
						"--dsw-alias-button-ghost-active-fill": "rgba(74,111,240,0.20)",
						"--dsw-alias-button-ghost-active-border": "rgba(74,111,240,0.42)",
						"--dsw-alias-button-tool-bar-fill": "rgba(255,255,255,0.06)",
						"--dsw-alias-button-tool-bar-hover": "rgba(255,255,255,0.13)",
						"--dsw-alias-markdown-code-block": "#0e0e10",
						"--dsw-alias-markdown-code-block-banner": "#121213",
						"--dsw-alias-markdown-inline-code": "#17171a",
						"--dsw-alias-markdown-tag": "#121213",
						"--dsw-alias-menu-icon": "#a0a09a",
						"--dsw-alias-menu-group-header-fill": "#7c7c76",
						"--dsw-alias-tooltip-bg": "#26262a",
						"--dsw-alias-tooltip-key-bg": "rgba(255,255,255,0.14)",
						"--dsw-alias-toast-bg": "#26262a",
						"--dsw-alias-toast-label": "#f4f4f2",
						"--dsw-alias-switch-thumb": "#dcdcd8",
						"--dsw-alias-scrollbar-bg-l2": "#1f1f21",
						"--dsw-alias-scrollbar-hover-l2": "#3a3a40",
						"--dsw-alias-code-diff-added": "rgba(111,209,163,0.18)",
						"--dsw-alias-code-diff-deleted": "rgba(240,138,132,0.18)",
						"--dsw-specific-sidebar-fill": "#0e0e10",
						"--dsw-specific-sidebar-nav-item-active": "#1f1f21",
						"--dsw-specific-sidebar-nav-item-hover": "#121213",
						"--dsw-specific-bubble": "#181819",
						"--dsw-specific-bubble-highlight": "#222226",
						"--dsw-specific-input-major": "#1f1f21",
						"--dsw-specific-menu": "#181819",
						"--dsw-specific-selector": "#1f1f21",
						"--dsw-specific-tip": "#181819",
						"--dsw-menu-surface-fill": "#181819",
						"--dsw-menu-backdrop-filter": "blur(28px) saturate(1.15)"
					},
					light: {
						"--dsw-alias-bg-base": "#fafaf8",
						"--dsw-alias-bg-layer-1": "#fdfdfb",
						"--dsw-alias-bg-layer-2": "#fdfdfb",
						"--dsw-alias-bg-layer-3": "#fdfdfb",
						"--dsw-alias-bg-layer-4": "#fdfdfb",
						"--dsw-alias-bg-overlay": "#f4f4f1",
						"--dsw-alias-bg-mask-1": "rgba(10,10,10,0.42)",
						"--dsw-alias-bg-module-platform": "#f0f0ec",
						"--dsw-alias-border-l1": "rgba(10,10,10,0.16)",
						"--dsw-alias-border-l2": "rgba(10,10,10,0.24)",
						"--dsw-alias-border-l3": "rgba(10,10,10,0.34)",
						"--dsw-alias-border-l4": "rgba(10,10,10,0.46)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(10,10,10,0.16)",
						"--dsw-alias-label-primary": "#0a0a0a",
						"--dsw-alias-label-secondary": "#3a3a38",
						"--dsw-alias-label-tertiary": "#6b6b66",
						"--dsw-alias-label-dimmed": "#b3b3ac",
						"--dsw-alias-label-caption": "#8a8a83",
						"--dsw-alias-label-shimmer": "rgba(10,10,10,0.05)",
						"--dsw-alias-label-primary-foreground": "#fbfbf9",
						"--dsw-alias-label-error": "#b3261e",
						"--dsw-alias-brand-primary": "#002FA7",
						"--dsw-alias-link": "#002b96",
						"--dsw-alias-state-business-primary": "#002FA7",
						"--dsw-alias-state-error-primary": "#b3261e",
						"--dsw-alias-state-success-primary": "#146c43",
						"--dsw-alias-state-warn-primary": "#8a5c00",
						"--dsw-alias-state-idle-primary": "#8a8a83",
						"--dsw-alias-interactive-bg-hover": "rgba(10,10,10,0.05)",
						"--dsw-alias-interactive-bg-hover-accent": "rgba(0,47,167,0.10)",
						"--dsw-alias-interactive-bg-hover-solid": "#f0f0ec",
						"--dsw-alias-interactive-bg-active": "rgba(10,10,10,0.10)",
						"--dsw-alias-button-primary-fill": "#002FA7",
						"--dsw-alias-button-primary-hover": "#00227a",
						"--dsw-alias-button-ghost-active-fill": "rgba(0,47,167,0.12)",
						"--dsw-alias-button-ghost-active-border": "rgba(0,47,167,0.38)",
						"--dsw-alias-button-tool-bar-fill": "rgba(10,10,10,0.04)",
						"--dsw-alias-button-tool-bar-hover": "rgba(10,10,10,0.10)",
						"--dsw-alias-markdown-code-block": "#f0f0ec",
						"--dsw-alias-markdown-code-block-banner": "#e6e6e1",
						"--dsw-alias-markdown-inline-code": "#f0f0ec",
						"--dsw-alias-markdown-tag": "#e6e6e1",
						"--dsw-alias-menu-icon": "#3a3a38",
						"--dsw-alias-menu-group-header-fill": "#6b6b66",
						"--dsw-alias-tooltip-bg": "#0a0a0a",
						"--dsw-alias-tooltip-key-bg": "rgba(255,255,255,0.18)",
						"--dsw-alias-toast-bg": "#0a0a0a",
						"--dsw-alias-toast-label": "#fbfbf9",
						"--dsw-alias-switch-thumb": "#fdfdfb",
						"--dsw-alias-scrollbar-bg-l2": "#d6d6d0",
						"--dsw-alias-scrollbar-hover-l2": "#b8b8b0",
						"--dsw-alias-code-diff-added": "rgba(20,108,67,0.14)",
						"--dsw-alias-code-diff-deleted": "rgba(179,38,30,0.14)",
						"--dsw-specific-sidebar-fill": "#f0f0ec",
						"--dsw-specific-sidebar-nav-item-active": "#e4e4de",
						"--dsw-specific-sidebar-nav-item-hover": "#f6f6f3",
						"--dsw-specific-bubble": "#fdfdfb",
						"--dsw-specific-bubble-highlight": "#f0f0ec",
						"--dsw-specific-input-major": "#fdfdfb",
						"--dsw-specific-menu": "#fdfdfb",
						"--dsw-specific-selector": "#fdfdfb",
						"--dsw-specific-tip": "#f4f4f1",
						"--dsw-menu-surface-fill": "rgba(253,253,251,0.84)",
						"--dsw-menu-backdrop-filter": "blur(28px) saturate(1.15)"
					}
				}
			},
			nightink: {
				label: "午夜墨",
				tokens: {
					dark: {
						"--dsw-alias-bg-base": "#0e0d0c",
						"--dsw-alias-bg-layer-1": "#151311",
						"--dsw-alias-bg-layer-2": "#1b1815",
						"--dsw-alias-bg-layer-3": "#221e1a",
						"--dsw-alias-bg-layer-4": "#2b2621",
						"--dsw-alias-bg-overlay": "#141210",
						"--dsw-alias-bg-mask-1": "rgba(0,0,0,0.70)",
						"--dsw-alias-bg-module-platform": "#151311",
						"--dsw-alias-border-l1": "rgba(212,160,74,0.14)",
						"--dsw-alias-border-l2": "rgba(212,160,74,0.21)",
						"--dsw-alias-border-l3": "rgba(212,160,74,0.29)",
						"--dsw-alias-border-l4": "rgba(212,160,74,0.40)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(212,160,74,0.12)",
						"--dsw-alias-label-primary": "#ece2cf",
						"--dsw-alias-label-secondary": "#c3b7a1",
						"--dsw-alias-label-tertiary": "#96897a",
						"--dsw-alias-label-dimmed": "#5f574d",
						"--dsw-alias-label-caption": "#7d7166",
						"--dsw-alias-label-shimmer": "rgba(212,160,74,0.09)",
						"--dsw-alias-label-primary-foreground": "#100e0c",
						"--dsw-alias-label-error": "#e09a8a",
						"--dsw-alias-brand-primary": "#d4a04a",
						"--dsw-alias-link": "#e5c07b",
						"--dsw-alias-state-business-primary": "#d4a04a",
						"--dsw-alias-state-error-primary": "#e09a8a",
						"--dsw-alias-state-success-primary": "#8fb98a",
						"--dsw-alias-state-warn-primary": "#d8a94e",
						"--dsw-alias-state-idle-primary": "#6b6154",
						"--dsw-alias-interactive-bg-hover": "rgba(212,160,74,0.08)",
						"--dsw-alias-interactive-bg-hover-accent": "rgba(212,160,74,0.16)",
						"--dsw-alias-interactive-bg-hover-solid": "#1b1815",
						"--dsw-alias-interactive-bg-active": "rgba(212,160,74,0.16)",
						"--dsw-alias-button-primary-fill": "#d4a04a",
						"--dsw-alias-button-primary-hover": "#e5c07b",
						"--dsw-alias-button-ghost-active-fill": "rgba(212,160,74,0.16)",
						"--dsw-alias-button-ghost-active-border": "rgba(212,160,74,0.34)",
						"--dsw-alias-button-tool-bar-fill": "rgba(212,160,74,0.08)",
						"--dsw-alias-button-tool-bar-hover": "rgba(212,160,74,0.15)",
						"--dsw-alias-markdown-code-block": "#0b0a09",
						"--dsw-alias-markdown-code-block-banner": "#151311",
						"--dsw-alias-markdown-inline-code": "#181512",
						"--dsw-alias-markdown-tag": "#151311",
						"--dsw-alias-menu-icon": "#a2957f",
						"--dsw-alias-menu-group-header-fill": "#7d7166",
						"--dsw-alias-tooltip-bg": "#2b2621",
						"--dsw-alias-tooltip-key-bg": "rgba(212,160,74,0.14)",
						"--dsw-alias-toast-bg": "#2b2621",
						"--dsw-alias-toast-label": "#ece2cf",
						"--dsw-alias-switch-thumb": "#ded2bd",
						"--dsw-alias-scrollbar-bg-l2": "#221e1a",
						"--dsw-alias-scrollbar-hover-l2": "#3a3229",
						"--dsw-alias-code-diff-added": "rgba(143,185,138,0.18)",
						"--dsw-alias-code-diff-deleted": "rgba(224,154,138,0.18)",
						"--dsw-specific-sidebar-fill": "#0b0a09",
						"--dsw-specific-sidebar-nav-item-active": "#221e1a",
						"--dsw-specific-sidebar-nav-item-hover": "#151311",
						"--dsw-specific-bubble": "#1b1815",
						"--dsw-specific-bubble-highlight": "#241f1a",
						"--dsw-specific-input-major": "#221e1a",
						"--dsw-specific-menu": "#1b1815",
						"--dsw-specific-selector": "#221e1a",
						"--dsw-specific-tip": "#1b1815",
						"--dsw-menu-surface-fill": "#1b1815",
						"--dsw-menu-backdrop-filter": "blur(28px) saturate(1.15)"
					},
					light: {
						"--dsw-alias-bg-base": "#efe9dd",
						"--dsw-alias-bg-layer-1": "#f5f0e6",
						"--dsw-alias-bg-layer-2": "#faf6ee",
						"--dsw-alias-bg-layer-3": "#faf6ee",
						"--dsw-alias-bg-layer-4": "#faf6ee",
						"--dsw-alias-bg-overlay": "#eae3d5",
						"--dsw-alias-bg-mask-1": "rgba(30,24,16,0.32)",
						"--dsw-alias-bg-module-platform": "#e5ddcd",
						"--dsw-alias-border-l1": "rgba(42,30,19,0.16)",
						"--dsw-alias-border-l2": "rgba(42,30,19,0.23)",
						"--dsw-alias-border-l3": "rgba(42,30,19,0.31)",
						"--dsw-alias-border-l4": "rgba(42,30,19,0.42)",
						"--dsw-alias-border-l2-darkmode-thin": "rgba(42,30,19,0.16)",
						"--dsw-alias-label-primary": "#1d1710",
						"--dsw-alias-label-secondary": "#4a3f31",
						"--dsw-alias-label-tertiary": "#6d604e",
						"--dsw-alias-label-dimmed": "#ada192",
						"--dsw-alias-label-caption": "#83755f",
						"--dsw-alias-label-shimmer": "rgba(42,30,19,0.05)",
						"--dsw-alias-label-primary-foreground": "#faf6ee",
						"--dsw-alias-label-error": "#a03a2a",
						"--dsw-alias-brand-primary": "#8a6420",
						"--dsw-alias-link": "#7d5a1c",
						"--dsw-alias-state-business-primary": "#8a6420",
						"--dsw-alias-state-error-primary": "#a03a2a",
						"--dsw-alias-state-success-primary": "#3d6b3f",
						"--dsw-alias-state-warn-primary": "#8a6420",
						"--dsw-alias-state-idle-primary": "#83755f",
						"--dsw-alias-interactive-bg-hover": "rgba(42,30,19,0.06)",
						"--dsw-alias-interactive-bg-hover-accent": "rgba(138,100,32,0.12)",
						"--dsw-alias-interactive-bg-hover-solid": "#e5ddcd",
						"--dsw-alias-interactive-bg-active": "rgba(42,30,19,0.11)",
						"--dsw-alias-button-primary-fill": "#8a6420",
						"--dsw-alias-button-primary-hover": "#6f4f16",
						"--dsw-alias-button-ghost-active-fill": "rgba(138,100,32,0.14)",
						"--dsw-alias-button-ghost-active-border": "rgba(138,100,32,0.36)",
						"--dsw-alias-button-tool-bar-fill": "rgba(42,30,19,0.05)",
						"--dsw-alias-button-tool-bar-hover": "rgba(42,30,19,0.11)",
						"--dsw-alias-markdown-code-block": "#e8e0cf",
						"--dsw-alias-markdown-code-block-banner": "#ded3bd",
						"--dsw-alias-markdown-inline-code": "#e8e0cf",
						"--dsw-alias-markdown-tag": "#ded3bd",
						"--dsw-alias-menu-icon": "#4a3f31",
						"--dsw-alias-menu-group-header-fill": "#6d604e",
						"--dsw-alias-tooltip-bg": "#1d1710",
						"--dsw-alias-tooltip-key-bg": "rgba(255,255,255,0.18)",
						"--dsw-alias-toast-bg": "#1d1710",
						"--dsw-alias-toast-label": "#f5f0e6",
						"--dsw-alias-switch-thumb": "#faf6ee",
						"--dsw-alias-scrollbar-bg-l2": "#d5cab5",
						"--dsw-alias-scrollbar-hover-l2": "#bcae95",
						"--dsw-alias-code-diff-added": "rgba(61,107,63,0.14)",
						"--dsw-alias-code-diff-deleted": "rgba(160,58,42,0.13)",
						"--dsw-specific-sidebar-fill": "#e5ddcd",
						"--dsw-specific-sidebar-nav-item-active": "#dbd1bd",
						"--dsw-specific-sidebar-nav-item-hover": "#efe8da",
						"--dsw-specific-bubble": "#f5f0e6",
						"--dsw-specific-bubble-highlight": "#e5ddcd",
						"--dsw-specific-input-major": "#faf6ee",
						"--dsw-specific-menu": "#faf6ee",
						"--dsw-specific-selector": "#faf6ee",
						"--dsw-specific-tip": "#efe8da",
						"--dsw-menu-surface-fill": "rgba(250,246,238,0.84)",
						"--dsw-menu-backdrop-filter": "blur(28px) saturate(1.15)"
					}
				}
			}
		};

		function isDarkTheme() {
			const body = document.body;
			return Boolean(body && body.hasAttribute("data-ds-dark-theme"));
		}

		// ── which scheme the colour editor is pointed at ───────────────────
		//
		// `marks.editScheme` is not a cosmetic tab state: setMark() writes into
		// state.marks[editScheme], while buildMarkCss() paints state.marks.light
		// on `:root` and state.marks.dark behind `[data-ds-dark-theme]`. On a dark
		// app those are two different layers, and the dark one wins every element
		// inside it. So editing the "light" slot while the app is dark writes a
		// value that is then completely shadowed: the state changes, the
		// stylesheet changes, and not one pixel of rendered text moves. That is
		// exactly the "自己改就是没生效" report.
		//
		// The editor therefore FOLLOWS the live theme by default. Following is
		// sticky only until the user takes the tabs by hand: once they click a
		// tab they are choosing deliberately (typically to dress the other theme
		// for later), and a background theme flip must not yank the panel out
		// from under them. `marksSchemeManual` is that latch — runtime-only, so a
		// reload re-arms following, and never persisted so this fix needs no
		// state migration.
		let marksSchemeManual = false;

		function liveScheme() {
			return isDarkTheme() ? "dark" : "light";
		}

		// Point the editor at the scheme the app is actually painting, unless the
		// user has claimed the tabs. Returns true when it moved.
		function syncEditScheme() {
			if (marksSchemeManual) return false;
			const live = liveScheme();
			if (state.marks.editScheme === live) return false;
			state.marks.editScheme = live;
			return true;
		}

		// Readability sampler. A single global average luminance can be fooled by
		// one bright corner, so we read a coarse grid of the frame instead, score
		// BOTH candidate schemes (light canvas + dark text, and the reverse)
		// against every cell under the active backing colour, and pick the scheme
		// whose WORST region still keeps the best contrast. Video frames are
		// re-sampled periodically because their content moves.
		const SAMPLE_COLS = 12;
		const SAMPLE_ROWS = 8;
		const READABLE_MIN = 4.5; // WCAG AA body-text contrast
		const BOOST_CAP = 0.92; // never fully bury the wallpaper behind the base
		// How far the READABILITY GUARD may lift the backing surface at render
		// time. Deliberately well below BOOST_CAP: the two numbers guard different
		// things. BOOST_CAP stops the base from becoming a solid block; this stops
		// it from erasing the artwork, which is what a dark surface over a bright
		// frame otherwise demands (~0.78 to reach AA). Past this point we accept
		// sub-AA contrast for the body text rather than hide the wallpaper.
		const READABILITY_ALPHA_MAX = 0.45;
		// How much of the gap between the user's backing opacity and the
		// AA-recommended one the guard may close, and the opacity at which that
		// assist is fully engaged. Three properties are load-bearing, and each one
		// rules out a version that was tried first:
		//
		//   • strictly monotone in the user's setting, so no slider move is ever
		//     swallowed — the "背景层调不了" report came from a FLOOR version,
		//     `max(alpha, 0.45)`, which silently ignored everything below 0.45;
		//   • additive only, so a user setting ABOVE the recommendation is never
		//     dragged back down by the guard (a plain blend to `need` did that);
		//   • ramped in with the user's own value, so there is no cliff at the
		//     bottom — engaging the full assist the instant the slider left zero
		//     would turn 1% into ~22%, which is the same complaint in miniature.
		// `need` is never reached, so the guard can only nudge legibility up; it
		// can never pin the surface out of the user's hands.
		const READABILITY_ALPHA_SHARE = 0.5;
		const READABILITY_ALPHA_RAMP = 0.2;
		// Contrast auto-tune aims a derived mark colour at, against the WORST
		// patch of the artwork behind it. Deliberately above the AA floor: a
		// colour that only just clears 4.5:1 reads as "technically legible" but
		// looks washed out, and the whole point of the derived tone is that the
		// user sees the font colour change to something clearly sharper.
		//
		// This is an ASPIRATION, not a guarantee — see MARK_LADDER_FLOOR below.
		const MARK_TARGET_RATIO = 6.5;
		// How much of the reachable contrast the LOOSEST role may surrender when
		// the artwork cannot deliver the recipe above.
		//
		// The ceiling on the whole feature is not the recipe, it is the surface:
		// against a tile of sRGB luminance L the best contrast ANY tone can reach
		// is (L+0.05)/0.05, and with the backing opacity the readability guard
		// actually paints (~0.17 at a 15% slider — the guard is deliberately
		// ramped in) that ceiling sits near 4.5:1. Inverting a demand of 6.5
		// against it asks for a luminance of -0.015, which clamps to 0 — and so
		// does every other role, from body's 7.5 down to marker's 4.6. That is the
		// measured "auto-tune did nothing" report: six roles, one identical
		// #000000, hue/chroma offsets all erased.
		//
		// When the recipe does not fit, the ladder is therefore COMPRESSED into
		// [ceiling * this, ceiling] instead of being clamped: the strictest role
		// (body — the text actually being read) keeps the crispest tone the
		// surface allows, every looser role keeps a distinguishable tone below
		// it, and the ordering between roles survives.
		//
		// The value is measured, not chosen. Sweeping candidates against four real
		// wallpapers plus greyscale ramps (the worst case — hue and chroma are both
		// zeroed, so LUMINANCE is the only channel left to tell six roles apart)
		// shows distinctness collapses below 0.92 and nothing is bought by going
		// lower: 0.92 is the highest floor that still yields six unique tones,
		// while body contrast stays pinned at the ceiling (4.54) at every floor
		// from 0.5 to 0.92. So 0.92 keeps the most contrast the six-way split
		// allows. Decorative roles land around 3.4:1 — above the 3:1 WCAG
		// non-text/UI floor, below AA for prose, which is why only decoration
		// gets them.
		const MARK_LADDER_FLOOR = 0.92;
		// Per-role recipe for the derived palette. Only the LIGHTNESS of a mark
		// colour is solved from the artwork; hue and chroma are fixed offsets
		// from the artwork's dominant hue, because a freely derived hue per role
		// is unpredictable — a red-on-red artwork would collapse all six roles
		// into one indistinguishable tone. The offsets are far enough apart that
		// no two roles can collide.
		//
		// `body` is included on purpose. It is the text the user actually reads,
		// so leaving it inherited while recolouring the decoration would miss the
		// "最清晰的字体颜色" half of the request; its low chroma keeps the result
		// a legible near-neutral rather than a coloured block of prose.
		//
		// Every role carries a DISTINCT ratio. The hue/chroma offsets alone cannot
		// keep them apart: on a greyscale artwork (`hue === null`) both are zeroed,
		// so two roles sharing a ratio collapse to one hex — and `link`/`code` used
		// to share 5.5, which made the code sample indistinguishable from a link on
		// any monochrome wallpaper. The reasons for the order (prose first, then
		// bold, then headings, code, links, decoration) are unchanged.
		const MARK_ROLE = {
			body: { hue: 0, chroma: 0.14, ratio: MARK_TARGET_RATIO + 1 },
			strong: { hue: 0, chroma: 0.5, ratio: MARK_TARGET_RATIO },
			heading: { hue: 46, chroma: 0.55, ratio: MARK_TARGET_RATIO - 0.5 },
			code: { hue: -34, chroma: 0.46, ratio: MARK_TARGET_RATIO - 0.7 },
			link: { hue: 22, chroma: 0.52, ratio: MARK_TARGET_RATIO - 1 },
			marker: { hue: -8, chroma: 0.34, ratio: 4.6 }
		};

		// What the last auto-tune learned about an artwork, keyed by URL. The
		// tune decodes the artwork anyway, so its dominant hue comes free — while
		// `ensureTint()` has to wait for the live wallpaper element to mount and
		// give up after ~1.5s if it never appears (the "tint-hue: none" silent
		// failure). Seeding the tint from here removes that dependency on mount
		// timing, and `tried` is what lets the panel say "this artwork has no
		// dominant hue" instead of spinning on 分析中… forever.
		let tuneCache = null;

		// `cells` keeps the last RAW sample (undimmed, straight from sampleGrid) so
		// a LATER event — the host restore landing after boot, or a slider move
		// after a theme flip — can re-solve the mark colours against the artwork
		// already on screen instead of waiting for a resample that the same-URL
		// guard in `ensureLuminance()` would refuse to start.
		//
		// `sampleUrl` says which artwork those pixels came from, which is NOT the
		// same question as `url`: `ensureLuminance()` claims `url` at the START of
		// sampling, so during an in-flight decode `url` already names a new
		// wallpaper while `cells` still holds the previous one's pixels. Re-solves
		// check `sampleUrl` so they never solve the new text against the old art.
		const lumState = { url: null, sampleUrl: null, ready: false, scheme: null, worst: null, mean: null, boost: null, token: 0, cells: null };
		let lumTimer = null;

		function stopLumWatch() {
			if (lumTimer) { clearInterval(lumTimer); lumTimer = null; }
		}

		/**
		 * Whether re-sampling a moving frame can still change anything. A fixed
		 * (non-auto) scheme with no backing surface never reads the sampled value,
		 * so the periodic watch would spend a GPU readback for nothing.
		 */
		function luminanceMatters() {
			const mode = state.ui && state.ui.contrast ? state.ui.contrast : "theme";
			if (mode === "auto") return true;
			return Boolean(state.ui && state.ui.readability === true) && clamp(state.wallpaper.opacity, 0, 1) > 0;
		}

		/**
		 * The backing-surface opacity actually painted for a given user setting.
		 * Single source of truth — the renderer and the panel read-out both call
		 * this, so the percentage shown can never drift from the one in use.
		 */
		function backingAlpha(userAlpha, boost) {
			const alpha = clamp(userAlpha, 0, 1);
			if (!(alpha > 0) || boost === null) return alpha;
			const need = Math.min(boost, READABILITY_ALPHA_MAX);
			const engage = clamp(alpha / READABILITY_ALPHA_RAMP, 0, 1) * READABILITY_ALPHA_SHARE;
			return Math.max(alpha, alpha + engage * (need - alpha));
		}

		/** sRGB relative luminance of a #rrggbb colour (0..1). */		function hexLum(hex) {
			const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
			const r = lin(parseInt(hex.slice(1, 3), 16) / 255);
			const g = lin(parseInt(hex.slice(3, 5), 16) / 255);
			const b = lin(parseInt(hex.slice(5, 7), 16) / 255);
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		}

		// Anchor luminance per scheme: the backing colour and the text tone it
		// pairs with (see TEXT_ON_LIGHT / TEXT_ON_DARK).
		const LUM_BASE_LIGHT = hexLum(BASE_LIGHT);
		const LUM_BASE_DARK = hexLum(BASE_DARK);
		const LUM_TEXT_DARK = hexLum(TEXT_ON_LIGHT[0]);
		const LUM_TEXT_LIGHT = hexLum(TEXT_ON_DARK[0]);

		// One canvas is reused for every sample. A fresh canvas per call defeats
		// the `willReadFrequently` hint and churns GPU/CPU memory on the sampling
		// cadence, which is exactly the cost we are trying to remove.
		let lumCanvas = null;

		/** Read a coarse luminance grid (0..1) from an image or video frame. */
		function sampleGrid(source) {
			try {
				if (!lumCanvas) {
					lumCanvas = document.createElement("canvas");
					lumCanvas.width = SAMPLE_COLS;
					lumCanvas.height = SAMPLE_ROWS;
				}
				const g = lumCanvas.getContext("2d", { willReadFrequently: true });
				if (!g) return null;
				g.clearRect(0, 0, SAMPLE_COLS, SAMPLE_ROWS);
				g.drawImage(source, 0, 0, SAMPLE_COLS, SAMPLE_ROWS);
				const data = g.getImageData(0, 0, SAMPLE_COLS, SAMPLE_ROWS).data;
				const cells = new Float32Array(SAMPLE_COLS * SAMPLE_ROWS);
				for (let i = 0; i < cells.length; i += 1) {
					const o = i * 4;
					const a = data[o + 3] / 255;
					// Fully transparent cells are "no content" (-1) so they do not
					// drag the worst-case score toward a fake extreme.
					cells[i] = a <= 0.05
						? -1
						: (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255;
				}
				return cells;
			} catch {
				// tainted canvas (cross-origin image/video) — fall back to theme
				return null;
			}
		}

		/** Worst (and mean) text contrast when `base`/`text` sit over `cells`. */
		function scoreScheme(cells, baseL, textL, alpha) {
			let worst = Infinity;
			let sum = 0;
			let n = 0;
			for (let i = 0; i < cells.length; i += 1) {
				const lc = cells[i];
				if (lc < 0) continue;
				const bg = alpha * baseL + (1 - alpha) * lc; // backing over wallpaper
				const hi = Math.max(bg, textL) + 0.05;
				const lo = Math.min(bg, textL) + 0.05;
				const ratio = hi / lo;
				if (ratio < worst) worst = ratio;
				sum += ratio;
				n += 1;
			}
			return n > 0 ? { worst, mean: sum / n } : null;
		}

		/** Pick the scheme whose worst region reads best; report its score. */
		function computeReadability(cells, alpha) {
			const light = scoreScheme(cells, LUM_BASE_LIGHT, LUM_TEXT_DARK, alpha);
			const dark = scoreScheme(cells, LUM_BASE_DARK, LUM_TEXT_LIGHT, alpha);
			if (!light || !dark) return null;
			const scheme = light.worst >= dark.worst ? "light" : "dark";
			const best = scheme === "light" ? light : dark;
			return { scheme, worst: best.worst, mean: best.mean };
		}

		/** Smallest backing alpha at which the chosen scheme clears AA. */
		function neededBacking(cells, scheme) {
			const baseL = scheme === "light" ? LUM_BASE_LIGHT : LUM_BASE_DARK;
			const textL = scheme === "light" ? LUM_TEXT_DARK : LUM_TEXT_LIGHT;
			for (let a = 0; a <= 1.0001; a += 0.02) {
				const s = scoreScheme(cells, baseL, textL, a);
				if (s && s.worst >= READABLE_MIN) return a;
			}
			return 1;
		}

		/**
		 * Derive the six mark colours from the artwork's own worst tile.
		 *
		 * The picked scheme is a statement about the SURFACE (light surface + dark
		 * text, or dark surface + light text), so the text tone is solvable: the
		 * tile that ends up closest to the text decides how dark (or light) the
		 * text has to be to clear `ratio`, and every role then gets that exact
		 * luminance via `tintSameLuminance`. Solving against the worst tile rather
		 * than the mean is the whole point — a mean-based tone looks fine in the
		 * average and still disappears over the one bright patch it has to survive.
		 *
		 * `alpha` must be the BACKING OPACITY ACTUALLY PAINTED (post-guard), not
		 * the raw slider value, or the colours are tuned for a surface that is not
		 * on screen.
		 */
		function deriveMarkColours(cells, scheme, alpha, hue) {
			if (!cells) return null;
			const light = scheme === "light";
			const baseL = light ? LUM_BASE_LIGHT : LUM_BASE_DARK;
			// The tile that lands closest to the text tone is the binding one: for
			// a light surface that is the DARKEST tile, for a dark surface the
			// brightest.
			let bg = null;
			for (let i = 0; i < cells.length; i += 1) {
				const lc = cells[i];
				if (lc < 0) continue;
				const v = alpha * baseL + (1 - alpha) * lc;
				if (bg === null) bg = v;
				else if (light ? v < bg : v > bg) bg = v;
			}
			if (bg === null) return null;
			const neutral = typeof hue !== "number" || !isFinite(hue);

			// The best contrast the BINDING tile can ever show: the ratio between it
			// and the extreme tone on the text side (black for a light surface, white
			// for a dark one). No recipe can conjure contrast the artwork does not
			// have — see MARK_LADDER_FLOOR.
			const ceiling = light ? (bg + 0.05) / 0.05 : 1.05 / (bg + 0.05);

			// The recipe spans a range of demands (marker 4.6 … body 7.5). Compress
			// the whole ladder into the reachable band when the STRICTEST role does
			// not fit; otherwise every role gets its exact demand. Compressing on
			// the strictest role alone is what keeps the ladder ORDERED — doing it
			// per role would let body fall below heading.
			let rLo = Infinity;
			let rHi = -Infinity;
			for (const key of MARK_KEYS) {
				const role = MARK_ROLE[key];
				if (!role) continue;
				if (role.ratio < rLo) rLo = role.ratio;
				if (role.ratio > rHi) rHi = role.ratio;
			}
			const compress = rHi > ceiling && rHi > rLo;

			const out = {};
			for (const key of MARK_KEYS) {
				const role = MARK_ROLE[key];
				if (!role) continue;
				// Where this role sits in the ladder, 0 = loosest (list bullets)
				// … 1 = strictest (body prose).
				let ratio = role.ratio;
				if (compress) {
					const u = (role.ratio - rLo) / (rHi - rLo);
					ratio = ceiling * (MARK_LADDER_FLOOR + u * (1 - MARK_LADDER_FLOOR));
				}
				// Invert the WCAG ratio for the text side. `scoreScheme` uses
				// (hi+0.05)/(lo+0.05); with the surface tone known, hi/lo is known,
				// so the text luminance falls straight out of it. With the ladder
				// compressed, `ratio <= ceiling` by construction, so this lands
				// inside 0..1 and the clamp stops being an absorbing state.
				const target = light
					? (bg + 0.05) / ratio - 0.05
					: ratio * (bg + 0.05) - 0.05;
				const l = clamp(target, 0, 1);
				// Hue == null means the artwork has no dominant hue (a grey or
				// monochrome source). Then the roles collapse to neutral greys
				// rather than inventing a colour the artwork does not contain — but
				// they keep their distinct ladder LIGHTNESSES, so the six roles stay
				// tellable apart even on a greyscale wallpaper.
				const rgb = tintSameLuminance(
					neutral ? 0 : hue + role.hue,
					neutral ? 0 : role.chroma,
					l
				);
				out[key] = rgbHex(rgb[0], rgb[1], rgb[2]);
			}
			return out;
		}

		/**
		 * Solve BOTH mark palettes against an already-sampled artwork and write
		 * them into the state. Returns true when a value actually CHANGED, not
		 * merely when a solution was found.
		 *
		 * Both schemes are derived, not just the painted one: the two sets live
		 * side by side in the state and the panel lets the user flip between
		 * them, so leaving the other set stale would mean the text goes
		 * unreadable the moment they switch the app's light/dark mode.
		 *
		 * The change test is what keeps the boot pass honest: it runs after every
		 * sample, and re-running it on unchanged artwork (the 8s re-sample of a
		 * video, a theme flip) must not look like a fresh derivation and trigger
		 * another save.
		 */
		function paintMarks(dimmed, painted, hue) {
			let touched = false;
			for (const name of ["light", "dark"]) {
				const derived = deriveMarkColours(dimmed, name, painted, hue);
				if (!derived) continue;
				const current = state.marks[name] || {};
				for (const key of MARK_KEYS) {
					if (derived[key] !== current[key]) { touched = true; break; }
				}
				state.marks[name] = Object.assign({}, current, derived);
			}
			return touched;
		}

		/**
		 * Whether the six mark colours in the state are the plugin's to rewrite.
		 *
		 * `ui.marksAuto` alone answers it: it is set the moment a derivation is
		 * written and cleared the moment the user touches the colours by hand
		 * (`setMark`) or picks a named preset (`applyPreset`). The state file
		 * cannot be used to infer this after the fact — a derived set and a
		 * hand-picked preset BOTH look like "six hex colours with no marker the
		 * user typed", so guessing from `marks.preset` would either re-derive over
		 * a manual preset on every launch or refuse to refresh the plugin's own
		 * output. That is why the flag is persisted rather than recomputed.
		 *
		 * `ui.tuneMarks` overrules on top of that: it is the switch the panel
		 * shows as 「字色随壁纸自动调优」, so with it off nothing is derived at all.
		 */
		function marksDerivable() {
			if (!state.ui || state.ui.tuneMarks === false) return false;
			return state.ui.marksAuto === true;
		}

		/**
		 * What the last tune measured for this artwork, if it ever ran on it.
		 *
		 * Returns `{ hue, sat }` — with `hue: null` meaning "measured, and the
		 * artwork has no dominant colour" — or null when this URL was never
		 * measured. The distinction matters: a greyscale answer is a finished
		 * result, so callers must not treat it as "unknown" and go re-derive it,
		 * but they must also not paint a tint from it.
		 *
		 * This is read from the persisted state rather than from `tuneCache`
		 * because it has to survive a restart — the module variable is empty at
		 * launch, and `ensureTint()` cannot fall back to the live element
		 * reliably (see ensureTint).
		 */
		function tuneSeedFor(url) {
			if (!state.ui || url === "" || state.ui.tuneHueUrl !== url) return null;
			const hue = state.ui.tuneHue;
			const known = typeof hue === "number" && isFinite(hue);
			const sat = typeof state.ui.tuneSat === "number" && isFinite(state.ui.tuneSat) ? state.ui.tuneSat : 0;
			return { hue: known ? hue : null, sat: known ? sat : 0 };
		}

		/**
		 * Re-solve the mark colours from the sample `commitSample()` already
		 * scored for the artwork currently on screen.
		 *
		 * This is the boot half of the feature. `autoTune()` only ever runs on an
		 * explicit pick, so before this existed a restart (or a host restore, or
		 * a theme flip) left whatever preset happened to be in the state sitting
		 * on top of the wallpaper — the derived colours were thrown away while
		 * the artwork they were solved for was still on screen.
		 *
		 * It reads the retained sample rather than decoding again because
		 * `ensureLuminance()` refuses to re-sample a URL it already scored, so
		 * those pixels are the only ones available without a fresh network read.
		 * Everything downstream of the pixels — the dim filter, the backing
		 * alpha, the readability boost — is recomputed here from the CURRENT
		 * state, so a pass that runs after the user has moved a slider solves
		 * against what is actually on screen now rather than against the values
		 * that happened to be in force when the sample was taken.
		 */
		/** The wallpaper URL the state currently points at, trimmed. */
		function currentWallpaperUrl() {
			const wp = state.wallpaper;
			return wp && typeof wp.url === "string" ? wp.url.trim() : "";
		}

		/**
		 * Re-solve the mark colours from a raw sample grid.
		 *
		 * `cells` is the UNDIMMED grid straight out of `sampleGrid()`. Passing the
		 * pixels rather than reading a stored copy keeps this usable from both
		 * callers: the pick path has a fresh decode of the artwork being chosen
		 * (`probe.cells`), while the boot path reuses the sample `commitSample()`
		 * scored, which is the only decode of the artwork already on screen
		 * (`ensureLuminance()` refuses to sample a URL twice).
		 *
		 * `hueHint` is the dominant hue measured for THAT grid. It is passed in
		 * rather than looked up because at pick time `lumState.url` still names
		 * the previous artwork, so a lookup would colour the new text with the old
		 * wallpaper's hue. Callers that have no measurement pass null (neutral
		 * greys) or omit it to fall back to the remembered hue for `lumState.url`.
		 *
		 * Everything downstream of the pixels — the dim filter, the backing alpha,
		 * the readability boost — is recomputed here from the CURRENT state, so a
		 * pass that runs after a slider moved solves against what is actually on
		 * screen now rather than the values in force when the sample was taken.
		 */
		function repaintMarks(cells, hueHint) {
			try {
				const raw = cells && cells.length ? cells : lumState.cells;
				if (!raw || !marksDerivable()) return;
				// A stored sample is only usable for the artwork it was taken from.
				// `ensureLuminance()` claims `lumState.url` before the decode
				// finishes, so a re-solve landing mid-decode would otherwise pair
				// the NEW wallpaper's remembered hue with the PREVIOUS artwork's
				// pixels and paint the wrong text against both.
				if (!cells && lumState.sampleUrl !== null && lumState.sampleUrl !== currentWallpaperUrl()) return;
				const dimFactor = 1 - clamp(state.wallpaper.dim, 0, 1) * 0.85;
				const dimmed = new Float32Array(raw.length);
				for (let i = 0; i < raw.length; i += 1) dimmed[i] = raw[i] < 0 ? -1 : raw[i] * dimFactor;
				const alpha = clamp(state.wallpaper.opacity, 0, 1);
				const res = computeReadability(dimmed, alpha);
				// Same boost the renderer will use, gated the same way: with the
				// readability guard off the surface is never lifted, so solving
				// against a lifted alpha would tune for a backdrop that never
				// appears.
				const boost = state.ui.readability && res
					? Math.min(neededBacking(dimmed, targetScheme(res.scheme)), BOOST_CAP)
					: null;
				const painted = backingAlpha(alpha, boost);
				let hue = typeof hueHint === "number" && isFinite(hueHint) ? hueHint : null;
				if (hueHint === undefined) {
					const seed = tuneSeedFor(lumState.sampleUrl);
					hue = seed ? seed.hue : null;
				}
				if (!paintMarks(dimmed, painted, hue)) return;
				// The values no longer match any named preset, and the set is the
				// plugin's own output from here on, so a later boot may recompute it
				// instead of leaving a stale copy behind.
				state.marks.preset = "";
				state.ui.marksAuto = true;
				applyMarkStyle();
				syncPanel();
				scheduleSave();
			} catch (error) {
				diagReport("boot-marks-throw", String((error && error.message) || error));
			}
		}

		// ── auto tune ──────────────────────────────────────────────────────
		//
		// One-shot optimisation for a NEWLY CHOSEN wallpaper: sample once, then
		// write the best-fit values into the persisted state (text scheme, backing
		// opacity, interface palette, fit). The three engines above only ever
		// affect rendering at runtime — they never touch the user's slider values —
		// so without this a new wallpaper inherits the previous one's hand-tuned
		// settings. Deliberately NOT re-run on every change: that would overwrite
		// manual adjustments while the user is dragging sliders.

		/**
		 * Choose a fit from the artwork's aspect ratio. The goal is "as little
		 * crop as possible": a source close to the window's shape can simply cover,
		 * while a very tall/wide one is letterboxed so the subject survives.
		 */
		function bestFit(width, height) {
			if (!width || !height) return "cover";
			const art = width / height;
			const view = (typeof window !== "undefined" ? window.innerWidth : 16) /
				(typeof window !== "undefined" ? window.innerHeight : 9);
			const drift = Math.max(art, view) / Math.min(art, view);
			// Close enough to fill the screen outright; anything further off is
			// letterboxed so the subject survives instead of being cropped away.
			return drift <= 1.25 ? "cover" : "contain";
		}

		/**
		 * Sample a source and report, for BOTH candidate schemes, the backing
		 * alpha each would need. Reporting both is deliberate: the scheme that
		 * actually renders is decided by `ui.contrast` (the user's own light/dark
		 * preference), which is NOT necessarily the one the sampler likes best —
		 * and computing the alpha for the wrong scheme yields a value that does
		 * not correspond to what is on screen.
		 *
		 * Resolves `{ light, dark, width, height }`, or null when the artwork
		 * cannot be read (cross-origin, decode failure).
		 */
		function tuneProbe(url, kind) {
			return new Promise((resolve) => {
				let done = false;
				const finish = (v) => { if (!done) { done = true; resolve(v); } };
				// Bounded: an unreadable source must not leave the tune pending.
				const bail = setTimeout(() => finish(null), 12000);
				const settle = (v) => { clearTimeout(bail); finish(v); };
				const read = (source, w, h) => {
					try {
						const cells = sampleGrid(source);
						if (!cells) return settle(null);
						// Mean luminance decides exactly one thing downstream: whether
						// the artwork is dark enough to warrant the 深底浅字 surface. It
						// is never used to flip a light artwork to 浅底深字 (see autoTune).
						let sum = 0;
						let n = 0;
						for (let i = 0; i < cells.length; i += 1) {
							if (cells[i] < 0) continue;
							sum += cells[i];
							n += 1;
						}
						// The palette rides on the SAME decode: a second drawImage of
						// an already-decoded frame is one small readback, not another
						// download/decode. Having the hue here is what lets the tint be
						// seeded straight from the tune, instead of waiting for the live
						// wallpaper element to mount — a window ensureTint() can miss
						// entirely (the silent "tint-hue: none" failure).
						const acc = { bins: new Map(), total: 0 };
						paletteFeed(acc, source);
						const pal = paletteHue(acc);
						// The grid travels with the summary too: the mark-colour stage
						// needs the *worst* tile, not just the average, and
						// re-sampling the same frame for it would cost a second
						// decode.
						settle({
							mean: n > 0 ? sum / n : null,
							width: w,
							height: h,
							cells: cells,
							hue: pal ? pal.hue : null,
							sat: pal ? pal.sat : 0
						});
					} catch {
						settle(null);
					}
				};
				try {
					if (kind === "video") {
						const v = document.createElement("video");
						v.muted = true;
						v.preload = "auto";
						v.addEventListener("loadeddata", () => {
							read(v, v.videoWidth, v.videoHeight);
							try { v.removeAttribute("src"); v.load(); } catch { /* ignore */ }
						}, { once: true });
						v.addEventListener("error", () => settle(null), { once: true });
						v.src = url;
					} else {
						const img = new Image();
						img.referrerPolicy = "no-referrer";
						img.onload = () => read(img, img.naturalWidth, img.naturalHeight);
						img.onerror = () => settle(null);
						img.src = url;
					}
				} catch {
					settle(null);
				}
			});
		}

		/**
		 * Apply the optimal configuration for `url`. Called at the moment a
		 * wallpaper is chosen (URL field, file pick, drop, library 应用, chip).
		 * Returns the scheme it tuned for, or null when unreadable.
		 *
		 * NOT driven from commit(): rotation and host-restore also reassign
		 * `wallpaper.url`, and tuning on those would overwrite the user's manual
		 * settings on every carousel tick and on every launch.
		 *
		 * IMPORTANT — the surface scheme is derived, but ASYMMETRICALLY: a dark
		 * artwork may switch the app to 深底浅字, a bright one never switches it
		 * to 浅底深字. That asymmetry is what prevents the all-white regression:
		 * `contrast: "light"` paints BASE_LIGHT (#ffffff) behind EVERYTHING, so
		 * deriving it from a white line-art wallpaper turned the whole app white.
		 * Bright artwork therefore only ever gets the per-wallpaper treatments
		 * (fit, tint, mark colours); app-wide light/dark stays the user's call.
		 */
		async function autoTune(url) {
			const clean = typeof url === "string" ? url.trim() : "";
			if (clean === "" || !isSafeWallpaperUrl(clean)) return null;
			const kind = resolveKind(clean, state.wallpaper.kind);
			const probe = await tuneProbe(clean, kind).catch(() => null);
			if (!probe) return null;
			// The state may have moved on while sampling (user picked another one).
			if (state.wallpaper.url.trim() !== clean) return null;

			const wp = state.wallpaper;
			// Sample the artwork the way the renderer will see it: the CSS
			// `brightness()` dim filter is invisible to drawImage, and the
			// readability guard lifts the backing surface at render time, so both
			// are folded in here ONCE and shared by the scheme choice and the mark
			// derivation below. Tuning against the raw slider values would solve
			// for a surface that never reaches the screen.
			const dimFactor = 1 - clamp(wp.dim, 0, 1) * 0.85;
			const userAlpha = clamp(wp.opacity, 0, 1);
			const dimmed = probe.cells ? new Float32Array(probe.cells.length) : null;
			if (dimmed) {
				for (let i = 0; i < probe.cells.length; i += 1) {
					dimmed[i] = probe.cells[i] < 0 ? -1 : probe.cells[i] * dimFactor;
				}
			}
			const solved = dimmed ? computeReadability(dimmed, userAlpha) : null;
			// 1. Fit — minimise cropping for this artwork's aspect ratio.
			wp.fit = bestFit(probe.width, probe.height);
			// 2. Surface scheme — ASYMMETRIC on purpose:
			//    • a DARK artwork switches the surface to 深底浅字, which is what
			//      dark art actually reads best against;
			//    • a BRIGHT artwork leaves the choice alone (stays 跟随主题).
			//    The asymmetry is what prevents the earlier all-white regression:
			//    浅底深字 paints #ffffff behind the entire app, so it is never
			//    *derived* — only ever reached by the user picking it by hand.
			//
			//    The mean test alone is too blunt to switch the surface, though.
			//    A mid-dark artwork at a low backing opacity can score far WORSE
			//    under 深底浅字 than under 浅底深字 — measured on this corpus the
			//    solver prefers light by roughly 3x (worst 3.6:1 vs ~1.2:1) while
			//    `mean < 0.5` still says "dark", so the old test switched the
			//    surface to the measurably worse of the two. Gate the switch on the
			//    solver agreeing. Note what this does NOT do: it never derives
			//    "light", so the all-white regression stays impossible — a
			//    disagreeing solver only means the surface falls back to 跟随主题.
			const darkEnough = probe.mean !== null && probe.mean < 0.5;
			const darkAgreed = !solved || solved.scheme === "dark";
			const switchToDark = darkEnough && darkAgreed;
			if (switchToDark) state.ui.contrast = "dark";
			else if (state.ui.contrast === "dark" && state.ui.contrastFromTune === true) {
				// Was set by a previous dark artwork; let it fall back to theme.
				state.ui.contrast = "theme";
			}
			state.ui.contrastFromTune = switchToDark;
			// 3. Remember what this decode learned, so the tint never has to wait
			//    for the live wallpaper element to mount. Note what is NOT done
			//    here: `ui.autotint` is left exactly as the user set it. It is a
			//    whole-interface palette switch, and forcing it back on at every
			//    pick would make opting out impossible — the same failure as the
			//    readability guard below, one field over.
			tuneCache = { url: clean, hue: probe.hue, sat: probe.sat };
			// Also PERSIST what that decode measured. `tuneCache` is module state
			// and dies with the page, but `ensureTint()` only gives the live
			// element ~1.5s to reach a readable frame before it concludes the
			// artwork has no dominant hue — so on the next launch, with nothing
			// decoded yet, the tint used to fail silently ("tint-hue: none") even
			// for artwork whose hue had already been measured right here.
			const measured = typeof probe.hue === "number" && isFinite(probe.hue);
			state.ui.tuneHue = measured ? probe.hue : null;
			state.ui.tuneSat = measured ? clamp(probe.sat || 0, 0, 1) : null;
			// The URL records that this artwork WAS measured, not that a colour
			// survived the measurement: greyscale art (hue null) is still a finished
			// answer, and storing "" for it would send the next launch back to the
			// live-element branch to re-derive the same "no dominant hue" the slow
			// way.
			state.ui.tuneHueUrl = clean;
			// 4. Mark colours — solve the six text tones against this artwork's
			//    own worst tile. This is the "最清晰的字体颜色" half of the
			//    feature; before it existed the marks were a static preset that
			//    auto-tune never touched.
			//
			//    The solving itself lives in `repaintMarks()` so this path and the
			//    boot path cannot drift apart. It re-derives the dim/alpha/boost
			//    chain from the state instead of taking them as arguments, which is
			//    also why nothing here hands it its local `painted`.
			//
			//    The permission flag is granted BEFORE the solve, not after: picking
			//    an artwork is an explicit request to tune it, so this path must
			//    override a `marksAuto: false` left behind by a hand edit or a
			//    preset choice. Granting it afterwards would be too late —
			//    `repaintMarks()` gates on the flag and would refuse to run.
			if (state.ui.tuneMarks !== false && dimmed) {
				state.ui.marksAuto = true;
				repaintMarks(probe.cells, probe.hue);
			}
			// 5. Persist.
			//
			//    NOTE — this deliberately does NOT write either knob that governs
			//    the backing layer, and it deliberately does NOT write
			//    `ui.readability`:
			//
			//    • `wallpaper.opacity` — the needed-backing figure is a RUNTIME
			//      safety margin (applied as `lumState.boost` while rendering) and
			//      is frequently very high: a dark surface over a bright frame can
			//      demand ~0.9, which as a PERSISTED opacity buries the wallpaper
			//      entirely — the "background is gone" failure.
			//    • `ui.readability` — that checkbox is the user's own switch for
			//      whether the guard may touch their backing layer at all. Forcing
			//      it back on every time they pick a wallpaper made the opt-out
			//      impossible to keep: they turned the guard off to take control of
			//      their own background layer, and the next pick silently took it
			//      back (the "背景层调不了" report). A fresh install already defaults
			//      it to on, so nothing is lost by leaving the choice alone here.
			commit();
			return resolveScheme();
		}

		function commitSample(cells) {
			lumState.ready = true;
			if (!cells) {
				lumState.scheme = null;
				lumState.worst = null;
				lumState.mean = null;
				lumState.boost = null;
				lumState.cells = null;
				lumState.sampleUrl = null;
				applyTokens();
				return;
			}
			// The CSS `brightness()` dim filter is invisible to drawImage, so fold
			// it into the sample before scoring.
			const dimFactor = 1 - clamp(state.wallpaper.dim, 0, 1) * 0.85;
			const dimmed = new Float32Array(cells.length);
			for (let i = 0; i < cells.length; i += 1) dimmed[i] = cells[i] < 0 ? -1 : cells[i] * dimFactor;
			const alpha = clamp(state.wallpaper.opacity, 0, 1);
			const res = computeReadability(dimmed, alpha);
			if (!res) {
				lumState.scheme = null;
				lumState.worst = null;
				lumState.mean = null;
				lumState.boost = null;
			} else {
				lumState.scheme = res.scheme;
				lumState.worst = res.worst;
				lumState.mean = res.mean;
				lumState.boost = state.ui.readability ? Math.min(neededBacking(dimmed, targetScheme(res.scheme)), BOOST_CAP) : null;
			}
			// Retain the RAW sample (undimmed): the host restore lands AFTER boot,
			// and by then `ensureLuminance()` has already claimed this URL, so its
			// same-URL guard will not sample again. Keeping the pixels lets that
			// later pass re-solve the marks against the artwork already on screen.
			// Raw rather than `dimmed` so the re-solve can apply whatever dim value
			// is in force at THAT moment instead of folding it in twice.
			lumState.cells = cells;
			lumState.sampleUrl = lumState.url;
			applyTokens();
			updateReadout();
			// Re-derive the mark colours for the artwork that is actually on
			// screen. Without this the derivation only ever existed between a pick
			// and the next restart: every launch reset the text to whatever preset
			// the state file happened to hold, over the wallpaper it was no longer
			// solved for. Gated on `ui.marksAuto` so a hand-edited set survives —
			// see marksDerivable().
			repaintMarks();
		}

		function ensureLuminance() {
			const wp = state.wallpaper;
			const url = typeof wp.url === "string" ? wp.url.trim() : "";
			if (!wp.enabled || (url === "" && !gradientSpec())) {
				stopLumWatch();
				lumState.url = "";
				lumState.ready = false;
				lumState.scheme = null;
				lumState.worst = null;
				lumState.mean = null;
				lumState.boost = null;
				return;
			}
			if (url === lumState.url) return;
			stopLumWatch();
			lumState.url = url;
			lumState.ready = false;
			lumState.scheme = null;
			lumState.worst = null;
			lumState.mean = null;
			lumState.boost = null;
			const my = ++lumState.token;
			const done = (cells) => {
				if (my !== lumState.token) return;
				commitSample(cells);
			};
			if (isVideoUrl(url)) {
				// The <video> is created by applyWallpaper(); wait for it (and for
				// its first frame) before grabbing pixels, then keep re-sampling
				// because the frame keeps changing.
				const tryVideo = (attempt) => {
					if (my !== lumState.token) return;
					const el = document.getElementById(WALLPAPER_ID);
					if (!el || el.tagName !== "VIDEO") {
						if (attempt < 6) setTimeout(() => tryVideo(attempt + 1), 250);
						else done(null);
						return;
					}
					const grab = () => {
						if (my !== lumState.token) return;
						done(sampleGrid(el));
					};
					if (el.readyState >= 2 && el.videoWidth) grab();
					else el.addEventListener("loadeddata", grab, { once: true });
					if (!lumTimer && luminanceMatters()) lumTimer = setInterval(() => {
						if (my !== lumState.token) { stopLumWatch(); return; }
						// No point reading frames the user cannot see. This used to
						// check only document.hidden, so a window that was merely
						// covered by a maximised app kept forcing a GPU->CPU read
						// back every 8 s; occlusionPaused() covers both cases.
						if (occlusionPaused()) return;
						const node = document.getElementById(WALLPAPER_ID);
						if (node && node.tagName === "VIDEO" && node.readyState >= 2 && node.videoWidth) {
							done(sampleGrid(node));
						}
					}, 8000);
				};
				tryVideo(0);
			} else {
				const img = new Image();
				img.referrerPolicy = "no-referrer";
				img.onload = () => done(sampleGrid(img));
				img.onerror = () => done(null);
				img.src = url;
			}
		}

		/**
		 * The app-wide scheme that will actually be PAINTED, given whatever the
		 * sampler solved for. Every consumer (paint, readability boost, read-out)
		 * goes through this one function so they can never disagree about which
		 * base is on screen.
		 */
		function targetScheme(solved) {
			const mode = state.ui && state.ui.contrast ? state.ui.contrast : "theme";
			if (mode === "light") return "light";
			if (mode === "dark") return "dark";
			if (mode === "auto") {
				// ASYMMETRIC on purpose — the same rule autoTune() already follows:
				// a dark artwork may pull the app to 深底浅字, a bright one must never
				// flip it to 浅底深字. "light" paints BASE_LIGHT (#ffffff) behind
				// EVERYTHING, so deriving it from a bright wallpaper turned the whole
				// window into a white sheet. Bright artwork only ever gets the
				// per-wallpaper treatments (fit / tint / mark colours); app-wide
				// light-or-dark stays the user's call, not the artwork's.
				//
				// Never derive "light" here. Never read lumState.mean either: it is the
				// mean CONTRAST RATIO of the sample (scoreScheme's sum/n), not a
				// brightness — comparing it against 0.5 was a unit mix-up that made
				// mid-tone wallpaper read as "bright".
				if (solved === "dark") return "dark";
			}
			return isDarkTheme() ? "dark" : "light";
		}

		/** Resolve the panel scheme: "light" (dark text) or "dark" (light text). */
		function resolveScheme() {
			return targetScheme(lumState.scheme);
		}

		/** Refresh the panel's readability read-out from the last sample. */
		function updateReadout() {
			try {
				const el = panelRefs && panelRefs.readback;
				if (!el) return;
				const url = state.wallpaper && typeof state.wallpaper.url === "string" ? state.wallpaper.url.trim() : "";
				if (!state.wallpaper.enabled || (url === "" && !gradientSpec())) { el.textContent = "未设置壁纸"; return; }
				// 渐变不需要采样（色标是我们自己给定的，没有"不可读画面"这回事），
				// 所以这里直接给结论，而不是让它永远停在「分析中…」—— 那正是
				// 取色功能历史上最误导人的一种状态。
				const spec = gradientSpec();
				if (spec) {
					const drifting = state.ui.drift === true ? " · 漂移中" : "";
					el.textContent = `渐变「${spec.label}」${drifting} · 色标由预设给定，无需采样`;
					return;
				}
				if (lumState.url !== url || lumState.worst === null) { el.textContent = "分析中…"; return; }
				// The solver's own pick, then whether the app is actually ALLOWED to
				// take it. 浅底深字 measured as the higher-contrast option on a bright
				// artwork is real, but resolveScheme() refuses to derive it (see the
				// asymmetry note there) — so quoting "建议 浅底深字" and then painting
				// the dark scheme reads as a bug in the read-out. Say which one is
				// live instead, and why when the pick was overruled.
				const mode = state.ui && state.ui.contrast ? state.ui.contrast : "theme";
				const pick = lumState.scheme === "light" ? "浅底深字" : "深底浅字";
				const overruled = mode === "auto" && lumState.scheme === "light";
				let text = overruled
					? `采样建议 ${pick} · 最差对比 ${lumState.worst.toFixed(1)}:1 · 亮壁纸不自动转浅底（会把界面刷白），仍用深底`
					: `采样建议 ${pick} · 最差对比 ${lumState.worst.toFixed(1)}:1`;
				if (state.ui.readability && lumState.boost !== null) {
					// Show what is actually painted, plus how much of it the guard
					// added — otherwise a read-out quoting the raw requirement looks
					// like it ignores the user's own slider setting.
					const user = clamp(state.wallpaper.opacity, 0, 1);
					const userPct = Math.round(user * 100);
					const shown = Math.round(backingAlpha(user, lumState.boost) * 100);
					text += ` · 底板 ${shown}%`;
					if (shown > userPct) text += `（自动 +${shown - userPct}）`;
				}
				el.textContent = text;
			} catch { /* panel not built yet */ }
		}

		// ── auto-tint: wallpaper-derived colour scale ──────────────────────
		//
		// DSH declares a set of static colour scales on `body`, and every
		// semantic alias is derived from them with `var()`. Re-pointing those
		// scales is therefore enough to move the whole UI surface — no selector
		// chasing. We touch only the neutral + neutral-bluish greys (surfaces
		// and text). The status scales (red/green/amber/blue) carry meaning and
		// the brand accent already has its own control, so both are left alone.
		//
		// The key property is that each step keeps its ORIGINAL LIGHTNESS and
		// swaps only the hue: the existing contrast relationships then survive
		// by construction. Dark mode re-declares the same scales with different
		// values, so the live value is always read back at runtime.
		const TINT_TOKENS = [
			"--dsw-static-neutral-00", "--dsw-static-neutral-50", "--dsw-static-neutral-100",
			"--dsw-static-neutral-150", "--dsw-static-neutral-200", "--dsw-static-neutral-250",
			"--dsw-static-neutral-300", "--dsw-static-neutral-400", "--dsw-static-neutral-500",
			"--dsw-static-neutral-550", "--dsw-static-neutral-600", "--dsw-static-neutral-700",
			"--dsw-static-neutral-800", "--dsw-static-neutral-850", "--dsw-static-neutral-900",
			"--dsw-static-neutral-1000",
			"--dsw-static-neutral-bluish-00", "--dsw-static-neutral-bluish-50", "--dsw-static-neutral-bluish-60",
			"--dsw-static-neutral-bluish-75", "--dsw-static-neutral-bluish-100", "--dsw-static-neutral-bluish-150",
			"--dsw-static-neutral-bluish-200", "--dsw-static-neutral-bluish-300", "--dsw-static-neutral-bluish-400",
			"--dsw-static-neutral-bluish-500", "--dsw-static-neutral-bluish-600", "--dsw-static-neutral-bluish-700",
			"--dsw-static-neutral-bluish-750", "--dsw-static-neutral-bluish-800", "--dsw-static-neutral-bluish-850",
			"--dsw-static-neutral-bluish-875", "--dsw-static-neutral-bluish-900", "--dsw-static-neutral-bluish-950",
			"--dsw-static-neutral-bluish-1000"
		];
		// Sample the artwork at 160px on its long edge. image-skin's comment is
		// the reason for not going coarser: at 64px a sky/cloud/person frame
		// collapses into two flat blues and the derived hue is wrong.
		const PALETTE_WIDTH = 160;

		const tintState = {
			url: "", active: false, ready: false, hue: null, sat: 0,
			appliedHue: null, appliedDark: null, token: 0
		};
		let tintCanvas = null;

		function tintClear() {
			const body = document.body;
			if (!body) return;
			for (const token of TINT_TOKENS) body.style.removeProperty(token);
		}

		function tintReset() {
			tintState.active = false;
			tintState.ready = false;
			tintState.url = "";
			tintState.hue = null;
			tintState.sat = 0;
			tintState.appliedHue = null;
			tintState.appliedDark = null;
			tintState.token += 1;
			tintClear();
		}

		/** Parse a computed colour (`#rgb`, `#rrggbb`, `rgb[a](...)`) to 0..255. */
		function parseCssColor(str) {
			if (typeof str !== "string") return null;
			const s = str.trim();
			if (s === "") return null;
			let m = /^#([0-9a-f]{6})$/i.exec(s);
			if (m) {
				const h = m[1];
				return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
			}
			m = /^#([0-9a-f]{3})$/i.exec(s);
			if (m) {
				const h = m[1];
				return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
			}
			m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
			if (m) return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]) };
			return null;
		}

		/** RGB (0..255) → { h: 0..360, s: 0..1, l: 0..1 }. */
		function rgbToHsl(r, g, b) {
			const rn = r / 255;
			const gn = g / 255;
			const bn = b / 255;
			const max = Math.max(rn, gn, bn);
			const min = Math.min(rn, gn, bn);
			const l = (max + min) / 2;
			let h = 0;
			let s = 0;
			if (max !== min) {
				const d = max - min;
				s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
				if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
				else if (max === gn) h = (bn - rn) / d + 2;
				else h = (rn - gn) / d + 4;
				h *= 60;
			}
			return { h, s, l };
		}

		/** HSL → [r, g, b] in 0..255. */
		function hslToRgb(h, s, l) {
			const hn = (((h % 360) + 360) % 360) / 360;
			const sn = clamp(s, 0, 1);
			const ln = clamp(l, 0, 1);
			if (sn === 0) {
				const v = Math.round(ln * 255);
				return [v, v, v];
			}
			const hue2rgb = (p, q, t) => {
				let tt = t;
				if (tt < 0) tt += 1;
				if (tt > 1) tt -= 1;
				if (tt < 1 / 6) return p + (q - p) * 6 * tt;
				if (tt < 1 / 2) return q;
				if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
				return p;
			};
			const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
			const p = 2 * ln - q;
			return [
				Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
				Math.round(hue2rgb(p, q, hn) * 255),
				Math.round(hue2rgb(p, q, hn - 1 / 3) * 255)
			];
		}

		/** sRGB relative luminance (0..1) for 0..255 channels. */
		function rgbLum(r, g, b) {
			const lin = (c) => {
				const v = c / 255;
				return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
			};
			return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
		}

		function rgbHex(r, g, b) {
			const p = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
			return "#" + p(r) + p(g) + p(b);
		}

		/**
		 * Same-hue colour at a chosen chroma whose relative luminance matches
		 * `target`. Luminance is monotonic in HSL lightness, so a binary search
		 * restores the original step's luminance exactly and no contrast is lost.
		 */
		function tintSameLuminance(hue, chroma, target) {
			let lo = 0;
			let hi = 1;
			for (let i = 0; i < 18; i += 1) {
				const mid = (lo + hi) / 2;
				const c = hslToRgb(hue, chroma, mid);
				if (rgbLum(c[0], c[1], c[2]) < target) lo = mid;
				else hi = mid;
			}
			return hslToRgb(hue, chroma, (lo + hi) / 2);
		}

		/** Fold one artwork frame into a 4-bit RGB histogram. */
		function paletteFeed(acc, source) {
			try {
				const sw = source.videoWidth || source.naturalWidth || source.width;
				const sh = source.videoHeight || source.naturalHeight || source.height;
				if (!sw || !sh) return;
				const w = PALETTE_WIDTH;
				const h = Math.max(1, Math.round(sh * (w / sw)));
				if (!tintCanvas) tintCanvas = document.createElement("canvas");
				tintCanvas.width = w;
				tintCanvas.height = h;
				const g = tintCanvas.getContext("2d", { willReadFrequently: true });
				if (!g) return;
				g.clearRect(0, 0, w, h);
				g.drawImage(source, 0, 0, w, h);
				const data = g.getImageData(0, 0, w, h).data;
				for (let i = 0; i < data.length; i += 4) {
					if (data[i + 3] < 200) continue;
					const r = data[i];
					const gg = data[i + 1];
					const b = data[i + 2];
					const key = ((r >> 4) << 8) | ((gg >> 4) << 4) | (b >> 4);
					let bin = acc.bins.get(key);
					if (!bin) { bin = { r: 0, g: 0, b: 0, n: 0 }; acc.bins.set(key, bin); }
					bin.r += r;
					bin.g += gg;
					bin.b += b;
					bin.n += 1;
					acc.total += 1;
				}
			} catch {
				/* tainted canvas (cross-origin artwork) — no tint */
			}
		}

		/**
		 * Reduce a histogram to a single hue. Directly painting four unrelated
		 * RGB values onto the scales reads as colour clash, so image-skin's
		 * design is followed: filter near-grey / rare bins, rank by
		 * area × vividness, then collapse the top bins to one energy-weighted
		 * circular-mean hue.
		 */
		function paletteHue(acc) {
			if (!acc || !acc.total) return null;
			const floor = Math.max(3, acc.total / 1200);
			const cands = [];
			for (const bin of acc.bins.values()) {
				if (bin.n < floor) continue;
				const r = bin.r / bin.n;
				const g = bin.g / bin.n;
				const b = bin.b / bin.n;
				const max = Math.max(r, g, b);
				const min = Math.min(r, g, b);
				if (max <= 0) continue;
				const sat = (max - min) / max;
				if (sat <= 0.1) continue;
				const lig = (max + min) / 510;
				const score = sat * Math.max(0.16, 1 - Math.abs(lig - 0.62) * 1.05);
				cands.push({ r, g, b, n: bin.n, sat, score });
			}
			if (!cands.length) return null;
			cands.sort((a, b) => b.n * (0.3 + b.score) - a.n * (0.3 + a.score));
			const top = cands.slice(0, 6);
			let sx = 0;
			let sy = 0;
			let wsum = 0;
			let satSum = 0;
			for (const c of top) {
				const { h } = rgbToHsl(c.r, c.g, c.b);
				const w = c.n * (0.3 + c.score);
				const rad = (h * Math.PI) / 180;
				sx += Math.cos(rad) * w;
				sy += Math.sin(rad) * w;
				satSum += c.sat * w;
				wsum += w;
			}
			if (wsum <= 0) return null;
			let hue = (Math.atan2(sy, sx) * 180) / Math.PI;
			if (hue < 0) hue += 360;
			return { hue, sat: satSum / wsum };
		}

		/** Write the tinted scales (or clear them) according to the current state. */
		function applyTint() {
			const body = document.body;
			if (!body) return;
			tintClear();
			if (state.ui.autotint !== true || tintState.hue === null) {
				tintState.appliedHue = null;
				tintState.appliedDark = null;
				return;
			}
			let cs;
			try { cs = getComputedStyle(body); } catch { return; }
			const dark = isDarkTheme();
			// Keep the chroma low so the result reads as a tinted grey rather
			// than a saturated colour; dark mode tolerates a little more.
			const chroma = clamp(0.035 + (dark ? 0.075 : 0.05) * clamp(tintState.sat, 0, 1), 0.035, 0.12);
			const bases = [];
			for (const token of TINT_TOKENS) {
				const rgb = parseCssColor(cs.getPropertyValue(token).trim());
				if (rgb) bases.push({ token, rgb });
			}
			for (const base of bases) {
				const target = rgbLum(base.rgb.r, base.rgb.g, base.rgb.b);
				const out = tintSameLuminance(tintState.hue, chroma, target);
				body.style.setProperty(base.token, rgbHex(out[0], out[1], out[2]));
			}
			tintState.appliedHue = tintState.hue;
			tintState.appliedDark = dark;
		}

		function updateTintReadout() {
			try {
				const el = panelRefs && panelRefs.tintReadback;
				if (!el) return;
				if (state.ui.autotint !== true) { el.textContent = "关闭时保持 DSH 原生配色"; return; }
				if (tintState.hue !== null) {
					el.textContent = `已从壁纸取色 · 色相 ${Math.round(tintState.hue)}°`;
					return;
				}
				// Distinguish "still working" from "finished and found nothing".
				// The read-out used to say 分析中… in both cases, so a source the
				// sampler can never read (no dominant hue, or a frame it never
				// managed to grab) looked like it was loading forever and the user
				// had no way to tell the feature had silently failed.
				if (tintState.ready) { el.textContent = "这张取不到主色，界面保持原生配色"; return; }
				el.textContent = "分析中…";
			} catch { /* panel not built yet */ }
		}

		/** Sample the wallpaper once per URL and derive the tint hue. */
		function ensureTint() {
			const wp = state.wallpaper;
			const url = typeof wp.url === "string" ? wp.url.trim() : "";
			const active = state.ui.autotint === true && wp.enabled !== false && (url !== "" || gradientSpec() !== null);
			if (!active) {
				if (tintState.active || tintState.appliedHue !== null) tintReset();
				return;
			}
			if (url === tintState.url) {
				const dark = isDarkTheme();
				if (tintState.ready && (tintState.appliedHue !== tintState.hue || tintState.appliedDark !== dark)) applyTint();
				return;
			}
			// A tune already decoded this exact artwork, so its hue is known
			// without touching the live element at all. This matters most for
			// video: the branch below has to wait for the wallpaper <video> to
			// mount and gives up after ~1.5s, which is how the tint used to fail
			// silently whenever the element was late (or the URL was an inline
			// data: video, mounted later still).
			//
			// Two sources, because the decode only happens in one session: the
			// in-memory cache from a tune run a moment ago, and the PERSISTED
			// measurement from a tune run before the last restart. Without the
			// second one every launch fell through to the live-element branch and
			// reported "none" for artwork whose colour was already known.
			const cached = tuneCache && tuneCache.url === url ? tuneCache : null;
			const seed = cached || tuneSeedFor(url);
			if (seed) {
				tintReset();
				tintState.active = true;
				tintState.url = url;
				tintState.token += 1;
				tintState.ready = true;
				if (typeof seed.hue === "number" && isFinite(seed.hue)) {
					tintState.hue = seed.hue;
					tintState.sat = seed.sat || 0;
				}
				applyTint();
				updateTintReadout();
				diagReport("tint-hue", tintState.hue === null ? "none" : Math.round(tintState.hue) + "° sat=" + tintState.sat.toFixed(2) + (cached ? " (tuned)" : " (remembered)"), "tintDiag");
				return;
			}
			// New artwork — drop the old result and re-sample.
			tintReset();
			tintState.active = true;
			tintState.url = url;
			const my = ++tintState.token;
			const acc = { bins: new Map(), total: 0 };
			const finish = () => {
				if (my !== tintState.token) return;
				const res = paletteHue(acc);
				tintState.ready = true;
				if (res) { tintState.hue = res.hue; tintState.sat = res.sat; }
				applyTint();
				updateTintReadout();
				diagReport("tint-hue", res ? Math.round(res.hue) + "° sat=" + res.sat.toFixed(2) : "none", "tintDiag");
			};
			if (isVideoUrl(url)) {
				// Three frames spaced over ~3s approximate a still; the video is
				// playing anyway, so this adds no seeking cost. The mount window
				// below stays short on purpose — the video is usually already up,
				// so waiting longer would only delay the failure message.
				let taken = 0;
				let misses = 0;
				const step = () => {
					if (my !== tintState.token) return;
					const el = document.getElementById(WALLPAPER_ID);
					if (!el || el.tagName !== "VIDEO") {
						if (taken === 0 && misses < 6) { misses += 1; setTimeout(step, 250); return; }
						finish();
						return;
					}
					const grab = () => {
						if (my !== tintState.token) return;
						paletteFeed(acc, el);
						taken += 1;
						if (taken < 3) setTimeout(step, 1500);
						else finish();
					};
					if (el.readyState >= 2 && el.videoWidth) grab();
					else el.addEventListener("loadeddata", grab, { once: true });
				};
				step();
			} else {
				const img = new Image();
				img.referrerPolicy = "no-referrer";
				img.onload = () => { paletteFeed(acc, img); finish(); };
				img.onerror = () => finish();
				img.src = url;
			}
		}

		// Every token any theme may write. Switching themes (or going back to
		// 跟随原生) must clear the PREVIOUS theme's keys too, so the removal set
		// cannot be just the active theme's key list — a codex→native switch
		// would otherwise leave ~57 stale declarations on <body>.
		const UI_THEME_TOKENS = (() => {
			const set = new Set();
			for (const id of Object.keys(UI_THEMES)) {
				const tokens = UI_THEMES[id].tokens;
				if (!tokens) continue;
				for (const scheme of Object.keys(tokens)) {
					for (const key of Object.keys(tokens[scheme])) set.add(key);
				}
			}
			return Array.from(set);
		})();

		/** The active theme's token map for one scheme, or null for 跟随原生. */
		function themeMap(scheme) {
			const id = state.ui && typeof state.ui.theme === "string" ? state.ui.theme : "native";
			const theme = UI_THEMES[id] || UI_THEMES.native;
			if (!theme.tokens) return null;
			return theme.tokens[scheme] || null;
		}

		/**
		 * The opaque canvas the wallpaper wash composites over. A theme owns its
		 * own base, so washing a Codex dark canvas with the hardcoded light
		 * BASE_LIGHT at default opacity would flood the theme out of existence —
		 * the wash has to sit on the colour the theme actually paints.
		 */
		function themeBase(scheme) {
			const map = themeMap(scheme);
			const value = map ? map["--dsw-alias-bg-base"] : null;
			if (typeof value === "string" && value !== "") return value;
			return scheme === "light" ? BASE_LIGHT : BASE_DARK;
		}

		/**
		 * 某个内容令牌该拿什么颜色去摊透明度。
		 *
		 * 旧实现一律用 `themeBase()` 的单色底：于是主题里精心排好的
		 * 明度阶梯（bg-base → layer-1 → layer-2 → layer-3）在薄涂时被
		 * 抹成同一档灰 —— 主题只剩 branding 和边框可见，大面积底色
		 * 全是「同一个 base 乘不同 alpha」，眼睛分不出层次。实测
		 * 8% 画布下 native 与 midnight 的像素差只有 2–5/255。
		 *
		 * 现在优先取该令牌自己的主题色，没有才回落 base。这样薄涂时
		 * 每个面板仍带着自己的色相与明度，主题才「看得见」。
		 */
		function surfaceBaseFor(token, scheme) {
			const map = themeMap(scheme);
			const value = map ? map[token] : null;
			const base = typeof value === "string" && value !== "" ? value : themeBase(scheme);
			return themeTintFor(base, map, scheme);
		}

		/**
		 * 把主题的强调色按比例「染」进一个底色。
		 *
		 * 为什么光换令牌不够：令牌那条路是「主题色 × 画布 alpha」。用户把画布
		 * 不透明度拖到 0.08 时，`#161616` 与 `#282D33` 合成到同一帧上每通道
		 * 只差 1.4/255（真机实测三张截图 Δ=0）—— 乘法把色差压平了，主题里
		 * 那些刻意低饱和的深灰底无论怎么换，画面都不动。
		 *
		 * 试过的两条错路（都实测过，别再走）：
		 *   1. 全屏 layer + `mix-blend-mode:color`：color 只取色相不改明暗，
		 *      暗部画面上实测 Δ 0–0.2/255，等于没加。
		 *   2. 调大 alpha：那是用户直接掌握的量，动了就是替他改设置。
		 *
		 * 对的办法是在**基色**里就把强调色混进去 —— alpha 一个数都不碰，
		 * 换的只是「这个 rgba 的前三个数」。同帧实测（km-0121-tint.mjs，
		 * 画布 alpha 仍 0.08）：
		 *   纯主题深灰 `rgba(40,45,51,0.08)`  → 画布 Δ 0（看不见）
		 *   纯强调色   `rgba(143,167,227,0.08)` → 画布 Δ 17.8（一眼可见）
		 * 混合比例 k 实测（km-0121-mix.mjs，壁画纹理保持率）：
		 *   k=0.40 → Δ12.0 / 纹理 96%；k=0.55 → Δ16.7 / 95%；
		 *   k=0.70 → Δ19.7 / 94%（默认）；k=0.90 → Δ24.7 / 93%。
		 * 所以取 0.70：颜色明确变了，壁纸明暗纹理还剩 94%。
		 */
		function mixRgb(a, b, k) {
			const pa = parseRgbTriple(a);
			const pb = parseRgbTriple(b);
			if (!pa || !pb) return a;
			const t = clamp(k, 0, 1);
			const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
			const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
			const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
			return `rgb(${r}, ${g}, ${bl})`;
		}
		/** 取 `#rgb` / `#rrggbb` / `rgb()` / `rgba()` 的三元组；不认识返回 null。 */
		function parseRgbTriple(color) {
			if (typeof color !== "string") return null;
			const s = color.trim();
			let m = /^#([0-9a-f]{3})$/i.exec(s);
			if (m) {
				const h = m[1];
				return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
			}
			m = /^#([0-9a-f]{6})$/i.exec(s);
			if (m) {
				const h = m[1];
				return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
			}
			m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
			if (m) return [+m[1], +m[2], +m[3]];
			return null;
		}
		/**
		 * 一个基色该被染多少：`ui.themeInk` 是比例，强调色优先取用户自选的
		 * `state.accent`，其次取主题自己的 brand-primary。native 主题不染
		 * （它的 brand 就是宿主色，染了等于替用户改原生观感）。
		 */
		function themeTintFor(base, map, scheme) {
			const themeId = (state.ui && state.ui.theme) || "native";
			if (themeId === "native") return base;
			const ink = state.ui && isFinite(Number(state.ui.themeInk)) ? clamp(Number(state.ui.themeInk), 0, 1) : THEME_INK_DEFAULT;
			if (ink <= 0) return base;
			const accent = normalizeAccent(state.accent);
			const brand = accent !== "" ? accent : map && map["--dsw-alias-brand-primary"];
			if (typeof brand !== "string" || brand === "") return base;
			return mixRgb(base, brand, ink);
		}

		/**
		 * 有两个令牌族写 body 内联也**压不住**宿主：`--dsw-alias-label-*`。
		 * 实测（km-probe-prio.mjs）：64 个主题键里 60 个普通内联即生效，
		 * 只有 label-primary / -secondary / -tertiary / -caption 这 4 个
		 * 必须带 `!important` —— 文本色是宿主的视觉身份，它用一条更具体
		 * 或更晚的声明守着这四档，普通优先级的赋值会被静默丢弃。
		 * 因此主题与 restoreToken 对这四个键统一走 important。
		 */
		const IMPORTANT_LABEL_TOKENS = [
			"--dsw-alias-label-primary",
			"--dsw-alias-label-secondary",
			"--dsw-alias-label-tertiary",
			"--dsw-alias-label-dimmed",
			"--dsw-alias-label-caption"
		];
		function needsImportant(token) {
			return IMPORTANT_LABEL_TOKENS.indexOf(token) >= 0;
		}
		/** 写一个主题令牌；需要压住宿主的四档文本色走 `!important`。 */
		function setThemeToken(body, token, value) {
			if (needsImportant(token)) body.style.setProperty(token, value, "important");
			else body.style.setProperty(token, value);
		}

		/**
		 * Paint the whole-app palette. This is the BASE layer: it runs before the
		 * wallpaper wash, the transparency pass, the text override and the accent,
		 * all of which composite on top of it. Which scheme is painted follows the
		 * app itself (`data-ds-dark-theme`), not the wallpaper scheme — a theme is
		 * a property of the interface, not of the artwork.
		 */
		function applyUiTheme() {
			const body = document.body;
			if (!body) return;
			const map = themeMap(isDarkTheme() ? "dark" : "light");
			for (const token of UI_THEME_TOKENS) {
				const value = map ? map[token] : null;
				if (typeof value === "string" && value !== "") setThemeToken(body, token, value);
				else body.style.removeProperty(token);
			}
		}

		/**
		 * Put one token back the way the ACTIVE THEME wants it: the theme's own
		 * value if it defines one, otherwise genuinely unset so the native DSH
		 * declaration wins again. applyTokens() uses this instead of a bare
		 * removeProperty() — those tokens are exactly the ones a theme owns
		 * (label hierarchy, layer-1/-2/-3, overlay, code surfaces), so removing
		 * them would silently delete the palette's text colours and surfaces
		 * whenever the wallpaper was on.
		 */
		function restoreToken(token) {
			const body = document.body;
			if (!body) return;
			const map = themeMap(isDarkTheme() ? "dark" : "light");
			const value = map ? map[token] : null;
			if (typeof value === "string" && value !== "") setThemeToken(body, token, value);
			else body.style.removeProperty(token);
		}

		/**
		 * Drop the wash and fall back to the base palette (theme, or native).
		 */
		function clearTokens() {
			applyUiTheme();
		}

		/** Strip every declaration this plugin may have written (unmount path). */
		function removeAllTokens() {
			const body = document.body;
			if (!body) return;
			syncSpreadSurface(false);
			// 铺开层专用的私有副本也要一起清：它们只在铺开时装了
			// `SPREAD_CSS` 才有读者，留着就是 body 上一份无人消费的声明，
			// 而且下次切换主题时会被误当成「已经算好的底色」。
			body.style.removeProperty(SPREAD_SIDE_VAR);
			body.style.removeProperty(SPREAD_CANVAS_VAR);
			for (const token of UI_THEME_TOKENS) body.style.removeProperty(token);
			body.style.removeProperty(TOKEN_BG);
			body.style.removeProperty(TOKEN_SIDE);
			for (const token of CONTENT_TOKENS) body.style.removeProperty(token);
			for (const token of LABEL_TOKENS) body.style.removeProperty(token);
			for (const token of ACCENT_TOKENS) body.style.removeProperty(token);
			body.style.removeProperty("--dsw-alias-label-primary-foreground");
			body.style.removeProperty("--dsw-alias-label-primary-inverted");
			const fgEl = document.getElementById(PRIMARY_FG_STYLE_ID);
			if (fgEl) fgEl.remove();
		}

		/**
		 * 某个内容令牌属于哪一组「分部位透明度」，返回该组的系数（0.2–1）。
		 * 没有归属的令牌恒为 1（原样），因此新增令牌不需要同步改这里。
		 */
		function surfaceScaleFor(token) {
			for (const group of SURFACE_GROUPS) {
				if (group.tokens.indexOf(token) >= 0) {
					const v = state.ui && state.ui.surfaces ? state.ui.surfaces[group.id] : SURFACE_SCALE_DEFAULT;
					return isFinite(Number(v)) ? clamp(v, SURFACE_SCALE_MIN, 1) : SURFACE_SCALE_DEFAULT;
				}
			}
			return SURFACE_SCALE_DEFAULT;
		}

		function applyTokens() {
			const body = document.body;
			if (!body) return;			const wp = state.wallpaper;
			const url = typeof wp.url === "string" ? wp.url.trim() : "";
			// 判定必须与 syncWallpaperMark() 用同一套条件：那边要求 url 通过
			// isSafeWallpaperUrl 才盖壁纸标记，那边不成立时美术层本身也不会
			// 绘制。如果这里只看 `url !== ""`，就会把外框扒成透明却没有任何
			// 东西垫底 —— 用户看到的是桌面。
			const hasArt = wp.enabled && (gradientSpec() !== null || (url !== "" && isSafeWallpaperUrl(url)));
			if (!wp.enabled || (url === "" && !gradientSpec())) {
				syncSpreadSurface(false);
				clearTokens();
				return;
			}
			const scheme = resolveScheme();
			// 每个面用自己的主题色去摊透明度，而不是全窗共用一个 base
			// （见 surfaceBaseFor 的注释：单色摊薄会把明度阶梯抹平，
			// 主题只剩强调色可见）。下面三个是画布、侧栏、卡片/输入卡
			// 各自的基色；无主题值时各自回落 themeBase。
			const canvasBase = surfaceBaseFor(TOKEN_BG, scheme);
			const sideBase = surfaceBaseFor(TOKEN_SIDE, scheme);
			const cardBase = surfaceBaseFor("--dsw-alias-bg-layer-2", scheme);
			// When "readability" is on, the sampler may have measured that the
			// chosen scheme can't hold WCAG AA over the busiest tile; the guard then
			// tops the backing surface up a little so dense text stays legible.
			// The law lives in backingAlpha() — one source of truth shared with the
			// panel read-out. Its guarantees, and why each is load-bearing:
			//
			//   • strictly monotone in the user's setting — every move of the
			//     handle changes the screen (the guard used to impose a FLOOR,
			//     `max(value, 0.45)`, which silently swallowed everything below it);
			//   • additive only — a user value above the recommendation is never
			//     pulled down by the guard;
			//   • ramped in with the user's own value — no cliff just above zero;
			//   • never reaches `min(lumState.boost, READABILITY_ALPHA_MAX)`, so a
			//     wallpaper needing nothing gets nothing and a bright frame never
			//     erases the artwork it sits behind.
			//
			// An explicit opacity of 0 means "no backing surface at all": the
			// wallpaper must stay unobstructed, so the guard stands down. Without
			// this, a dark video frame lets the guard push an almost-opaque dark
			// base (#161616 at up to BOOST_CAP) over the wallpaper, which reads as
			// a periodic black-out on every 4s re-sample.
			let alpha = clamp(wp.opacity, 0, 1);
			if (state.ui.readability && alpha > 0 && lumState.boost !== null && lumState.url === url) {
				alpha = backingAlpha(alpha, lumState.boost);
			}
			// Navigation stays legible even when the frame alpha is very low —
			// SIDEBAR_FLOOR sits next to CONTENT_FLOOR for the same reason.
			// 铺开模式下侧栏走另一条地板：0.55 的下限意味着壁纸最多透 45%，
			// 视觉上仍是毛玻璃，而用户要的是「侧栏也有皮肤」。0.20 仍然抬
			// 在画布之上（侧栏永远比画布实一点），导航文字保得住。
			// 系统的「降低透明度」不再一票否决铺开：用户在那个 checkbox 上
			// 表达过明确意愿，系统偏好只是默认值。它现在的角色是把地板抬
			// 高一档（见 SOFTENED_FLOOR），而不是让整层消失 —— 后者会让
			// 用户看到「开关开着但什么都不变」，那是更难自查的坏。
			const reducedA11y = prefersReducedTransparency();
			const spread = state.ui && state.ui.spread === true;
			// 结构性容器层在这里落地：只有「铺开 + 确有素材」两个条件同时
			// 成立才扒外框。关掉铺开或素材被清除时必须同步拆掉，否则整窗
			// 会留着一个没有壁纸托底的透明壳（看到的是桌面）。
			syncSpreadSurface(spread && hasArt);
			// 地板强度：0 = 面板与画布完全同透。用户要「所有部分都透明」时，
			// 只有这一档能给出「面板不再比画布实」的结果 —— 地板（floor）与
			// 抬升（lift）是 panel 比 canvas 更实的仅有两个来源，两者都不
			// 随壁纸不透明度下降，所以必须能一起关掉。
			const floorScaleRaw = state.ui && isFinite(Number(state.ui.floorScale)) ? clamp(state.ui.floorScale, 0, 1) : 1;
			// 「降低透明度」时把地板抬到 SOFTENED_FLOOR。只是取最大值，
			// 用户已经把地板拖得更高时不动他；也绝不写回 state。
			const floorScale = reducedA11y ? Math.max(floorScaleRaw, SOFTENED_FLOOR) : floorScaleRaw;
			// floorScale = 0（用户主动取消地板）仍按「面板与画布同透」处理，
			// 但无障碍那一档不许把地板清成 0 —— 那是安全余量，不是设置。
			const fullClear = floorScale <= 0;
			const sideFloor = (spread ? SIDEBAR_FLOOR_SPREAD : SIDEBAR_FLOOR) * floorScale;
			// 铺开模式下侧栏只比画布实 3% —— 它的旧值 alpha + 0.1 在默认
			// 壁纸不透明度 0.55 时等于 0.65，比画布实 10%，视觉上就是「画布
			// 有皮肤、侧栏是毛玻璃」。铺开要的是整窗同一张皮肤，所以抬升
			// 压到 0.03：仍然严格高于画布（导航文字有一层薄托），但已经
			// 看不出接缝。地板 0.20 继续兜住 alpha 被拖到 0 的极端情况。
			const sideLift = (spread ? 0.03 : 0.1) * floorScale;
			const sideAlpha = Math.min(1, Math.max(alpha + sideLift, sideFloor));
			body.style.setProperty(TOKEN_BG, toRgba(canvasBase, alpha));
			body.style.setProperty(TOKEN_SIDE, toRgba(sideBase, sideAlpha));
			// 铺开层专用的私有副本（见 SPREAD_SIDE_VAR 的注释：公共令牌会被
			// dsh-claude-style 在元素级改写，这里必须是不可被第三方覆盖的值）。
			// 只在铺开时才写，关掉就清掉，免得 body 上留一份无人读取的声明。
			if (spread) {
				body.style.setProperty(SPREAD_SIDE_VAR, toRgba(sideBase, sideAlpha));
				body.style.setProperty(SPREAD_CANVAS_VAR, toRgba(canvasBase, alpha));
			} else {
				body.style.removeProperty(SPREAD_SIDE_VAR);
				body.style.removeProperty(SPREAD_CANVAS_VAR);
			}
			// 输入卡/dock 行的底色。不铺开时画布本身不透明，卡片也该不透明；
			// 铺开时**不能**跟着画布一起降到 8% —— 实测过这件事：
			//   卡片 alpha 0.08 → 卡内比卡外同高度的画布亮 92.7/85.6/85.7
			//   0.60 → 26.3/25.7/26.8   0.78 → 0.8/2.4/1.7   0.95 → -27.0/-23.1/-25.3
			// 而且把整张卡片 `visibility:hidden` 之后卡内亮度几乎不变
			// （152.2 → 152.3），说明那块亮面不是卡片画的，是它**背后的壁纸
			// 那一块本来就亮**（壁纸里白猫的白毛正好落在输入卡后面），
			// 18px 模糊又把它糊成一片均匀亮带 —— 于是整条输入卡看起来像
			// "另一种颜色"。画布没有这个问题，因为画布背后是整张壁纸的
			// 平均亮度；卡片面积小、位置固定，背后是什么全凭壁纸内容。
			// 解法：给卡片一条自己的地板，让它成为一块表面而不是一扇窗。
			// 0.78 是实测里"卡内外基本同色"的那一档，再高就开始比画布更暗。
			// 基色还要同时压深：`cardBase` 已经混过 70% 强调色（midnight 下
			// 是 116,134,179 的亮蓝），直接按 0.78 铺会变成一块亮蓝板
			// （实测 Δ 70/81/104，比修复前更刺眼）；朝深锚点推到 85% 才落到
			// 实验里胜出的那一片明度（28,33,45）。
			const cardMixBase = mixRgb(
				cardBase,
				isDarkTheme() ? FROST_CARD_DEEP_ANCHOR_DARK : FROST_CARD_DEEP_ANCHOR_LIGHT,
				FROST_CARD_DEEP_MIX,
			);
			// 卡片地板必须与侧栏走同一套规矩：`floorScale` 是用户对「还有没有
			// 地板」的唯一开关，它拉到底（=0）时画布与面板同透，卡片也不能
			// 例外地钉在某档深色上。
			//
			// 此外地板还得跟着画布一起变透 —— 0.78 这档是在默认不透明度 0.55
			// 下实测出来的（那时卡内外 Δ 0.8/2.4/1.7），它成立的前提是画布
			// 本身就有一层 0.55 的皮。用户把不透明度拖到 0.08（几乎只剩壁纸）
			// 之后，画布已经没有皮了，卡片却还硬挺在 0.78 的近黑蓝上，整窗
			// 就只剩这一块是另一种颜色 —— 这正是「对话框颜色还是不一样」。
			// 所以地板按 baseAlpha 线性登场：0.55 及以上照旧 0.78（默认观感
			// 一个像素都不动），越接近全透地板越弱，最低退化成 alpha + 一点点
			// 抬升（CARD_LIFT_SPREAD，与侧栏铺开档同量级：看得出托底，看不出
			// 接缝）。floorScale 仍在最外层乘一遍，用户取消地板时它归零。
			const cardFloor = FROST_CARD_FLOOR_SPREAD * floorScale * clamp(alpha / 0.55, 0, 1);
			const cardAlpha = Math.max(alpha + CARD_LIFT_SPREAD * floorScale, cardFloor);
			body.style.setProperty(
				FROST_CARD_TINT_VAR,
				toRgba(spread ? cardMixBase : cardBase, spread ? cardAlpha : 1),
			);
			// 设置页整块面板 / 各类弹层的亚克力底，原本是写死的
			// 0.38（深色）/ 0.58（浅色），与壁纸无关 —— 这才是「设置页
			// 看起来还是实底」的真正原因：导航列 `.AnXs9G_nav` 早就是
			// 完全透明的（实测 rgba(0,0,0,0)），实底感来自这层固定的
			// 0.38 叠在遮罩的 0.34 上，两层加起来把壁纸挡死了。
			//
			// 改成跟着画布 alpha 走：画布越透，设置页越透。上下限不是
			// 随手写的 —— 下限保住表单标签的可读性（设置页里全是小号
			// 说明文字，透到底就读不了），上限保证它始终比画布实一档，
			// 否则面板与背后的正文糊成一片。
			{
				const ovBase = isDarkTheme() ? "30,30,33" : "250,250,252";
				const ovAlpha = clamp(alpha + 0.12, isDarkTheme() ? 0.12 : 0.10, isDarkTheme() ? 0.50 : 0.58);
				// 必须手写 `rgba(...)`：ovBase 是逗号分隔的三元组，不是
				// CSS 颜色，`toRgba()` 对它只会原样返回 —— 变量里留下
				// `30,30,33` 这种非法值，`background-color:var(...)` 整条
				// 声明会被浏览器丢掉，面板反而退回宿主底色。
				body.style.setProperty(FROST_OVERLAY_TINT_VAR, "rgba(" + ovBase + "," + ovAlpha.toFixed(3) + ")");
				const maskAlpha = clamp(alpha + 0.06, 0.06, isDarkTheme() ? 0.34 : 0.24);
				body.style.setProperty(FROST_OVERLAY_MASK_VAR, "rgba(0,0,0," + maskAlpha.toFixed(3) + ")");
				// 第三方浮层面板：不跟画布 alpha 走。它悬在正文之上、背后
				// 是会话语料，没有同 alpha 的底板可借 —— 画布放到 0.08 时
				// 它也 0.08，字就直接和背后的会话标题叠在一起（用户报的
				// 「背景透明、干扰阅读」）。所以只在一个窄区间里跟着画布
				// 微微浮动，地板始终高于设置页面板。
				const floatTint = state.ui && state.ui.glass ? clamp(state.ui.glass.tint, 0, 1) : 1;
				const floatAlpha = clamp(0.62 + floatTint * 0.16 + alpha * 0.08, 0.62, 0.96);
				body.style.setProperty(FROST_FLOAT_TINT_VAR, "rgba(" + ovBase + "," + floatAlpha.toFixed(3) + ")");
			}

			const transparency = clamp(state.ui.transparency, 0, 1);
			for (const token of CONTENT_TOKENS) {
				const scale = surfaceScaleFor(token);
				// 这一面自己的主题色（无主题值才回落 base）。同一次 applyTokens
				// 里 26 个令牌共用一个 map 查表，不必每项重算。
				const tokenBase = surfaceBaseFor(token, scheme);
				if (spread) {
					// 铺开模式：以**画布 alpha 为起点**推导，而不是从 1 往
					// 下扣。旧公式 `max(1 - transparency, floor)` 在默认值
					// transparency = 0 时恒等于 1 —— 也就是「一个像素都不
					// 动」，这正是「只有对话画布有皮肤、侧栏和面板全实心」
					// 的公式级原因。
					//
					// 新公式 `max(alpha + lift, floor)` 有三条性质：
					//   • 单调于 alpha —— 壁纸越透面板越透，两者永远联动；
					//   • alpha = 0 时塌到 SPREAD_FLOOR，不会整块消失（面板
					//     全透明等于点不到内容，那是另一种坏）；
					//   • floor 同时是「密排文字的最低可读底」，因此抬升量
					//     再大也不会把菜单推到读不清。
					// 分部位系数照旧乘在最后：100% 不动，越往下越透。
					const lift = (SPREAD_LIFT[token] || 0) * floorScale;
					const floor = (SPREAD_FLOOR[token] || 0) * floorScale;
					// floorScale = 0 时 lift 与 floor 同时归零，whole 就恒等于
					// 画布 alpha —— 面板不再有任何一处比画布实。此时分部位
					// 系数也一并失效（乘上去只会更透，但那已经不是「同透」）。
					const whole = fullClear ? alpha : Math.max(alpha + lift, floor);
					// 浮层不受 floorScale 影响（见 FLOATING_FLOOR 的注释）：
					// 它压在正文上、没有同 alpha 的底板可借，塌到画布 alpha
					// 就会与背后的会话列表叠字。分部位系数仍然乘进来，所以
					// 用户想单独把菜单调更透依然拖得动 —— 只是下限跟着走。
					const surfaceAlpha = clamp(Math.max(whole * (fullClear ? 1 : scale), (FLOATING_FLOOR[token] || 0) * scale), 0, 1);
					body.style.setProperty(token, toRgba(tokenBase, surfaceAlpha));
					// 铺开时 SPREAD_CSS 会用 !important 把 layer-1..3 指回这三个
					// 变量（见 SPREAD_LAYER_VARS 的注释）—— 不写它们，那一层
					// 声明就会指到不存在的变量、退成 transparent。
					if (SPREAD_LAYER_VARS[token]) {
						body.style.setProperty(SPREAD_LAYER_VARS[token], toRgba(tokenBase, surfaceAlpha));
					}
					continue;
				}
				// 总强度为 0 且该组系数也是 1 —— 完全没有可写的东西，归还宿主值
				// 而不是写一个等价于原值的字面量（否则 body 上会多出一堆恒定声明，
				// 主题层就没法再改这些令牌了）。
				if (transparency <= 0 && scale >= 1) {
					restoreToken(token);
					continue;
				}
				// `whole` 是「总强度 + 该令牌自己的地板」算出的整面不透明度，
				// 也就是这一组在系数 100% 时的样子 —— 与旧实现逐字一致。
				const floor = (CONTENT_FLOOR[token] || 0) * floorScale;
				// 非铺开模式走的是「从 1 往下扣」的旧公式，与画布 alpha 无关；
				// 地板清到 0 时也要回到同一口径（整窗只有一档不透明度），
				// 否则用户关掉地板后仍会看到面板比画布实。
				const whole = fullClear ? alpha : Math.max(1 - transparency, floor);
				// 分部位系数是**乘在这份不透明度上**的：100% 时一个像素都不变，
				// 越往下越透。它只可能比总强度更透、绝不会更不透明（乘一个
				// ≤1 的系数不会超过 `whole`），因此不会把「我要壁纸透出来」这个
				// 用户意图反过来收掉。
				//
				// 刻意**不**再套一层地板：地板保护的是「拖动总强度时菜单被顺手
				// 读到穿」这个副作用；而在这里拖滑条本身就是明确的用户意图，
				// 再钳一次会让高地板组（菜单 0.92）的滑条在任何总强度下都拖不
				// 动 —— 又变成一根死控件。
				// 同上：浮层在任何模式下都不许塌到读不清 —— 非铺开模式没有
				// 「画布 alpha 起点」这层保护，whole 直接等于 1 - transparency，
				// 用户把总强度拉到 0.84 时菜单只剩 0.16，背后的会话条目会整片
				// 透上来。FLOATING_FLOOR 在这里同样生效，且同样乘分部位系数。
				const surfaceAlpha = clamp(Math.max(whole * scale, (FLOATING_FLOOR[token] || 0) * scale), 0, 1);
				body.style.setProperty(token, toRgba(tokenBase, surfaceAlpha));
			}

			// Text colours are overridden only when the scheme is forced or
			// sampled; in "theme" mode the token falls back to whatever the
			// ACTIVE THEME says — which for 跟随原生 is still nothing at all,
			// so the native DSH tokens stay in charge.
			const mode = state.ui && state.ui.contrast ? state.ui.contrast : "theme";
			// `auto` 曾经和 `light`/`dark` 走同一个分支，用插件写死的三档色
			// 盖住一切 —— 于是任何一个带字色预设的主题，字色都永远是那三档灰，
			// 主题自己的 #e6e9ef / #b6bec9 / #8d96a3 一次都没上过屏。
			//
			// 这里把「自动」重新解释成「明暗跟着壁纸取样走，但具体用哪三档
			// 颜色听主题的」：主题给了值就用主题值（restoreToken 会写、
			// 而且带 !important），主题没给（跟随原生）才回落到宿主原生声明。
			// 只有用户显式选了浅色/深色，才继续用插件固定色板去压，
			// 因为那是一个明确的「我不在乎主题，就要这个明暗」的选择。
			const themed = mode === "theme" || mode === "auto";
			if (!themed) {
				const palette = scheme === "light" ? TEXT_ON_LIGHT : TEXT_ON_DARK;
				// 这里也必须走 setThemeToken：强制/取样明暗时写的是插件自己的
				// 三档文本色，同样要和主题值一样压住宿主那四条声明。此前用的是
				// 裸 setProperty（普通优先级），于是 `contrast = "auto"` 的默认
				// 配置下这三档被静默丢弃 —— 注意 `auto` 也落在这个分支里，
				// 所以"默认设置下字色换了主题也不变"就是这么来的。
				for (let i = 0; i < LABEL_TOKENS.length; i += 1) setThemeToken(body, LABEL_TOKENS[i], palette[i]);
			} else {
				for (const token of LABEL_TOKENS) restoreToken(token);
			}
			// 高对比收口：上面两路（主题值 / 固定色板）都不是按 textBoost 算的，
			// 而 applyTokens 又是最后一个写这四档的地方（tokens 排在 uitheme 与
			// ink 之后），所以它会把 ink 算好的档位再擦回主题的 #e6e9ef。
			// 用户 m01489 要的就是「文字高对比」，这里按 inkLevels 收口一次。
			{
				const ink = inkLevels(state.ui && state.ui.textBoost);
				for (let i = 0; i < LABEL_TOKENS.length; i += 1) {
					setThemeToken(body, LABEL_TOKENS[i], ink[i % 4]);
				}
				// 2026-11-21 用户 m02692：LABEL_TOKENS 只有前三档，caption 与
				// dimmed 不在其中，于是这两档在 tokens 收口后仍回到主题的
				// #969696 / #79828f。这里一并按 ink 的档位补写。
				setThemeToken(body, "--dsw-alias-label-caption", ink[3]);
				setThemeToken(body, "--dsw-alias-label-dimmed", ink[3]);
			}

			// The backing alpha just changed, which can hide or reveal the video:
			// stop decoding frames nobody can see, or resume them.
			applyVideoPlayback();
		}

		/** 主按钮前景色的样式表节点 id（内联会被 modern-ui 的 cssText 重写清掉）。 */
		const PRIMARY_FG_STYLE_ID = "dsh-skin-keymark-primary-fg";

		/**
		 * Accent override: fan one colour out to the brand / primary-button
		 * tokens. Kept separate from applyTokens() so it still applies when the
		 * wallpaper is disabled — the accent is an independent switch. An empty
		 * value removes the overrides and restores the native DSH accent.
		 *
		 * "Removes" means restores, not deletes. ACCENT_TOKENS overlaps the
		 * interface theme's table (brand-primary / state-business-primary /
		 * button-primary-fill), and applyAccent() runs AFTER applyUiTheme(), so a
		 * bare removeProperty() would silently erase the palette's own brand
		 * colour — the one difference a theme actually gets to keep once the
		 * wallpaper wash has dimmed everything else. Measured: that wiped a
		 * Δ61/255 swing on Codex while every surface stayed invisible.
		 */
		function applyAccent() {
			const body = document.body;
			if (!body) return;
			const accent = normalizeAccent(state.accent);
			for (const token of ACCENT_TOKENS) {
				if (accent === "") restoreToken(token);
				else body.style.setProperty(token, accent);
			}
			applyPrimaryForeground(accent);
		}

		/**
		 * 主按钮前景色收口：modern-ui 把 --dsw-alias-label-primary-foreground
		 * 派生自 var(--surface)，而本插件为了吃掉 modern-ui 写死的死黑块把
		 * --surface 改成了 10% 白 —— 于是所有 primary 按钮的文字变成 10% 白，
		 * 压在浅蓝填充上实测对比度只有 1.08（视觉上就是「看不清字的框」）。
		 * --surface 不能动，只能把前景这两条与它解耦：按填充亮度选黑/白。
		 */
		function applyPrimaryForeground(accent) {
			const body = document.body;
			if (!body) return;
			let fill = accent;
			if (!fill) {
				const raw = (getComputedStyle(body).getPropertyValue("--dsw-alias-button-primary-fill") || "").trim();
				const m = /^#([0-9a-f]{6})$/i.exec(raw);
				// 主题给的不是六位 hex 时（或还没算出来）按明暗兜底。
				fill = m ? "#" + m[1] : isDarkTheme() ? "#8bb9f2" : "#1f5fae";
			}
			const lightFill = hexLum(fill) > 0.45;
			// inverted 压在半透明黑底上（附件删除圆心），恒要白色。
			const fg = lightFill ? "#14161b" : "#ffffff";
			// 必须走样式表：modern-ui 会用 body.style.cssText 整体重写内联样式，
			// 连 !important 标志一起清掉（实测 n=25 写成 → n=238 被改回 var(--surface)）。
			// 它写的是普通优先级内联声明，样式表里的 !important 稳定压制它。
			// 侧栏品牌行的 HARNESS 徽章是 rect(fill:currentColor) + 白字，白底白字读作一块白块；
			// 字色必须跟着品牌色走：深色主题品牌色近白（白底）→ 深字，浅色主题反之。
			const badgeInk = isDarkTheme() ? "#14161b" : "#ffffff";
			const css = ":root, body, body[data-ds-dark-theme]{--dsw-alias-label-primary-foreground:" + fg +
				 " !important;--dsw-alias-label-primary-inverted:#ffffff !important}" +
				"[data-slot=\"sidebar.brand.name\"] [clip-path*=\"badge\"] path{fill:" + badgeInk + " !important}";
			let el = document.getElementById(PRIMARY_FG_STYLE_ID);
			if (!el) {
				el = document.createElement("style");
				el.id = PRIMARY_FG_STYLE_ID;
				(document.head || document.documentElement).appendChild(el);
			}
			if (el.textContent !== css) el.textContent = css;
		}

		/** Persist a new accent ("" restores the native DSH accent). */
		function setAccent(value) {
			state.accent = normalizeAccent(value);
			commit();
		}

		/** Pick a preset accent that differs from the one currently applied. */
		function randomAccent() {
			const current = normalizeAccent(state.accent);
			const pool = ACCENT_PRESETS.filter((v) => v !== current);
			const list = pool.length ? pool : ACCENT_PRESETS;
			return list[Math.floor(Math.random() * list.length)];
		}

		/**
		 * Switch the whole-app palette. A theme is a property of the interface,
		 * not of the artwork, so unlike auto-tune this never touches marks, the
		 * contrast mode or the wallpaper — it only repaints the base layer.
		 */
		function setUiTheme(id) {
			state.ui.theme = UI_THEMES[id] ? id : "native";
			commit();
		}

		// ── keymark engine ─────────────────────────────────────────────────

		function buildMarkCss() {
			const out = [];
			const varsFor = (scheme) => {
				const colors = state.marks[scheme];
				const lines = [];
				for (const k of MARK_KEYS) {
					const v = colors[k];
					if (typeof v === "string" && v.trim() !== "") lines.push(`--km-${k}: ${v.trim()};`);
				}
				return lines;
			};
			const lightVars = varsFor("light");
			if (lightVars.length) out.push(`:root {\n  ${lightVars.join("\n  ")}\n}`);
			const darkVars = varsFor("dark");
			if (darkVars.length) out.push(`:is(body, html)[data-ds-dark-theme] {\n  ${darkVars.join("\n  ")}\n}`);

			// Every declaration below writes ONLY `color`. No background, border,
			// box-shadow or outline is ever emitted, so no boxes appear.
			out.push(`${SCOPE} :is(strong, b) { color: var(--km-strong, ${MARK_FALLBACK.strong}); }`);
			out.push(`${SCOPE} :is(a, [class*="fileLink"], [class*="fileMention"]) { color: var(--km-link, ${MARK_FALLBACK.link}); }`);
			out.push(`${SCOPE} :not(pre) > code { color: var(--km-code, ${MARK_FALLBACK.code}); }`);
			out.push(`${SCOPE} :is(h1, h2, h3, h4, h5, h6) { color: var(--km-heading, ${MARK_FALLBACK.heading}); }`);
			out.push(`${SCOPE} li::marker { color: var(--km-marker, ${MARK_FALLBACK.marker}); }`);
			out.push(
				`:is([data-chat-flow], [class*="markdown"], [class*="userText"]) { color: var(--km-body, ${MARK_FALLBACK.body}); }`
			);
			return out.join("\n");
		}

		function applyMarkStyle() {
			let el = document.getElementById(STYLE_ID);
			if (!el) {
				el = document.createElement("style");
				el.id = STYLE_ID;
				(document.head || document.documentElement).appendChild(el);
			}
			el.textContent = buildMarkCss();
		}

		/**
		 * 用户自定义 CSS：整段原样写进一个独立的 <style>。
		 *
		 * 三个刻意的选择：
		 * 1. `textContent` 而不是 `innerHTML` —— 文本永不进 HTML 解析器，
		 *    所以 `</style>`、`<` 这些都不需要转义，粘贴别人的片段不会
		 *    提前截断自己的样式表。
		 * 2. 每次都 `appendChild` 到 head 末尾 —— appendChild 对已存在节点
		 *    是「移动」语义，于是这段样式永远排在插件自己的样式节点之后。
		 *    同特异性下后写者胜，这是用户能够覆盖 `--km-*` 与 keymark
		 *    六色的唯一可靠办法（插在中间会被后面的引擎压回去）。
		 * 3. 空串 = 拆掉节点，不是"留一个空 style" —— 删掉才叫真的没生效。
		 */
		function applyUserCss() {
			const css = typeof state.ui.userCss === "string" ? state.ui.userCss : "";
			const existing = document.getElementById(USER_STYLE_ID);
			if (css.trim() === "") {
				stopUserCssGuard();
				if (existing) existing.remove();
				return;
			}
			const el = existing || document.createElement("style");
			el.id = USER_STYLE_ID;
			el.textContent = namespaceUserCss(css);
			(document.head || document.documentElement).appendChild(el);
			startUserCssGuard();
		}

		/* ── 用户稿子的三条体检 ──
		 *
		 * 1. `lintUserCss()`：真解析一遍，把「哪一行废了」告诉用户。
		 *    浏览器对 CSS 的错误恢复是逐条丢弃 —— 一段 40 行的稿子里
		 *    写错一行，另外 39 行照样生效。所以我们**不拦**，只在面板上
		 *    标红提示。拦下来等于把调试过程也一起没收了。
		 * 2. `namespaceUserCss()`：给用户写的 @keyframes 统一加前缀。
		 *    插件自己有一套 `km-*` 动画，用户随手写个 `fade` 就可能同名，
		 *    同特异性下后写者胜 —— 用户会把宿主的入场动画顶掉，而且
		 *    他自己完全不知道发生了什么。
		 * 3. 空串 / 非字符串一律当「关闭」，不做猜测。
		 */
		function lintUserCss(css) {
			const text = typeof css === "string" ? css : "";
			if (text.trim() === "") return { ok: true, rules: 0, error: "" };
			if (typeof CSSStyleSheet !== "function") return { ok: true, rules: 0, error: "" };
			// 只写注释不算写错。
			const bare = text.replace(/\/\*[\s\S]*?\*\//g, "").trim();
			if (bare === "") return { ok: true, rules: 0, error: "" };
			let rules = 0;
			try {
				const sheet = new CSSStyleSheet();
				sheet.replaceSync(text);
				rules = sheet.cssRules.length;
			} catch (error) {
				return { ok: false, rules: 0, error: String((error && error.message) || error) };
			}
			// 括号配对是唯一能确定性抓到的「局部写坏」：`:root { color: red`
			// 这种未闭合，浏览器会默默把后面全部吞进这条规则，界面上看起来
			// 只是「没生效」，最难查。先剥字符串字面量再数，避免 content: "{"
			// 这类写法误报。
			const stripped = bare.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
			const open = (stripped.match(/\{/g) || []).length;
			const close = (stripped.match(/\}/g) || []).length;
			if (open !== close) {
				return {
					ok: false,
					rules,
					error: "大括号不配对（{ " + open + " 个，} " + close + " 个），后面的规则会被一起吞掉。"
				};
			}
			if (rules > 0) return { ok: true, rules, error: "" };
			// 实测：replaceSync 对绝大多数语法错误**不抛异常**，它只是把认不出
			// 的那条静默丢掉（`:root { color: red` 未闭合 → 仍有 1 条；
			// `this is not css at all` → 0 条且无错）。所以判据不能是「有没有
			// 抛错」，只能是「一条规则都没解析出来」。纯 @import 也解析为 0 条，
			// 那不是错，要放行。
			const onlyImport = /^@(?:import|charset|namespace)\b/i.test(bare) && bare.indexOf("{") < 0;
			if (onlyImport) return { ok: true, rules: 0, error: "" };
			return {
				ok: false,
				rules: 0,
				error: "没解析出规则：检查括号是否闭合、属性和值之间有没有冒号。"
			};
		}

		const USER_KEYFRAME_PREFIX = "km-user-";

		function namespaceUserCss(css) {
			const text = typeof css === "string" ? css : "";
			if (text.indexOf("@keyframes") < 0) return text;
			const names = [];
			const header = /@keyframes\s+([A-Za-z_][\w-]*)/g;
			let hit;
			while ((hit = header.exec(text)) !== null) {
				if (names.indexOf(hit[1]) < 0) names.push(hit[1]);
			}
			let out = text;
			for (const name of names) {
				out = out.replace(
					new RegExp("@keyframes\\s+" + name + "(?![\\w-])", "g"),
					"@keyframes " + USER_KEYFRAME_PREFIX + name
				);
			}
			// 引用侧只改 animation / animation-name 的值。不能用「全文替换
			// 这个名字」—— 用户可能同时有 `.fade { … }` 这样的类选择器，
			// 全文替换会把它一起改掉，规则当场失效。
			const decl = /(animation(?:-name)?\s*:\s*)([^;}]+)/g;
			return out.replace(decl, (whole, head, value) => {
				let next = value;
				for (const name of names) {
					next = next.replace(
						new RegExp("(^|[\\s,])" + name + "(?![\\w-])", "g"),
						(_, lead) => lead + USER_KEYFRAME_PREFIX + name
					);
				}
				return head + next;
			});
		}

		/* ── 导出前扫一遍：本机路径与凭据 ──
		 *
		 * 主题包会把整个 state 导出去，里面有 `diag` 这类诊断字段 ——
		 * 那里面存的是报错信息，可能带绝对路径。用户把包发给别人做
		 * 预设时，路径就跟着走了。不阻断导出，只做两件事：
		 * ① 删掉顶层诊断字段；② 把命中的字符串就地遮掉。
		 */
		const SECRET_PATTERNS = [
			{ kind: "凭据", re: /\b(?:ghp_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{20,}/g },
			{ kind: "私钥", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
			// 路径这条必须**吃到引号或行尾**，不能在第一个反斜杠处停下。
			// 旧写法 `[A-Z]:\\(?:Users|…)[^"\\]*` 只遮到 `C:\Users`，剩下的
			// `\16041\AppData\…` 原样留在导出里 —— 看起来遮了，实际只遮了前缀。
			// 同时兼容 `C:/Users/…`（正斜杠）与 JSON 转义后的 `C:\\Users\\…`。
			{ kind: "本机路径", re: /(?:[A-Z]:(?:\\\\|\\|\/)[^"'\r\n]*|file:\/\/\/[^"'\r\n]*|https?:\/\/[^\s/@]+:[^\s/@]+@)/gi }
		];

		function scanSecrets(value, hits, depth) {
			if (depth > 12 || hits.length >= 24) return hits;
			if (typeof value === "string") {
				for (const rule of SECRET_PATTERNS) {
					rule.re.lastIndex = 0;
					const match = rule.re.exec(value);
					if (match) hits.push({ kind: rule.kind, sample: String(match[0]).slice(0, 48) });
				}
				return hits;
			}
			if (Array.isArray(value)) {
				for (const item of value) scanSecrets(item, hits, depth + 1);
				return hits;
			}
			if (value && typeof value === "object") {
				for (const key of Object.keys(value)) scanSecrets(value[key], hits, depth + 1);
			}
			return hits;
		}

		function redactString(text) {
			let out = text;
			for (const rule of SECRET_PATTERNS) {
				rule.re.lastIndex = 0;
				out = out.replace(rule.re, "«已隐藏»");
			}
			return out;
		}

		function redactDeep(value, depth) {
			if (depth > 12) return value;
			if (typeof value === "string") return redactString(value);
			if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
			if (value && typeof value === "object") {
				const out = {};
				for (const key of Object.keys(value)) out[key] = redactDeep(value[key], depth + 1);
				return out;
			}
			return value;
		}

		/**
		 * 导出用的快照：去掉诊断字段、遮掉疑似路径与凭据。
		 * 返回 `{ value, hits }`，`hits` 非空时面板上要告诉用户改了什么。
		 */
		function exportSnapshot(current) {
			const clone = JSON.parse(JSON.stringify(current));
			const hits = scanSecrets(clone, [], 0);
			delete clone.diag;
			delete clone.diagAt;
			delete clone.diagPhase;
			return { value: hits.length ? redactDeep(clone, 0) : clone, hits };
		}

		/* ── 把用户稿子钉在最后 ──
		 *
		 * appendChild 只在「我们跑的那一刻」把它放到末尾。可别的引擎与别的插件
		 * 随时会往 head 里再追加 <style>：applyTokens 是无条件 run，profile 里还
		 * 有 dam-skin、auto-memory、solution-explorer 等十几个会在启动后期插样式
		 * 的家伙。实测装完一轮，用户节点排在 head 的第 28 个 <style>，后面还压着
		 * 200 多个 —— 同特异性下后写者胜，等于用户覆盖不了任何人。
		 *
		 * 所以补一个 head 的 childList 观察器：只要我们的节点不再是最后一个
		 * <style>，就把它再 append 一次。appendChild 对已存在节点是「移动」，
		 * 这一下本身会再触发观察器，但下一轮它已经在末尾，判据不成立即停 ——
		 * 收敛，不会自激。
		 */
		let userCssGuard = null;

		function userCssIsLast() {
			const el = document.getElementById(USER_STYLE_ID);
			if (!el) return true;
			const head = document.head || document.documentElement;
			const styles = head.getElementsByTagName("style");
			return styles.length === 0 || styles[styles.length - 1] === el;
		}

		function startUserCssGuard() {
			if (userCssGuard) return;
			const head = document.head || document.documentElement;
			if (typeof MutationObserver !== "function") return;
			userCssGuard = new MutationObserver(() => {
				if (userCssIsLast()) return;
				const el = document.getElementById(USER_STYLE_ID);
				if (el) head.appendChild(el);
			});
			// 只盯 head 直接子节点的增删：改属性/改文本与我们无关。
			userCssGuard.observe(head, { childList: true });
		}

		function stopUserCssGuard() {
			if (!userCssGuard) return;
			userCssGuard.disconnect();
			userCssGuard = null;
		}

		// 每个引擎「上一次实际跑过时的输入签名」。
		//
		// 一次 commit 会跑满 10 个引擎，但它们绝大多数依赖的东西根本没变：
		// 拖「内容层透明强度」时壁纸 URL、颗粒、毛玻璃、主题、强调色全都没
		// 动过，重跑它们等于把同一份 cssText 反复重建一遍。签名把这件事变
		// 成可判定的：签名相同就跳过，不同才真跑。
		//
		// 刻意**不**跳过 applyWallpaper —— 它是所有视觉层的入口，还顺带
		// 负责 syncWallpaperMark() 与轮播计时，跳过它的风险远大于收益。
		const applySigs = Object.create(null);

		/** 只在 `sig` 与上次不同时执行 `fn`；`run` 负责错误隔离。 */
		function once(name, sig, run, fn) {
			if (applySigs[name] === sig) return false;
			applySigs[name] = sig;
			run(name, fn);
			return true;
		}

		/**
		 * 卸载时清空签名表。
		 *
		 * 卸载路径已经把插件写过的一切都从 DOM 上拆掉了（令牌、样式节点、
		 * 壁纸元素）。如果签名留着，重新 apply 时那些引擎会被判「输入没
		 * 变、不必重跑」，于是它们写过的样式不会被重新创建 —— 关一次插
		 * 件再开一次，皮肤就少了一半。签名必须和它描述的那些副作用同生
		 * 同灭。
		 */
		function resetApplySigs() {
			for (const name of Object.keys(applySigs)) delete applySigs[name];
		}

		// ─────────────────── 锚点存活自检（升级探测器） ───────────────────
		// 宿主或 dsh-claude-style 一升级，本插件的规则可能**静默失效**：
		// CSS 选择器不命中不报错、令牌不存在也不报错，界面只是悄悄退回
		// 原样（字变回衬线、卡片变回实底）。这里在启动后扫一遍自己注入的
		// 样式表，逐条数 `[class*="x"]` 在真实 DOM 里命中多少元素，把结果
		// 写进 `dsh-skin-keymark.json` 的 `anchorDiag` 键。
		//
		// 判据分三档，避免误报：
		//   · onDemand —— 弹层类锚点本来就只在打开时有元素，0 命中属正常；
		//   · regressed —— 上次见到过元素、这次 0 命中 ⇒ 真断了（升级改名/改哈希）；
		//   · suspicious —— 从没见过元素，可能一开始就没对上，值得看一眼。
		// 基线存 localStorage，跨重启保留。
		const ANCHOR_BASELINE_KEY = "dsh-skin-keymark-anchor-baseline";
		// 「只在特定内容出现时才有元素」的锚点：0 命中属正常，不计入告警。
		// 前六个是弹层族；后面是「有交付物卡片 / 展开代码块 / 抽屉打开 / 消息
		// 里带文件提及」才渲染的——冷启动的空白会话里它们本就不存在。
		const ANCHOR_ON_DEMAND = [
			"_overlay", "_panel", "_content", "_mask", "_dialog", "_popover", "_popover-card",
			"HOHHba_card", "HOHHba_header", "K5rwea_root", "K5rwea_file",
			"ioCard", "_1h1PMq_root", "ZG377q_card",
			"EqXNNG_body", "iFrn8G_body", "LOmM4q_fileCard",
			"_leadingSeat", "hSzSIW_root", "_drawer", "userText", "fileMention", "fileLink"
		];
		// claude-style 的内部令牌：它若改名，我们的覆盖会失效而完全不报错。
		const TOKEN_WATCH = [
			"--dsh-claude-font-prose", "--dsh-claude-font-serif", "--dsh-claude-font-code",
			"--dsh-tone-ink", "--dsh-tone-ink-3", "--dsh-tone-surface-1",
			"--dsw-alias-bg-layer-1", "--changes-fill", "--deliverable-fill",
			"--dsw-specific-input-major", "--dsw-alias-turn-trigger-bg"
		];
		// 升级检测：把「这次看到的宿主版本 + 各插件代码 rev」存成快照，
		// 下次启动一比对就知道是不是刚升过级。宿主与 dsh-claude-style 都
		// 可能改名/改哈希，那会让本插件的覆盖静默失效；有了快照，升级后
		// 第一次启动就会强制跑一遍全量自检，而不是等 60s 节流逝去。
		//
		// 数据源是 `window.__DSH_BOOT__`（宿主启动清单，dsh-client-modules
		// 的 parseBootManifest 就在这里读）：`release.version` / `release.commit`
		// 是宿主版本，`entries[].id/rev` 是各插件的代码指纹。
		// 不用 `__DSH_BOOT__.rev`（整张图的 rev）当升级信号：它每次 HMR 都变，
		// 本插件自己改一行代码就会误判成「宿主升级」。
		const VERSION_SNAPSHOT_KEY = "dsh-skin-keymark-version-snapshot";
		const LAST_AUDIT_KEY = "dsh-skin-keymark-last-audit";
		// 自身 rev 每次都随编辑变化，必须排除；只关心「别人的代码变了」。
		const SELF_ID = "dsh-skin-keymark";
		function collectVersions() {
			const out = { host: { version: "", commit: "" }, plugins: {} };
			try {
				const boot = window.__DSH_BOOT__;
				if (boot && typeof boot === "object") {
					const rel = boot.release;
					if (rel && typeof rel === "object") {
						if (typeof rel.version === "string") out.host.version = rel.version;
						if (typeof rel.commit === "string") out.host.commit = rel.commit;
					}
					const entries = Array.isArray(boot.entries) ? boot.entries : [];
					for (const row of entries) {
						if (!row || typeof row !== "object") continue;
						if (typeof row.id !== "string" || typeof row.rev !== "string") continue;
						if (row.id === SELF_ID) continue;
						out.plugins[row.id] = row.rev;
					}
				}
			} catch {
				/* 清单读不到就当没版本信息，自检照常按节流跑 */
			}
			return out;
		}
		function readVersionSnapshot() {
			try {
				const raw = window.localStorage.getItem(VERSION_SNAPSHOT_KEY);
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed === "object" ? parsed : null;
			} catch {
				return null;
			}
		}
		function diffVersions(prev, next) {
			const changes = [];
			if (!prev || typeof prev !== "object" || !prev.host) return { first: true, changes };
			const ph = prev.host || {};
			const nh = (next && next.host) || {};
			const pv = String(ph.version || "");
			const nv = String(nh.version || "");
			if (pv !== nv) changes.push("宿主 " + (pv || "?") + " → " + (nv || "?"));
			else {
				const pc = String(ph.commit || "");
				const nc = String(nh.commit || "");
				if (pc !== nc) changes.push("宿主构建 " + (pc || "?") + " → " + (nc || "?"));
			}
			const pp = (prev && prev.plugins) || {};
			const np = (next && next.plugins) || {};
			for (const id of Object.keys(np)) {
				const a = String(pp[id] || "");
				const b = String(np[id] || "");
				if (a === "" ) { if (b !== "") changes.push(id + " 首次出现"); continue; }
				if (a !== b) changes.push(id + " " + a + " → " + b);
			}
			for (const id of Object.keys(pp)) {
				if (!(id in np) && String(pp[id] || "") !== "") changes.push(id + " 消失");
			}
			return { first: false, changes };
		}
		let anchorAuditAt = 0;
		function auditAnchors(mode) {
			const hitMode = mode || "periodic";
			try {
				const text = [...document.querySelectorAll("style")]
					.filter((s) => String(s.id || "").startsWith("dsh-skin-keymark"))
					.map((s) => s.textContent || "")
					.join("\n");
				const seen = new Set();
				const re = /class\*=\\?"([^"\\]+)\\?"/g;
				let m;
				while ((m = re.exec(text))) seen.add(m[1]);
				const counts = {};
				const zero = [];
				for (const a of seen) {
					let n = 0;
					try {
						n = document.querySelectorAll('[class*="' + a + '"]').length;
					} catch {
						n = -1;
					}
					counts[a] = n;
					if (n === 0) zero.push(a);
				}
				let baseline = {};
				try {
					baseline = JSON.parse(localStorage.getItem(ANCHOR_BASELINE_KEY) || "{}") || {};
				} catch {
					baseline = {};
				}
				const regressed = [];
				for (const a of Object.keys(counts)) {
					const prev = Number(baseline[a] || 0);
					if (prev > 0 && counts[a] === 0) regressed.push(a);
					if (counts[a] > prev) baseline[a] = counts[a];
				}
				try {
					localStorage.setItem(ANCHOR_BASELINE_KEY, JSON.stringify(baseline));
				} catch {
					/* 存不进去就算了，不影响自检 */
				}
				const missingTokens = TOKEN_WATCH.filter((t) => !getComputedStyle(document.body).getPropertyValue(t).trim());
				const isOnDemand = (a) => ANCHOR_ON_DEMAND.indexOf(a) >= 0;
				const dead = zero.filter((a) => !isOnDemand(a) && regressed.indexOf(a) >= 0);
				const suspicious = zero.filter((a) => !isOnDemand(a) && regressed.indexOf(a) < 0);
				diagReport("anchors", [
					"anchors=" + Object.keys(counts).length,
					"dead=" + (dead.length ? dead.join(",") : "-"),
					"suspicious=" + (suspicious.length ? suspicious.join(",") : "-"),
					"onDemandZero=" + zero.filter(isOnDemand).length,
					"missingTokens=" + (missingTokens.length ? missingTokens.join(",") : "-"),
					"mode=" + hitMode
				].join(" | "), "anchorDiag");
				// 升级快照：只有自检真的跑成了才更新 —— 自检抛异常时若先把新版本
				// 记成「已见过」，下一轮就再也不会因为这次升级而触发了。
				const versions = collectVersions();
				const prevSnap = readVersionSnapshot();
				const diff = diffVersions(prevSnap, versions);
				const at = new Date().toISOString();
				try {
					window.localStorage.setItem(VERSION_SNAPSHOT_KEY, JSON.stringify({
						host: versions.host,
						plugins: versions.plugins,
						at
					}));
				} catch {
					/* 存不进去：下一轮会再判一次升级，不会漏检 */
				}
				const summary = {
					at,
					mode: hitMode,
					host: versions.host,
					changes: diff.changes,
					anchors: Object.keys(counts).length,
					dead: dead.join(","),
					suspicious: suspicious.join(","),
					onDemandZero: zero.filter(isOnDemand).length,
					missingTokens: missingTokens.join(",")
				};
				try {
					window.localStorage.setItem(LAST_AUDIT_KEY, JSON.stringify(summary));
				} catch {
					/* 面板读不到就显示空，不影响自检 */
				}
				diagReport("upgrade", [
					"host=" + (versions.host.version || "?") + (versions.host.commit ? "(" + versions.host.commit + ")" : ""),
					// prevTop 只在「非首次」时有意义：一次 applyAll 可能连排两三个自检
					// （token 应用链会多次触发），第一个跑完就写了快照，第二个读到的
					// 已经是「当前版本」，直接照抄会显示成「版本没变」，误导排查。
					"prevTop=" + (hitMode === "first-run" || diff.first ? "(首次)" : (String((prevSnap.host && prevSnap.host.version) || "?") + (prevSnap.host && prevSnap.host.commit ? "(" + prevSnap.host.commit + ")" : ""))),
					"changes=" + (diff.changes.length ? diff.changes.join("; ") : "-"),
					"mode=" + hitMode,
					"plugins=" + Object.keys(versions.plugins).length
				].join(" | "), "upgradeDiag");
			} catch (e) {
				diagReport("anchors", "err:" + String((e && e.message) || e), "anchorDiag");
			}
		}

		function applyAll() {
			// Run every engine in isolation: a failure in one (an exotic
			// wallpaper URL the <video> element rejects, a canvas-tainting
			// frame, …) must not abort the others. Before this, one throwing
			// engine silently stopped accent + keymark from applying too.
			const run = (name, fn) => {
				try {
					fn();
				} catch (error) {
					diagReport("apply:" + name, String((error && error.message) || error));
				}
			};
			const wp = state.wallpaper;
			const url = typeof wp.url === "string" ? wp.url.trim() : "";
			const grad = gradientSpec();
			const artKey = grad ? "gradient:" + grad.id : url;
			const dark = isDarkTheme();
			// applyWallpaper is the entry point for every visual layer — it also
			// owns syncWallpaperMark() and the rotation countdown — so it always
			// runs. Everything below is gated on the inputs it actually reads.
			run("wallpaper", applyWallpaper);
			once("grain", [wp.enabled, artKey, clamp(wp.grain, 0, 1)].join("|"), run, applyGrain);
			// 主题染色不需要单独门控：它是在 surfaceBaseFor() 里完成的，
			// 而 applyTokens 本来就无条件跑（下面 run("tokens", …)），主题、
			// 强调色、比例一变就整批重贴。这里**曾经有一层**
			// `mix-blend-mode:color` 的独立着色层，实测暗部 Δ≈0 已删除。
			once("acrylic", [state.ui && state.ui.glass ? state.ui.glass.blur : 0,
				state.ui && state.ui.glass ? state.ui.glass.tint : 1, dark, Boolean(panelEl)].join("|"), run, applyAcrylic);
			// 宿主自己的输入卡 / 设置页 / 弹窗：同一组 glass 参数，另一层落地。
			// 与 acrylic 分签名注册：drawer 是否已挂载（Boolean(panelEl)）会变，
			// 而宿主面不依赖它，混在一个签名里会让抽屉晚挂载时把这层也重跑一遍。
			once("frost", [state.ui && state.ui.glass ? state.ui.glass.blur : 0,
				state.ui && state.ui.glass ? state.ui.glass.tint : 1, dark].join("|"), run, applyFrost);
			// 字体家族 + 灰度抗锯齿：与壁纸、玻璃都无关，只看这两项设置。
			once("font", [state.ui && state.ui.fontFamily, state.ui && state.ui.fontSmoothing !== false, state.ui && state.ui.fontWeight].join("|"), run, applyFontFamily);
			// Orbit's own switch depends on whether the current wallpaper element
			// is a <video> — switching from an image to a video keeps the element
			// present, so `Boolean(el)` alone would look unchanged and the orbit
			// handler would never attach. The tag name and the reduced-motion
			// preference both have to be in the signature.
			const wpEl = document.getElementById(WALLPAPER_ID);
			once("orbit", [wp.orbit === true, wp.crossfade === true, wp.enabled !== false,
				wpEl ? wpEl.tagName : "", prefersReducedMotion()].join("|"), run, applyOrbit);
			// Luminance sampling is async on first sight of a URL; it calls
			// applyTokens() again once the average is known, but kicking it here
			// keeps `auto` contrast in step with wallpaper changes.
			once("luminance", [wp.enabled, url, grad ? grad.id : ""].join("|"), run, ensureLuminance);
			once("tint", [state.ui && state.ui.autotint === true, wp.enabled !== false, artKey].join("|"), run, ensureTint);
			// The palette is the BASE layer: it has to land before the wash,
			// the transparency pass, the text override and the accent, all of
			// which composite on top of the canvas it paints.
			once("uitheme", [state.ui && state.ui.theme, dark].join("|"), run, applyUiTheme);
			// ↑ 主题层必须排在 ink 之前：两者都写 inline `!important` 的四档 label
			// 令牌（见 IMPORTANT_LABEL_TOKENS），同层 later-wins。早年 ink 注册在
			// 主题层之前，于是 #e6e9ef 每次都把算好的 ink 覆盖掉 —— 文字亮不起来
			// 的真根因就是这一行的顺序，不是公式。
			once("ink", [state.ui && state.ui.textBoost, dark].join("|"), run, applyInk);
			// Tokens are never gated: this is the engine the whole feature is
			// about, and it also owns the spread surface attach/detach.
			run("tokens", applyTokens);
			once("accent", [normalizeAccent(state.accent), dark].join("|"), run, applyAccent);
			once("marks", JSON.stringify(state.marks), run, applyMarkStyle);
			// 用户自定义 CSS 必须排在所有引擎之后：它就是那一层「最后说
			// 话的人」。放进 once() 而不是无条件 run —— 一段上万字符的稿子
			// 每次 commit 都写一遍 textContent 会让浏览器整表重解，而这个
			// 输入只有用户自己会改，签名足够。
			once("usercss", typeof state.ui.userCss === "string" ? state.ui.userCss : "", run, applyUserCss);
			// 锚点自检放在最后：它要读的 <style> 得先被上面几层写进
			// document。延时 1.5s 是为了让宿主把首屏面板（侧栏 / 画布 /
			// 输入卡）都渲染出来，否则冷启动瞬间会数出一堆 0 命中。
			// 用时间戳门而非 once()：同一会话里切主题 / 改设置会重跑
			// applyAll，但自检没必要每次都扫。
			// 不能用 `document.hidden` 当门：这台机器的宿主常年最小化在托盘，
			// 一加这个判断自检就永远不跑（实测首版即如此，anchorDiag 一直为空）。
			// 版本比对放在这里：升级后第一次 applyAll 就必须跑全检，因此不受
			// 60s 节流约束。比对只用宿主 version/commit 与各插件 rev，不用整张
			// 图的 rev（那玩意每次 HMR 都变，本插件自己改一行就误报成升级）。
			{
				const __ver = collectVersions();
				const __diff = diffVersions(readVersionSnapshot(), __ver);
				const __mode = __diff.first ? "first-run" : (__diff.changes.length ? "upgrade" : "periodic");
				if (__mode !== "periodic" || Date.now() - anchorAuditAt > 60000) {
					anchorAuditAt = Date.now();
					setTimeout(() => run("anchors", () => auditAnchors(__mode)), 1500);
				}
			}
		}

		// ── DOM helper ─────────────────────────────────────────────────────

		function h(tag, attrs, children) {
			const el = document.createElement(tag);
			if (attrs) {
				for (const key of Object.keys(attrs)) {
					const value = attrs[key];
					if (value === null || value === undefined || value === false) continue;
					if (key === "class") el.className = value;
					else if (key === "text") el.textContent = value;
					else if (key === "style") el.style.cssText = value;
					else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
					else if (value === true) el.setAttribute(key, "");
					else el.setAttribute(key, String(value));
				}
			}
			if (children) {
				const list = Array.isArray(children) ? children : [children];
				for (const child of list) {
					if (child === null || child === undefined || child === false) continue;
					el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
				}
			}
			return el;
		}

		function toast(message) {
			let el = document.getElementById(TOAST_ID);
			if (!el) {
				el = h("div", { id: TOAST_ID });
				(document.body || document.documentElement).appendChild(el);
			}
			el.textContent = message;
			el.setAttribute("data-show", "true");
			if (el._timer) clearTimeout(el._timer);
			el._timer = setTimeout(() => el.setAttribute("data-show", "false"), 2200);
		}

		// ── settings drawer (native DOM) ───────────────────────────────────

		const PANEL_CSS = `
#dsh-skin-keymark-panel{position:fixed;top:var(--dsh-windows-titlebar-height,0px);right:0;bottom:0;width:100vw;max-width:100vw;z-index:2147483000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay,#1b1b1d);color:var(--dsw-alias-label-primary,#e9e9ec);border-left:0;box-shadow:-10px 0 34px rgba(0,0,0,.3);transform:translateX(102%);transition:transform .22s cubic-bezier(.4,0,.2,1);font-size:13px;line-height:1.5;box-sizing:border-box;-webkit-app-region:no-drag;pointer-events:auto}
#dsh-skin-keymark-panel[data-open="true"]{transform:translateX(0)}
/* The drawer floats over the window titlebar strip, which the shell marks as
   an app-region drag zone; without an explicit no-drag the panel is treated as
   window chrome and swallows clicks. Only darwin gets a framework-side guard
   for body-level nodes, so Windows needs this rule to stay clickable. */
#dsh-skin-keymark-panel, #dsh-skin-keymark-panel *{-webkit-app-region:no-drag;pointer-events:auto}
#dsh-skin-keymark-panel *{box-sizing:border-box}
#dsh-skin-keymark-panel .km-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));flex:0 0 auto}
#dsh-skin-keymark-panel .km-title{font-weight:600;font-size:14px}
#dsh-skin-keymark-panel .km-head-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}
#dsh-skin-keymark-panel .km-head-actions .km-mini{height:24px;padding:0 8px;font-size:11px;min-width:0}
/* 搜索栏：面板有 38+ 个控件、4 个分区，找一根滑条靠滚动是纯浪费。
   它不放进 .km-head —— 那里已经挤着「全部展开」和关闭键，标题会被压成
   省略号；单独一条 bar 也让它能在长列表滚动时保持可见（.km-body 是滚动
   容器，bar 在它外面，所以天然粘顶）。 */
#dsh-skin-keymark-panel .km-find{display:flex;align-items:center;gap:6px;padding:0 14px 9px;flex:0 0 auto}
#dsh-skin-keymark-panel .km-find input{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:inherit;font-size:12px;outline:none}
#dsh-skin-keymark-panel .km-find input:focus{border-color:var(--dsw-alias-brand-primary,#4c9aff)}
#dsh-skin-keymark-panel .km-find-count{flex:0 0 auto;font-size:11px;font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-tertiary,#8b8f96);white-space:nowrap}
/* 过滤用属性选择器，不用 inline style：inline 会和高亮/回读逻辑抢同一
   个 style 属性，而 dataset 谁都不会碰。 */
#dsh-skin-keymark-panel [data-km-hide="1"]{display:none !important}
#dsh-skin-keymark-panel .km-find-empty{padding:14px 2px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a6);line-height:1.6}
#dsh-skin-keymark-panel .km-x{width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer}
#dsh-skin-keymark-panel .km-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
#dsh-skin-keymark-panel .km-body{flex:1 1 auto;overflow-y:auto;padding:6px 14px 22px}
#dsh-skin-keymark-panel .km-sec{padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}
#dsh-skin-keymark-panel .km-sec:last-child{border-bottom:0}
/* Sub-heading used to break a long section into labelled groups. Without these
   the 壁纸 section alone is 20 controls in one unbroken column. */
#dsh-skin-keymark-panel .km-sub{margin:12px 0 6px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8b8f96);letter-spacing:.02em}
#dsh-skin-keymark-panel .km-sub:first-child{margin-top:0}
#dsh-skin-keymark-panel .km-sec-title{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;margin:0 0 8px;padding:2px 0;border:0;background:transparent;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9aa0a6);text-align:left}
#dsh-skin-keymark-panel .km-sec-title:hover{color:var(--dsw-alias-label-primary,#e9e9ec)}
#dsh-skin-keymark-panel .km-sec-chevron{font-size:10px;line-height:1;transition:transform .16s ease}
#dsh-skin-keymark-panel .km-sec[data-collapsed="true"] .km-sec-chevron{transform:rotate(-90deg)}
#dsh-skin-keymark-panel .km-sec[data-collapsed="true"] .km-sec-title{margin-bottom:0}
#dsh-skin-keymark-panel .km-sec[data-collapsed="true"] .km-sec-body{display:none}
#dsh-skin-keymark-panel .km-field{margin:7px 0}
#dsh-skin-keymark-panel .km-label{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
/* A slider's header keeps label + readout together on the left instead of
   pushing the number to the far edge, where it drifts 280px away from the
   control it describes. */
#dsh-skin-keymark-panel .km-field > .km-label{justify-content:flex-start;align-items:center}
#dsh-skin-keymark-panel .km-field > .km-label .km-label-text{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-skin-keymark-panel .km-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 0;min-height:24px}
#dsh-skin-keymark-panel .km-inline{display:flex;align-items:center;gap:8px}
#dsh-skin-keymark-panel .km-wrap{flex-wrap:wrap}
#dsh-skin-keymark-panel .km-input{flex:1 1 auto;min-width:0;height:28px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:inherit;font-size:12px;outline:none}
#dsh-skin-keymark-panel .km-input:focus{border-color:var(--dsw-alias-brand-primary,#4c9aff)}
/* 原生 <select> 展开后的候选列表由浏览器/OS 自己绘制，本插件的 .km-input
   只管收起态。把 --dsw-alias-bg-layer-2 压成 8% 半透明之后，弹层没有可
   合成的实心底色，Chrome 就退回平台默认的浅色 —— 浅底 + 浅色字，条目
   几乎读不出来（铺满/覆盖/包含/适应/拉伸 全糊成一片）。
   两条一起上：
   ① color-scheme 告诉浏览器这棵子树是深色还是浅色，连带弹层的底色、
      滚动条、选中高亮、边框一起跟着走；
   ② option 再显式给不透明底色与文字色 —— 弹层是独立绘制的，拿不到父级
      半透明背景的合成结果，只能自己给一个不透明值。
   浅色主题用 body 属性区分：宿主深色时带 data-ds-dark-theme。 */
#dsh-skin-keymark-panel{color-scheme:dark}
#dsh-skin-keymark-panel option{background-color:#1e1e21;color:#e8eaed}
#dsh-skin-keymark-panel option:checked{background-color:#2a3a52;color:#e8eaed}
body:not([data-ds-dark-theme]) #dsh-skin-keymark-panel{color-scheme:light}
body:not([data-ds-dark-theme]) #dsh-skin-keymark-panel option{background-color:#ffffff;color:#1a1c1f}
body:not([data-ds-dark-theme]) #dsh-skin-keymark-panel option:checked{background-color:#dbe7ff;color:#1a1c1f}
#dsh-skin-keymark-panel .km-mini{flex:0 1 auto;width:auto;min-width:64px}
/* Two labelled selects plus a button must share one 364px row, so the selects
   are allowed to shrink below the generic .km-mini floor. */
#dsh-skin-keymark-panel select.km-mini{min-width:0;flex:0 1 auto;width:auto}
#dsh-skin-keymark-panel .km-btn{height:28px;padding:0 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
#dsh-skin-keymark-panel .km-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}
#dsh-skin-keymark-panel .km-btn[data-active="true"]{border-color:var(--dsw-alias-brand-primary,#4c9aff);color:var(--dsw-alias-brand-primary,#4c9aff)}
#dsh-skin-keymark-panel .km-danger:hover{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}
/* Native range + checkbox: without accent-color they render in Chromium's
   default blue, which is the one colour on screen that ignores the skin. */
#dsh-skin-keymark-panel .km-range{width:100%;height:18px;margin:0;accent-color:var(--dsw-alias-brand-primary,#4c9aff);cursor:pointer}
#dsh-skin-keymark-panel input[type="checkbox"]{accent-color:var(--dsw-alias-brand-primary,#4c9aff);width:15px;height:15px;margin:0;cursor:pointer;flex:0 0 auto}
#dsh-skin-keymark-panel .km-num{width:46px;height:20px;padding:0 4px;border-radius:5px;border:1px solid transparent;background:transparent;color:inherit;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;text-align:right;outline:none;flex:0 0 auto}
#dsh-skin-keymark-panel .km-num:hover{border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.14))}
#dsh-skin-keymark-panel .km-num:focus{border-color:var(--dsw-alias-brand-primary,#4c9aff);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05))}
#dsh-skin-keymark-panel .km-label-text{cursor:default}
#dsh-skin-keymark-panel .km-label-text:hover{color:var(--dsw-alias-label-primary,#e9e9ec)}
#dsh-skin-keymark-panel .km-color{width:34px;height:30px;padding:2px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));border-radius:7px;background:transparent;cursor:pointer;flex:0 0 auto}
#dsh-skin-keymark-panel .km-accent-dot{width:22px;height:22px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.2));flex:0 0 auto}
#dsh-skin-keymark-panel .km-swatch{width:22px;height:22px;padding:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.2));cursor:pointer}
#dsh-skin-keymark-panel .km-swatch[data-active="true"]{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
#dsh-skin-keymark-panel .km-tabs{display:inline-flex;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06))}
#dsh-skin-keymark-panel .km-tab{height:26px;padding:0 14px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:12px;cursor:pointer}
#dsh-skin-keymark-panel .km-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#e9e9ec)}
#dsh-skin-keymark-panel .km-ta{width:100%;min-height:96px;padding:9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:inherit;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;resize:vertical;outline:none}
#dsh-skin-keymark-panel .km-ta-sm{min-height:64px;margin-top:8px}
#dsh-skin-keymark-panel .km-drop{margin-top:8px;padding:12px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l1,rgba(255,255,255,.18));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.03));color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:11px;text-align:center}
#dsh-skin-keymark-panel .km-drop[data-hot="true"]{border-color:var(--dsw-alias-brand-primary,#4c9aff);color:var(--dsw-alias-brand-primary,#4c9aff);background:var(--dsw-alias-bg-layer-1,rgba(76,154,255,.1))}
#dsh-skin-keymark-panel .km-readback{margin-top:6px;font-size:11px;font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary,#9aa0a6);line-height:1.5}
/* 体检失败的提示用状态色，但只染字不铺底：面板已经够花，再叠一块红色
   底色会把「哪一行写错了」这条信息本身埋掉。 */
#dsh-skin-keymark-panel .km-readback[data-bad="true"],#dsh-skin-keymark-panel .km-lint[data-bad="true"]{color:var(--dsw-alias-state-error-primary,#e5484d)}
#dsh-skin-keymark-panel .km-lint:empty{display:none}
/* 说明行（data-km-note）不是分组标题：不显示折叠箭头、不可点。 */
#dsh-skin-keymark-panel .km-sub[data-km-note="1"]{cursor:default;font-weight:400;opacity:.8}
/* 页签条：三段等宽，贴着搜索栏下沿。用 svg 式下划线指示当前页而不是
 * 给整块铺底 —— 面板已经有一层毛玻璃、一层分区底色，再加一块高亮块会
 * 变成三层叠色，深色主题下会糊成一片。 */
#dsh-skin-keymark-panel .km-tabbar{display:flex;gap:2px;margin:0 14px 2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));flex:0 0 auto}
#dsh-skin-keymark-panel .km-tabbar .km-tab{flex:1 1 0;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);font-family:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background .14s ease,color .14s ease}
#dsh-skin-keymark-panel .km-tabbar .km-tab:hover{color:var(--dsw-alias-label-primary,#e9e9ec)}
#dsh-skin-keymark-panel .km-tabbar .km-tab[data-active="true"]{background:var(--dsw-alias-bg-overlay,#1b1b1d);color:var(--dsw-alias-label-primary,#e9e9ec);box-shadow:0 1px 3px rgba(0,0,0,.28)}
/* 页签模式：只留当前页的分区。搜索一有字就整块退出（JS 摘掉
 * data-km-tabview），否则搜到的结果可能躲在别的页后面。 */
#dsh-skin-keymark-panel[data-km-tabview="on"] .km-sec[data-km-tabon="false"]{display:none}
/* 页签模式下的分区标题没用了（页签已经说了这是哪一页），留着只是重复。
 * 但「壁纸」这页有两个分区，标题仍是它们的区分，所以只压掉 padding。 */
#dsh-skin-keymark-panel[data-km-tabview="on"] .km-sec{padding-top:4px}
#dsh-skin-keymark-panel .km-tabbar:empty{display:none}
/* 设置页内嵌时不显示页签条：那里本来就是一整页长滚动，强行分页会让
 * 「设置里搜不到项」变成常态。 */
#dsh-skin-keymark-panel[data-hosted="true"] .km-tabbar{display:none}
#dsh-skin-keymark-panel[data-hosted="true"] .km-sec[data-km-tabon="false"]{display:block}
/* ── 视觉收口（0.1.22）──
 * 上面那些规则是逐版叠出来的，各自都合理，合在一起就出现了三种字号、
 * 两种分隔线强度和四套内边距。这一节只做减法：把垂直节奏统一成 6/12/18
 * 三档，去掉分区之间的实线（页签之后它们本来就不同时出现，线只是噪点），
 * 分区标题从小号大写广播降回正常大小写。
 * 放在最后、且选择器与前面同特异性，靠「后写者胜」覆盖，不改任何旧行。 */
#dsh-skin-keymark-panel .km-head{padding:11px 14px 8px;border-bottom:0}
#dsh-skin-keymark-panel .km-title{font-size:13px;font-weight:600;letter-spacing:.01em}
#dsh-skin-keymark-panel .km-find{padding:0 14px 8px}
#dsh-skin-keymark-panel .km-body{padding:2px 14px 24px}
#dsh-skin-keymark-panel .km-sec{padding:12px 0;border-bottom:0}
#dsh-skin-keymark-panel .km-sec + .km-sec{padding-top:2px}
#dsh-skin-keymark-panel .km-sec-title{text-transform:none;letter-spacing:.01em;font-size:12.5px;color:var(--dsw-alias-label-primary,#e9e9ec);opacity:.86;margin-bottom:6px}
#dsh-skin-keymark-panel .km-sec-title:hover{opacity:1}
#dsh-skin-keymark-panel .km-sec-chevron{opacity:.5}
#dsh-skin-keymark-panel .km-sub{margin:14px 0 6px;font-size:11px;font-weight:500;letter-spacing:.02em}
#dsh-skin-keymark-panel .km-sec-body > .km-sub:first-child{margin-top:2px}
#dsh-skin-keymark-panel .km-field{margin:6px 0}
#dsh-skin-keymark-panel .km-row{margin:7px 0}
#dsh-skin-keymark-panel .km-label{font-size:11.5px;margin-bottom:3px}
#dsh-skin-keymark-panel .km-range{height:16px}
/* 分区之间的呼吸靠留白，不再靠满宽的实线；保留一条极淡的分隔只用于
 * 「同一页里确有两个分区」（壁纸 / 素材库）这一种情况。 */
#dsh-skin-keymark-panel[data-km-tabview="on"] .km-sec + .km-sec{padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
#dsh-skin-keymark-panel .km-btn{font-weight:500}
#dsh-skin-keymark-panel .km-ta{min-height:88px}
#dsh-skin-keymark-panel .km-lib{display:flex;flex-direction:column;gap:6px}
#dsh-skin-keymark-panel .km-recent{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
#dsh-skin-keymark-panel .km-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;height:24px;padding:0 9px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:11px;cursor:pointer;white-space:nowrap;overflow:hidden}
#dsh-skin-keymark-panel .km-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,#e9e9ec)}
#dsh-skin-keymark-panel .km-chip[data-active="true"]{border-color:var(--dsw-alias-brand-primary,#4c9aff);color:var(--dsw-alias-brand-primary,#4c9aff)}
#dsh-skin-keymark-panel .km-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#6b7280);flex:0 0 auto}
#dsh-skin-keymark-panel .km-chip-dot[data-video="true"]{background:var(--dsw-alias-brand-primary,#4c9aff)}
#dsh-skin-keymark-panel .km-lib-empty{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
#dsh-skin-keymark-panel .km-lib-item{display:flex;align-items:center;gap:8px}
#dsh-skin-keymark-panel .km-thumb{width:46px;height:30px;object-fit:cover;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));flex:0 0 auto}
#dsh-skin-keymark-panel .km-lib-meta{flex:1 1 auto;min-width:0}
#dsh-skin-keymark-panel .km-lib-name{font-size:11px;font-family:var(--ds-font-family-code,ui-monospace,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dsh-skin-keymark-panel .km-lib-size{font-size:10px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
#dsh-skin-keymark-panel .km-hidden{display:none}
#dsh-skin-keymark-toast{position:fixed;left:50%;bottom:46px;transform:translateX(-50%) translateY(10px);opacity:0;pointer-events:none;z-index:2147483001;padding:8px 14px;border-radius:9px;background:var(--dsw-alias-bg-overlay,#1b1b1d);color:var(--dsw-alias-label-primary,#e9e9ec);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:0 8px 26px rgba(0,0,0,.32);font-size:12px;transition:opacity .2s,transform .2s}
#dsh-skin-keymark-toast[data-show="true"]{opacity:1;transform:translateX(-50%) translateY(0)}
/* ── 分区内分组折叠（0.1.23）──
 * 页签只把「背景 / 外观 / 高级」拆开，壁纸这一节自己还有 1600px。
 * 这里把每个 .km-sub 升级成可点的组标题：点一下收起它到下一个标题之间的
 * 全部行。折叠不搬节点、只打属性 —— 搜索索引按 .km-field/.km-row 抓单元，
 * 搬进 <details> 之类会让索引和真实可见性对不上。 */
#dsh-skin-keymark-panel .km-sub{align-items:center;gap:6px;cursor:pointer;user-select:none;border-radius:6px;padding:2px 0}
#dsh-skin-keymark-panel .km-sub[data-km-grphead="1"]{display:flex;justify-content:space-between;transition:color .12s ease}
#dsh-skin-keymark-panel .km-sub[data-km-grphead="1"]:hover{color:var(--dsw-alias-label-primary,#e9e9ec)}
#dsh-skin-keymark-panel .km-sub:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c9aff);outline-offset:2px}
#dsh-skin-keymark-panel .km-grpchev{font-size:9px;line-height:1;opacity:.55;transition:transform .16s ease;flex:0 0 auto}
#dsh-skin-keymark-panel .km-sub[data-km-grpfold="true"] .km-grpchev{transform:rotate(-90deg)}
/* 折叠态只隐藏成员本身，标题永远留着 —— 否则收起后再也点不回来。 */
#dsh-skin-keymark-panel [data-km-grphide="1"]{display:none !important}
/* 宿主内嵌态。面板是同一棵 DOM：独立打开时是右侧抽屉，被设置页
   接走后（data-hosted="true"）必须把自己退化成一块普通内容 —— 否则
   它的 position:fixed / translateX(102%) / z-index 会直接在设置页里
   重新画一个抽屉出来。头部（标题 + 关闭）由设置页自己提供，藏掉。 */
#dsh-skin-keymark-panel[data-hosted="true"]{position:static;top:auto;right:auto;bottom:auto;left:auto;width:auto;max-width:none;height:auto;max-height:none;z-index:auto;transform:none;transition:none;border:0;border-radius:0;box-shadow:none;background:transparent;overflow:visible}
#dsh-skin-keymark-panel[data-hosted="true"] .km-head{display:none}
#dsh-skin-keymark-panel[data-hosted="true"] .km-body{overflow:visible;padding:0 0 4px}
#dsh-skin-keymark-panel[data-hosted="true"] .km-sub:first-child{margin-top:0}
/* ── 设计系统重写（0.1.24）──
 * 上一版是「一行一条规则」长出来的，样式都对、但没有体系：三种字号、
 * 五套圆角、九个硬编码 rgba、控件 28px 高（鼠标能点、手指点不到）。
 * 这一节不再逐条修补，而是先立一组令牌，再把每个部件按令牌重画一遍。
 *
 * 令牌来源：宿主设置页的 --dsh-settings-*（存在则用，不存在回落到本插件
 * 旧的 --dsw-alias-*）。这样深浅色由宿主统一切换，插件不再自己判断明暗，
 * 也不必为每个部件写两套值。
 *
 * 尺度（照同一生态里的成熟设置页取的）：控件最小高度 36px（抽屉 364px 宽，
 * 44px 会让一排只剩两个按钮）、圆角分三级 14/10/6、动效 180ms 变色 /
 * 240ms 位移、按压一律 scale(.96)。
 *
 * 全部规则都排在本节的最后位置，选择器与旧规则同特异性 —— 靠「后写者胜」
 * 覆盖，不改任何一条旧行，回滚只需删掉本节。 */
#dsh-skin-keymark-panel{
  --km-surface:var(--dsh-settings-surface,var(--dsw-alias-bg-overlay,#1b1b1d));
  --km-subtle:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));
  --km-border:var(--dsh-settings-border,var(--dsw-alias-border-l1,rgba(255,255,255,.14)));
  --km-text:var(--dsh-settings-text,var(--dsw-alias-label-primary,#e9e9ec));
  --km-muted:var(--dsh-settings-secondary,var(--dsw-alias-label-secondary,#9aa0a6));
  --km-faint:var(--dsw-alias-label-tertiary,#8b8f96);
  --km-accent:var(--dsh-settings-accent,var(--dsw-alias-brand-primary,#4c9aff));
  --km-card:color-mix(in srgb,var(--km-surface) 74%,transparent);
  --km-hover:color-mix(in srgb,var(--km-text) 8%,transparent);
  --km-r-card:14px;
  --km-r-ctrl:10px;
  --km-r-tiny:6px;
  --km-h-ctrl:36px;
  --km-t-color:180ms;
  --km-t-move:240ms;
  --km-ease:cubic-bezier(.2,.8,.2,1);
  font:400 13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
  color:var(--km-text);
  background:color-mix(in srgb,var(--km-surface) 86%,transparent);
  border-left:0;
  border-radius:0;
  box-shadow:-18px 0 48px rgba(0,0,0,.34);
}
body[data-ds-dark-theme] #dsh-skin-keymark-panel{
  --km-card:color-mix(in srgb,var(--km-surface) 68%,transparent);
  --km-hover:color-mix(in srgb,var(--km-text) 10%,transparent);
  box-shadow:-18px 0 48px rgba(0,0,0,.5);
}
/* 头部：标题 + 三个动作按钮，底部一条极淡分线。 */
#dsh-skin-keymark-panel .km-head{padding:14px 14px 10px;border-bottom:1px solid var(--km-border);gap:8px}
#dsh-skin-keymark-panel .km-title{font:650 14px/1.4 system-ui,sans-serif;letter-spacing:-.01em;color:var(--km-text)}
#dsh-skin-keymark-panel .km-head-actions .km-mini{min-height:28px;height:28px;padding:0 10px;font-size:11.5px;border-radius:8px}
#dsh-skin-keymark-panel .km-x{width:28px;height:28px;border-radius:8px;font-size:17px;color:var(--km-muted);transition:background-color var(--km-t-color),color var(--km-t-color),transform var(--km-t-move) var(--km-ease)}
#dsh-skin-keymark-panel .km-x:hover{background:var(--km-hover);color:var(--km-text)}
#dsh-skin-keymark-panel .km-x:active{transform:scale(.94)}
/* 搜索：带放大镜留位，聚焦时一圈柔光而不是只换边框色。 */
#dsh-skin-keymark-panel .km-find{padding:10px 14px 8px;gap:8px}
#dsh-skin-keymark-panel .km-find input{height:var(--km-h-ctrl);padding:0 12px;border-radius:var(--km-r-ctrl);border:1px solid var(--km-border);background:var(--km-subtle);color:var(--km-text);font:13px/1 system-ui,sans-serif;transition:border-color var(--km-t-color),box-shadow var(--km-t-color)}
#dsh-skin-keymark-panel .km-find input::placeholder{color:var(--km-muted);opacity:.7}
#dsh-skin-keymark-panel .km-find input:focus{border-color:var(--km-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--km-accent) 24%,transparent)}
#dsh-skin-keymark-panel .km-find-count{font-size:11px;color:var(--km-faint)}
/* 页签条：分段控件。选中项抬一层底色 + 一层阴影，不整块反色。 */
#dsh-skin-keymark-panel .km-tabbar{margin:0 14px 6px;padding:4px;gap:2px;border:1px solid var(--km-border);border-radius:12px;background:var(--km-subtle)}
#dsh-skin-keymark-panel .km-tabbar .km-tab{height:32px;border-radius:9px;color:var(--km-muted);font:500 12.5px/1 system-ui,sans-serif;transition:background-color var(--km-t-color),color var(--km-t-color),box-shadow var(--km-t-color),transform var(--km-t-move) var(--km-ease)}
#dsh-skin-keymark-panel .km-tabbar .km-tab:hover{background:var(--km-hover);color:var(--km-text)}
#dsh-skin-keymark-panel .km-tabbar .km-tab[data-active="true"]{background:var(--km-surface);color:var(--km-text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.12)}
#dsh-skin-keymark-panel .km-tabbar .km-tab:active{transform:scale(.96)}
/* 主体：分区改成卡片，卡片之间靠 10px 间距分开，不再靠分隔线。 */
#dsh-skin-keymark-panel .km-body{padding:10px 12px 22px;display:flex;flex-direction:column;gap:10px}
#dsh-skin-keymark-panel .km-sec{padding:14px;border:1px solid var(--km-border);border-radius:var(--km-r-card);background:var(--km-card);margin:0}
#dsh-skin-keymark-panel .km-sec + .km-sec{margin:0;padding-top:14px;border-top:1px solid var(--km-border)}
#dsh-skin-keymark-panel[data-km-tabview="on"] .km-sec{padding:14px}
#dsh-skin-keymark-panel[data-km-tabview="on"] .km-sec + .km-sec{padding-top:14px;border-top:1px solid var(--km-border)}
#dsh-skin-keymark-panel .km-sec-title{margin:0 0 10px;padding:0;font:650 13.5px/1.4 system-ui,sans-serif;color:var(--km-text);opacity:1;letter-spacing:-.01em;transition:color var(--km-t-color)}
#dsh-skin-keymark-panel .km-sec-title:hover{color:var(--km-accent);opacity:1}
/* 折叠箭头：不再用 ▾ 这个字形（9px 下会糊成一个点，且各平台字形宽度不
 * 一样）。改成两个像素边框拼的方角 + rotate(45deg) —— 任意缩放都是清晰
 * 的两条线。文字用 font-size:0 藏掉，保留 DOM 不动。
 * 展开 = 旋转 45°（朝下）；收起沿用旧规则的 rotate(-90deg)，自动变成朝右。 */
#dsh-skin-keymark-panel .km-sec-chevron,
#dsh-skin-keymark-panel .km-grpchev{
  font-size:0;line-height:0;
  width:5px;height:5px;min-width:5px;
  border-right:1.5px solid currentColor;
  border-bottom:1.5px solid currentColor;
  border-radius:1px;
  transform:rotate(45deg);
  transform-origin:50% 50%;
  opacity:.55;flex:0 0 auto;
  margin-right:3px;
  transition:transform .16s ease,opacity .18s ease,border-color .18s ease;
}
#dsh-skin-keymark-panel .km-sec-title:hover .km-sec-chevron,
#dsh-skin-keymark-panel .km-sub[data-km-grphead="1"]:hover .km-grpchev{opacity:.9}
/* 折叠态必须在这里重新声明：旧规则（.km-sec[data-collapsed="true"] .km-sec-chevron
 * 与 .km-sub[data-km-grpfold="true"] .km-grpchev）特异性比上面这条高，靠
 * 后写者胜压不住 —— 它们会把 45° 再转 -90°，两条边框拼出的箭头就成了一个
 * 角标。这里用同等特异性重写：收起 = 45° - 90° = -45°（朝右）。 */
#dsh-skin-keymark-panel .km-sec[data-collapsed="true"] .km-sec-chevron,
#dsh-skin-keymark-panel .km-sub[data-km-grpfold="true"] .km-grpchev{transform:rotate(-45deg);opacity:.55}
/* 分组小标题：全大写广播感去掉，改成紧凑的栏目名。 */
#dsh-skin-keymark-panel .km-sub{margin:14px 0 8px;padding:0;font:600 11.5px/1.4 system-ui,sans-serif;color:var(--km-muted);letter-spacing:.01em;border-radius:var(--km-r-tiny)}
#dsh-skin-keymark-panel .km-sub[data-km-grphead="1"]{padding:4px 6px;margin:14px -6px 8px;transition:background-color var(--km-t-color),color var(--km-t-color)}
#dsh-skin-keymark-panel .km-sub[data-km-grphead="1"]:hover{background:var(--km-hover);color:var(--km-text)}
#dsh-skin-keymark-panel .km-sec-body > .km-sub:first-child{margin-top:2px}
/* 这里只调透明度：早前版本给 .km-grpchev 写过 font-size:9px，本行若再写一次
 * 字号，就会把上面 6997 那个 font-size:0 盖回去 —— ▾ 字形重新出现，和两条
 * 边框拼出的箭头叠在一起（截图里那个「斜的小三角」）。 */
#dsh-skin-keymark-panel .km-grpchev{opacity:.5}
/* 行与标签。 */
#dsh-skin-keymark-panel .km-field{margin:10px 0}
#dsh-skin-keymark-panel .km-row{margin:8px 0;min-height:32px;gap:12px}
#dsh-skin-keymark-panel .km-label{margin-bottom:5px;font:400 12.5px/1.4 system-ui,sans-serif;color:var(--km-muted);gap:10px}
#dsh-skin-keymark-panel .km-label-text{color:var(--km-muted)}
#dsh-skin-keymark-panel .km-label-text:hover{color:var(--km-text)}
#dsh-skin-keymark-panel .km-inline{gap:8px}
/* 输入类：统一 36px 高、10px 圆角、聚焦柔光。 */
#dsh-skin-keymark-panel .km-input{height:var(--km-h-ctrl);padding:0 12px;border-radius:var(--km-r-ctrl);border:1px solid var(--km-border);background:var(--km-subtle);color:var(--km-text);font:13px/1 system-ui,sans-serif;transition:border-color var(--km-t-color),box-shadow var(--km-t-color)}
#dsh-skin-keymark-panel .km-input:focus{border-color:var(--km-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--km-accent) 24%,transparent)}
#dsh-skin-keymark-panel .km-ta{padding:10px 12px;border-radius:var(--km-r-ctrl);border:1px solid var(--km-border);background:var(--km-subtle);color:var(--km-text);font:11.5px/1.6 var(--ds-font-family-code,ui-monospace,monospace);min-height:96px;transition:border-color var(--km-t-color),box-shadow var(--km-t-color)}
#dsh-skin-keymark-panel .km-ta:focus{border-color:var(--km-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--km-accent) 24%,transparent)}
#dsh-skin-keymark-panel .km-readback{margin-top:8px;font:11.5px/1.6 var(--ds-font-family-code,ui-monospace,monospace);color:var(--km-muted)}
#dsh-skin-keymark-panel .km-readback[data-bad="true"],#dsh-skin-keymark-panel .km-lint[data-bad="true"]{color:var(--dsw-alias-state-error-primary,#e5484d)}
/* 按钮：三档（默认 / 选中 / 危险），一律给按压反馈。 */
#dsh-skin-keymark-panel .km-btn{min-height:var(--km-h-ctrl);height:auto;padding:0 13px;border-radius:var(--km-r-ctrl);border:1px solid var(--km-border);background:var(--km-surface);color:var(--km-text);font:500 12.5px/1 system-ui,sans-serif;transition:background-color var(--km-t-color),border-color var(--km-t-color),color var(--km-t-color),transform var(--km-t-move) var(--km-ease)}
#dsh-skin-keymark-panel .km-btn:hover{background:var(--km-subtle);border-color:var(--km-accent)}
#dsh-skin-keymark-panel .km-btn:active{transform:scale(.96)}
#dsh-skin-keymark-panel .km-btn:focus-visible{outline:2px solid var(--km-accent);outline-offset:2px}
#dsh-skin-keymark-panel .km-btn[data-active="true"]{border-color:var(--km-accent);color:var(--km-accent);background:color-mix(in srgb,var(--km-accent) 14%,transparent)}
#dsh-skin-keymark-panel .km-btn[disabled],#dsh-skin-keymark-panel .km-btn:disabled{opacity:.45;cursor:default}
#dsh-skin-keymark-panel .km-danger:hover{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 12%,transparent)}
#dsh-skin-keymark-panel select.km-mini{height:var(--km-h-ctrl);padding:0 8px;border-radius:var(--km-r-ctrl);border:1px solid var(--km-border);background:var(--km-subtle);color:var(--km-text);font:12.5px/1 system-ui,sans-serif}
#dsh-skin-keymark-panel .km-mini{min-height:var(--km-h-ctrl)}
/* 开关：原生 checkbox 换成滑块。用 background-position 挪白点，而不是
 * ::after —— input 是替换元素，Chromium 不渲染它上面的伪元素。 */
#dsh-skin-keymark-panel input[type="checkbox"]{
  appearance:none;-webkit-appearance:none;
  width:40px;height:23px;min-width:40px;margin:0;
  border-radius:999px;border:1px solid var(--km-border);
  background-color:rgba(120,120,128,.32);
  background-image:radial-gradient(circle at center,#fff 0 9px,rgba(255,255,255,0) 9.5px);
  background-size:19px 19px;background-repeat:no-repeat;background-position:1px center;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.12);
  cursor:pointer;flex:0 0 auto;
  transition:background-color var(--km-t-color),background-position var(--km-t-move) var(--km-ease),box-shadow var(--km-t-color),transform var(--km-t-move) var(--km-ease);
}
#dsh-skin-keymark-panel input[type="checkbox"]:checked{background-color:var(--km-accent);background-position:19px center;border-color:transparent;box-shadow:0 0 12px color-mix(in srgb,var(--km-accent) 30%,transparent)}
#dsh-skin-keymark-panel input[type="checkbox"]:active{transform:scale(.95)}
#dsh-skin-keymark-panel input[type="checkbox"]:focus-visible{outline:2px solid var(--km-accent);outline-offset:3px}
#dsh-skin-keymark-panel input[type="checkbox"]:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
/* 滑条：自绘轨道 + 白色圆钮，比 Chromium 默认的方块钮轻。 */
#dsh-skin-keymark-panel input[type="range"]{appearance:none;-webkit-appearance:none;width:100%;height:20px;margin:0;background:transparent;cursor:pointer}
#dsh-skin-keymark-panel input[type="range"]::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:rgba(120,120,128,.3)}
#dsh-skin-keymark-panel input[type="range"]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:16px;height:16px;margin-top:-5px;border-radius:50%;background:#fff;border:1px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.26),0 2px 6px rgba(0,0,0,.14);transition:transform var(--km-t-move) var(--km-ease)}
#dsh-skin-keymark-panel input[type="range"]:active::-webkit-slider-thumb{transform:scale(1.12)}
#dsh-skin-keymark-panel input[type="range"]:focus-visible{outline:2px solid var(--km-accent);outline-offset:3px;border-radius:var(--km-r-tiny)}
#dsh-skin-keymark-panel .km-num{width:50px;height:22px;border-radius:var(--km-r-tiny);font:11.5px/1 var(--ds-font-family-code,ui-monospace,monospace);color:var(--km-muted);transition:color var(--km-t-color),border-color var(--km-t-color),background-color var(--km-t-color)}
#dsh-skin-keymark-panel .km-num:hover{border-color:var(--km-border);color:var(--km-text)}
#dsh-skin-keymark-panel .km-num:focus{border-color:var(--km-accent);background:var(--km-subtle);color:var(--km-text)}
/* 色块与胶囊。 */
#dsh-skin-keymark-panel .km-color{width:40px;height:var(--km-h-ctrl);padding:3px;border-radius:var(--km-r-ctrl);border:1px solid var(--km-border);transition:border-color var(--km-t-color),transform var(--km-t-move) var(--km-ease)}
#dsh-skin-keymark-panel .km-color:active{transform:scale(.96)}
#dsh-skin-keymark-panel .km-accent-dot{width:24px;height:24px;border:2px solid var(--km-border)}
#dsh-skin-keymark-panel .km-swatch{width:24px;height:24px;border:1px solid var(--km-border);transition:transform var(--km-t-move) var(--km-ease),box-shadow var(--km-t-color)}
#dsh-skin-keymark-panel .km-swatch:hover{transform:scale(1.1)}
#dsh-skin-keymark-panel .km-swatch[data-active="true"]{outline:2px solid var(--km-accent);outline-offset:2px}
#dsh-skin-keymark-panel .km-chip{height:28px;padding:0 11px;border-radius:999px;border:1px solid var(--km-border);background:var(--km-surface);color:var(--km-muted);font:500 11.5px/1 system-ui,sans-serif;transition:background-color var(--km-t-color),border-color var(--km-t-color),color var(--km-t-color),transform var(--km-t-move) var(--km-ease)}
#dsh-skin-keymark-panel .km-chip:hover{background:var(--km-subtle);color:var(--km-text);border-color:var(--km-accent)}
#dsh-skin-keymark-panel .km-chip:active{transform:scale(.96)}
#dsh-skin-keymark-panel .km-chip[data-active="true"]{border-color:var(--km-accent);color:var(--km-accent);background:color-mix(in srgb,var(--km-accent) 14%,transparent)}
/* 素材列表与拖放区。 */
#dsh-skin-keymark-panel .km-lib{gap:8px}
#dsh-skin-keymark-panel .km-lib-item{padding:6px;border:1px solid var(--km-border);border-radius:var(--km-r-ctrl);background:var(--km-surface);transition:border-color var(--km-t-color),background-color var(--km-t-color)}
#dsh-skin-keymark-panel .km-lib-item:hover{border-color:var(--km-accent);background:var(--km-subtle)}
#dsh-skin-keymark-panel .km-thumb{width:52px;height:34px;border-radius:var(--km-r-tiny)}
#dsh-skin-keymark-panel .km-lib-name{font-size:11.5px}
#dsh-skin-keymark-panel .km-drop{margin-top:10px;padding:16px 12px;border-radius:var(--km-r-ctrl);border:1px dashed var(--km-border);background:var(--km-subtle);color:var(--km-muted);font:12px/1.5 system-ui,sans-serif;transition:border-color var(--km-t-color),background-color var(--km-t-color),color var(--km-t-color)}
#dsh-skin-keymark-panel .km-drop[data-hot="true"]{border-color:var(--km-accent);color:var(--km-accent);background:color-mix(in srgb,var(--km-accent) 12%,transparent)}
/* 内嵌进设置页时不该再带卡片边框 —— 宿主自己已经有卡了，两层框会显得脏。 */
#dsh-skin-keymark-panel[data-hosted="true"]{border-radius:0;border:0;box-shadow:none;background:transparent}
#dsh-skin-keymark-panel[data-hosted="true"] .km-body{padding:0;gap:0}
#dsh-skin-keymark-panel[data-hosted="true"] .km-sec{padding:14px 0;border:0;border-radius:0;background:transparent}
#dsh-skin-keymark-panel[data-hosted="true"] .km-sec + .km-sec{border-top:1px solid var(--km-border)}
/* 无障碍：两个降级与 ui-beautify 同口径 —— 减动效、强制色。 */
@media(prefers-reduced-motion:reduce){
  #dsh-skin-keymark-panel *{transition-duration:0ms !important;animation-duration:0ms !important}
  #dsh-skin-keymark-panel .km-btn:active,#dsh-skin-keymark-panel .km-chip:active,#dsh-skin-keymark-panel .km-tabbar .km-tab:active,#dsh-skin-keymark-panel input[type="checkbox"]:active,#dsh-skin-keymark-panel .km-x:active{transform:none}
}
@media(forced-colors:active){
  #dsh-skin-keymark-panel .km-sec,#dsh-skin-keymark-panel .km-btn,#dsh-skin-keymark-panel .km-input,#dsh-skin-keymark-panel .km-ta,#dsh-skin-keymark-panel .km-lib-item{border-color:CanvasText}

  #dsh-skin-keymark-panel .km-btn[data-active="true"],#dsh-skin-keymark-panel .km-chip[data-active="true"]{outline:2px solid Highlight;outline-offset:-2px}
  #dsh-skin-keymark-panel input[type="checkbox"]:checked{background-color:Highlight}
}

/* ── 2026-11-21 抽屉玻璃化（去黑边 / 提亮副文字）─────────────────────
 * 三个问题同源：抽屉根背景写的是 var(--dsw-alias-bg-overlay)，深色主题下
 * 那是 #111112 这类不透明近黑；再加 box-shadow 左侧 -10px 的黑色扩散，就
 * 成了用户说的「一直在的黑线」；而 --km-muted 回落到 --dsw-alias-label-
 * secondary，小字号（11.5px）压在这层近黑上就发灰。
 * 处置：根背景改用与浮层同一套地板变量 --km-float-fill（毛玻璃下限 0.62，
 * 保证文字永远有底），左边框与阴影一并换成亮边；副文字不再依赖主题令牌，
 * 改为按主文字色做 color-mix 降档，任何主题下都保持同一对比度。
 * 全部写在 PANEL_CSS 末尾，同特异性后写者胜，删掉本节即回滚。 */
#dsh-skin-keymark-panel{
  --km-hairline:rgba(255,255,255,.16);
  --km-surface:var(--dsh-settings-surface,var(--km-layer-2,rgba(255,255,255,.06)));
  --km-border:var(--dsh-settings-border,var(--km-hairline,rgba(255,255,255,.16)));
  --km-text:var(--dsh-settings-text,var(--dsw-alias-label-primary,#eef2f8));
  /* 面板内部有 10 处直接写 var(--dsw-alias-label-secondary,#9aa0a6)，绕过
     --km-muted；就地改写这几个 label 令牌，等于一次性把它们全部提亮，
     且作用域锁在抽屉内，正文与侧栏不受影响。 */
  --dsw-alias-label-secondary:color-mix(in srgb,var(--dsw-alias-label-primary,#eef2f8) 88%,transparent);
  --dsw-alias-label-tertiary:color-mix(in srgb,var(--dsw-alias-label-primary,#eef2f8) 74%,transparent);
  --dsw-alias-label-caption:color-mix(in srgb,var(--dsw-alias-label-primary,#eef2f8) 78%,transparent);
  --dsw-alias-label-dimmed:color-mix(in srgb,var(--dsw-alias-label-primary,#eef2f8) 58%,transparent);
  --km-muted:var(--dsh-settings-secondary,color-mix(in srgb,var(--dsw-alias-label-primary,#eef2f8) 88%,transparent));
  --km-faint:var(--dsh-settings-tertiary,color-mix(in srgb,var(--dsw-alias-label-primary,#eef2f8) 72%,transparent));
  /* 2026-11-21 抽屉里的分区卡片原来吃 --dsw-alias-bg-layer-2，深色主题下
     算出来是 rgba(22,22,22,.20) 的近黑，在亮壁纸上一块块发黑。抽屉内改成
     白色系半透明，必须写在本规则块最后，否则被上面的 --km-surface 覆盖。 */
  --km-surface:color-mix(in srgb,#ffffff 11%,transparent);
  --km-subtle:color-mix(in srgb,#ffffff 9%,transparent);
  --km-card:color-mix(in srgb,#ffffff 5%,transparent);
  /* 2026-11-23 换成原生材质（用户 m03445：要么跟通用设置那样，要么跟模型下拉那样）。
     实测 modern-ui 的模型下拉是两层叠出来的：
       .cLp10W_surface  background:transparent; box-shadow:
         rgba(255,255,255,.10) 0 0 0 1px,      ← 1px 白描边
         rgba(255,255,255,.08) 0 1px 0 0 inset, ← 顶部内亮线
         rgba(0,0,0,.25) 0 2px 6px -1px,        ← 近投影
         rgba(0,0,0,.44) 0 12px 32px -8px       ← 远投影
       .cLp10W_material background-color:rgba(22,22,22,0.72);  ← 唯一的实底
     抽屉只有一个元素，把两层合成一条：底色写在 background，描边与投影写在
     box-shadow。0.72 的近实底正好压掉背后的壁纸暗部（就是用户说的「黑布」观感
     其实是壁纸透出来的），又保留一点点透。不再用 backdrop-filter：原生没用它，
     加了反而把壁纸糊成一块灰雾。
     ui.glass.blur=0 时 applyAcrylic 会清掉 inline 的 background/backdrop-filter，
     所以这条兜底值必须自带底色；滑条 >0 时 inline 覆盖它。 */
  /* 2026-11-23 用户 m04002「还是有黑边 背景还是有灰色的部分 不是透明的」。
     面板自己不再铺任何颜色 —— 通用设置页也是这个做法（.acoR2W_panel 的
     background 就是 rgba(0,0,0,0)，颜色全部由内层卡片各自提供）。
     只挂一层 backdrop 模糊：壁纸的颜色透进来（就是用户说的「背景的模糊色」），
     背后的对话文字被糊成不可认的团块，不会隔着面板读出内容。
     ui.glass.blur=0 时 applyAcrylic 会清掉 inline 的 background/backdrop-filter，
     所以这条兜底值必须能单独站住；滑条 >0 时 inline 覆盖它。 */
  background:var(--km-panel-solid,transparent);
  backdrop-filter:blur(40px) saturate(1.2) brightness(1.25);
  -webkit-backdrop-filter:blur(40px) saturate(1.2) brightness(1.25);
  border-left:0;
  /* 2026-11-24 用户 m04568「两边还是有方框的线 像有一个长方形围着」：
     两条 inset 就是那圈线 —— inset 0 0 0 1px 沿四边画白线、inset 0 1px 0 0 再补顶部亮线。
     面板底已经不透明，靠底色本身就能和画布分开，不需要描边；只留左侧柔和外投影。 */
  box-shadow:none;
}
/* 深色主题那条更强的黑投影（-18px 0 48px rgba(0,0,0,.5)）特异性比单 id 更高，
   只写上面那节压不住它 —— 这就是「一直在的黑线」。这里用同等特异性重写。 */
body[data-ds-dark-theme] #dsh-skin-keymark-panel,
body[data-ds-dark-theme] #dsh-skin-keymark-panel[data-open="true"]{
  /* 2026-11-24 用户 m04568「两边还是有方框的线 像有一个长方形围着」：
     两条 inset 就是那圈线 —— inset 0 0 0 1px 沿四边画白线、inset 0 1px 0 0 再补顶部亮线。
     面板底已经不透明，靠底色本身就能和画布分开，不需要描边；只留左侧柔和外投影。 */
  box-shadow:none;
}
/* 分区标题与小字副标题：11.5px 600 在暗底上本来就吃力，抬到 12px 并给
   一层 1px 的深色描边阴影，壁纸透进来时也不会被吃掉。 */
#dsh-skin-keymark-panel .km-sec,
#dsh-skin-keymark-panel .km-sub,
#dsh-skin-keymark-panel .km-find-count,
#dsh-skin-keymark-panel .km-find-empty{
  color:var(--km-muted);
  text-shadow:var(--km-text-shadow);
}
#dsh-skin-keymark-panel .km-sec,#dsh-skin-keymark-panel .km-sub{font-size:12px}
/* 输入框占位符：只有搜索框写了 ::placeholder，其余 input/textarea 吃浏览器
   默认色（深底上几乎看不见）。统一提亮，且不影响用户已输入的值。 */
#dsh-skin-keymark-panel .km-input::placeholder,
#dsh-skin-keymark-panel .km-ta::placeholder,
#dsh-skin-keymark-panel .km-mini::placeholder{
  color:var(--km-muted);
  opacity:.78;
}
/* 滚动条：默认在深底上是一条几乎全黑的竖线，抽屉贴右边缘时它正好压在
   边框旁，看着就像「一直在的黑线」。改成半透明浅色细条。 */
#dsh-skin-keymark-panel .km-body{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.26) transparent}
  /* 2026-11-22 用户 m02899「两边的宽度扩大一点 贴近左右两边的文字边界」：
     取消上一版的 980px 内容列限宽，让表单/分区卡铺到面板左右边缘（仅留 14px 内边距）。*/
  /* 2026-11-22 用户 m02933「左边文字贴近左边的拖动栏 右边的边缘贴近右边的拖动栏」：
     再去一层 —— body 左右归零，分区卡只留 6px 内衬，卡片本身贴到面板可视边缘；
     右侧那条竖条是滚动条，用 padding-right:8px 为它让位，免得文字被压在滑块底下。*/
  #dsh-skin-keymark-panel .km-body{width:100%!important;max-width:none!important;margin:0!important;padding-left:0!important;padding-right:0!important;scrollbar-gutter:auto}
  #dsh-skin-keymark-panel .km-head{width:100%!important;max-width:none!important;margin:0!important;padding-left:8px!important;padding-right:8px!important}
  #dsh-skin-keymark-panel .km-find{padding-left:8px!important;padding-right:8px!important}
  /* 2026-11-22 用户 m02965「为什么还会有明显的留空」的定案：
     上一版这四条没写 !important，被 tabview 态下特异性更高的规则
     （#dsh-skin-keymark-panel 带 data-km-tabview 属性 + .km-sec，特异性多一级）
     压回 14px。这里全部改为 !important，并给 tab 条也收边，
     否则它仍留 14px 外边距。注意：本段位于模板字符串内，注释里禁止出现反引号。*/
  #dsh-skin-keymark-panel .km-sec{padding-left:6px!important;padding-right:6px!important}
  #dsh-skin-keymark-panel[data-km-tabview="on"] .km-sec{padding-left:6px!important;padding-right:6px!important}
  #dsh-skin-keymark-panel .km-tabbar{margin-left:8px!important;margin-right:8px!important}
#dsh-skin-keymark-panel .km-body::-webkit-scrollbar{width:8px}
#dsh-skin-keymark-panel .km-body::-webkit-scrollbar-track{background:transparent}
#dsh-skin-keymark-panel .km-body::-webkit-scrollbar-thumb{background-color:rgba(255,255,255,.24);border-radius:999px;border:2px solid transparent;background-clip:content-box}
#dsh-skin-keymark-panel .km-body::-webkit-scrollbar-thumb:hover{background-color:rgba(255,255,255,.38)}

/* 2026-11-24 用户 m04459「文字给我弄清晰了」：抽屉底现在是 brightness(1.25) 的亮糊，
   原来的近白文字（oklch .968）压在上面几乎看不见。这里把抽屉内的文字、辅助字、
   卡片与边框统一换成"亮底深字"一套：文字近黑、控件底改成极淡黑、边框淡黑描边。
   全部限定在 #dsh-skin-keymark-panel 内，不影响对话区与其它面板。 */
#dsh-skin-keymark-panel{
  --km-text:#14161b;
  --km-muted:rgba(20,22,27,.86);
  --km-hairline:rgba(20,22,27,.18);
  --km-border:rgba(20,22,27,.22);
  --km-surface:rgba(20,22,27,.06);
  --km-subtle:rgba(20,22,27,.05);
  --km-hover:rgba(20,22,27,.10);
  --km-float-fill:rgba(20,22,27,.06);
  --dsw-alias-label-primary:#14161b !important;
  --dsw-alias-label-secondary:rgba(20,22,27,.86) !important;
  --dsw-alias-label-tertiary:rgba(20,22,27,.76) !important;
  color:#14161b;
}
#dsh-skin-keymark-panel .km-label-text,
#dsh-skin-keymark-panel .km-label,
#dsh-skin-keymark-panel .km-sub,
#dsh-skin-keymark-panel .km-readback,
#dsh-skin-keymark-panel .km-num{
  color:rgba(20,22,27,.86) !important;
  text-shadow:none !important;
  -webkit-font-smoothing:antialiased;
}
#dsh-skin-keymark-panel .km-title,
#dsh-skin-keymark-panel .km-sec-title,
#dsh-skin-keymark-panel .km-input,
#dsh-skin-keymark-panel .km-btn,
#dsh-skin-keymark-panel .km-ta{
  color:#14161b !important;
  text-shadow:none !important;
}
#dsh-skin-keymark-panel :is(.km-sec,.km-btn,.km-input,.km-ta,.km-drop,.km-tabbar,.km-lib-item,.km-chip){
  /* 2026-11-24 用户 m00750「这种白色的块没有彻底修复」：
   * 原来这里写死 rgba(255,255,255,.18) —— 一块不透明的白，落在抽屉的亮糊上
   * 还看得过去，可它有 18% 的绝对亮度，一旦面板换到别的底（设置页的深玻璃、
   * 深色壁纸、浅色主题）它就是一坨「白块」，和周围材质不搭。
   * 改成用 currentColor 混：字是深色时得到淡深色，字是浅色时得到淡浅色，
   * 永远只是「比背景亮/暗一点点」的分组衬底，不再是独立的白色物件。 */
  background-color:color-mix(in srgb,currentColor 7%,transparent) !important;
  border-color:transparent !important;
}
/* 拖拽区本身就是虚线框，保留一条淡线，否则看不出可以拖进来。 */
#dsh-skin-keymark-panel .km-drop{border-color:rgba(20,22,27,.14) !important}
/* 顶部搜索框与标题分线不上面那张名单的类名，单独压淡，否则顶上看去仍像嵌了一个框。 */
#dsh-skin-keymark-panel .km-find input{border-color:transparent !important}
#dsh-skin-keymark-panel .km-head{border-bottom-color:transparent !important}
#dsh-skin-keymark-panel .km-chip{color:#1d3f6e !important}
#dsh-skin-keymark-panel .km-tabbar .km-tab{color:rgba(20,22,27,.72) !important}
#dsh-skin-keymark-panel .km-tabbar .km-tab[data-active="true"]{
  background:color-mix(in srgb,currentColor 15%,transparent) !important;
  color:#14161b !important;
}

/* ══ 版式层（2026-11-24，用户 m00002「这个界面很怪」）═══════════════════════
   上面那些节负责「颜色/材质」，这一节只负责版式。原来的毛病是四套节拍同时
   存在：五档字号（13.5/13/12.5/12/11.5）、三套行距（组头 14 / field 10 /
   row 8）、三套行高（开关 32 / 下拉 36 / 滑条 53），加上控件没有边框、
   滑条数值贴着标题文字、12 个渐变按钮 flex 换行边缘不齐 —— 合起来就是
   「控件各自漂浮、看不出成组」的观感。这里收敛成一套：
     · 字号三级：13.5 分区标题 / 12.5 正文与控件 / 11.5 说明与计数
     · 行距一档：顶层元素统一 12px，行高统一 36px（开关行不再矮 4px）
     · 层级靠「发丝线 + 段落间距」：分区 20px，组头上方再 18px 一条线
     · 滑条数值靠右、与标题同排，抬到 24px 高
     · 渐变按钮 4 列网格，等宽等高
     · 控件补回一条淡描边：全透明的按钮在亮壁纸上看起来像文字而不是可点物
   注意：搜索索引按 .km-field/.km-row 抓单元、分组折叠按 .km-sub 切段，
   这里只改盒模型与字体，不动 DOM 层级与类名。 */
#dsh-skin-keymark-panel .km-sub{font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.02em}
#dsh-skin-keymark-panel .km-input,
#dsh-skin-keymark-panel select.km-mini{font-size:12.5px}
#dsh-skin-keymark-panel .km-num{width:56px;height:24px;padding:0 6px;text-align:right;font:600 11.5px/1 var(--ds-font-family-code,ui-monospace,monospace);background-color:color-mix(in srgb,currentColor 10%,transparent) !important;border:1px solid color-mix(in srgb,currentColor 20%,transparent) !important}
#dsh-skin-keymark-panel .km-readback{font-size:11.5px}
/* 滑条行：数值回到最右侧。7058 那条 .km-field > .km-label 用 flex-start 把
   .km-num 顶在标题文字右边，右侧就空出一大片（实测 415–465px）。 */
#dsh-skin-keymark-panel .km-field > .km-label{justify-content:space-between;gap:12px}
#dsh-skin-keymark-panel .km-field > .km-label .km-label-text{flex:1 1 auto;min-width:0}
/* 间距：顶层子元素统一 12px 底距，开关行与下拉行同高 36px。 */
#dsh-skin-keymark-panel .km-sec-body > .km-field,
#dsh-skin-keymark-panel .km-sec-body > .km-row,
#dsh-skin-keymark-panel .km-sec-body > .km-inline{margin:0 0 12px}
#dsh-skin-keymark-panel .km-field{margin:0 0 12px}
#dsh-skin-keymark-panel .km-row{margin:0 0 12px;min-height:36px}
#dsh-skin-keymark-panel .km-sec-body > :last-child{margin-bottom:0}
/* 组头：上方一条发丝线把它和上一组分开，首组不画。 */
#dsh-skin-keymark-panel .km-sub{margin:18px 0 8px;padding-top:14px;border-top:1px solid var(--km-border);border-radius:0;color:var(--km-text)}
#dsh-skin-keymark-panel .km-sub[data-km-grphead="1"]{margin:18px -6px 8px;padding:14px 6px 0;border-top:1px solid var(--km-border);border-radius:0}
#dsh-skin-keymark-panel .km-sec-body > .km-sub:first-child,
#dsh-skin-keymark-panel .km-sec-body > .km-sub[data-km-grphead="1"]:first-child{margin-top:0;padding-top:0;border-top:0}
/* 拖拽区：原来 16px 内衬 + 虚线的块是整屏最大的一块面积，抢焦点。压成一条。 */
#dsh-skin-keymark-panel .km-drop{margin:0 0 12px;padding:9px 12px;font-size:12px;line-height:1.4}
/* 渐变预设：4 列网格，等宽等高、边缘齐。 */
#dsh-skin-keymark-panel .km-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;width:100%}
#dsh-skin-keymark-panel .km-grid > .km-btn{min-width:0;height:32px;min-height:32px;padding:0 4px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 控件补描边：7533 那段把边框全改成 transparent，按钮只剩一层 18% 白底，
   在亮壁纸上和纯文字几乎分不开。给一条淡线 + 略实一档的衬底。
   2026-11-24 用户 m00750「这种白色的块没有彻底修复」：这里原来写死
   rgba(255,255,255,.44)/.72/.86 —— 绝对值白，只在抽屉那张亮糊底上成立；
   面板一旦落到深色设置页或深色壁纸上，它就是一块块贴上去的白板子。
   改成按 currentColor 混：字深则块淡深、字浅则块淡浅，永远只是「同一材质的
   一个面」，不会自己变成光源。 */
#dsh-skin-keymark-panel :is(.km-btn,.km-input,.km-ta,.km-chip,.km-lib-item){
  background-color:color-mix(in srgb,currentColor 8%,transparent) !important;
  border-color:color-mix(in srgb,currentColor 16%,transparent) !important;
}
#dsh-skin-keymark-panel :is(.km-btn,.km-chip):hover{background-color:color-mix(in srgb,currentColor 14%,transparent) !important;border-color:color-mix(in srgb,currentColor 30%,transparent) !important}
#dsh-skin-keymark-panel .km-btn[data-active="true"],
#dsh-skin-keymark-panel .km-chip[data-active="true"]{background-color:color-mix(in srgb,currentColor 22%,transparent) !important;border-color:color-mix(in srgb,currentColor 46%,transparent) !important}
/* 内嵌进设置页：分区之间 20px 呼吸 + 发丝线；搜索框单独成条，不再悬空。 */
#dsh-skin-keymark-panel[data-hosted="true"] .km-body{padding:14px 0 10px}
#dsh-skin-keymark-panel[data-hosted="true"] .km-sec{padding:20px 0;background-color:transparent !important}
#dsh-skin-keymark-panel[data-hosted="true"] .km-sec:first-child{padding-top:2px}
#dsh-skin-keymark-panel[data-hosted="true"] .km-sec-title{margin:0 0 12px;font:650 13.5px/1.4 system-ui,sans-serif;color:#14161b}
#dsh-skin-keymark-panel[data-hosted="true"] .km-find{padding:0 0 10px;margin:0 0 4px;border-bottom:1px solid var(--km-border)}

/* ── 宿主对齐层（2026-11-24 第三轮取证）────────────────────────────────────
   第一轮只动了版式；第二轮量出对比度 1.96:1（近黑字压在中灰底上），于是给
   内嵌面板铺了 58% 亮纱把字救回来。可是把「一块亮白矩形」塞进宿主自己的
   设置页之后，问题变成了另一种「很怪」：
     宿主 .AnXs9G_panel 底 = rgba(30,30,33,.275)，正文 oklch(.968) 近白，
     分区标题 14px/400，控件 rgba(22,22,22,.21) / 36px 高 / 10px 圆角。
   也就是说设置页里两套语言并置：左边整页深玻璃 + 白字，右边插件区白底 +
   黑字，而且比周围亮一大截，边缘还有一圈白描边 —— 像贴上去的一张纸。
   结论：内嵌态不该自带底色，而要说宿主的语言。这一节把 7502 那套「亮底
   深字」（原本是给抽屉的 brightness(1.25) 亮糊调的）在内嵌态整体反转回
   深底浅字，字号/控件规格照宿主实测值靠：14 标题、13 正文、36 控件、
   10px 圆角、rgba(22,22,22,.21) 控件底。
   ──────────────────────────────────────────────────────────────────── */
#dsh-skin-keymark-panel[data-hosted="true"]{
  --km-text:#f2f3f5;
  --km-muted:rgba(255,255,255,.82);
  --km-faint:rgba(255,255,255,.58);
  --km-border:rgba(255,255,255,.15);
  --km-subtle:rgba(255,255,255,.07);
  --km-surface:rgba(255,255,255,.07);
  --km-hover:rgba(255,255,255,.10);
  margin:0;
  padding:0;
  border:0;
  border-radius:0;
  background-color:transparent;
  box-shadow:none;
  -webkit-backdrop-filter:none;
  backdrop-filter:none;
  color:#f2f3f5;
}
/* 字色反转：7516–7532 那两段把标题/标签/控件字全钉成 #14161b !important，
   这里用「同 !important + 多一层属性选择器」压回去。 */
#dsh-skin-keymark-panel[data-hosted="true"] .km-title,
#dsh-skin-keymark-panel[data-hosted="true"] .km-sec-title,
#dsh-skin-keymark-panel[data-hosted="true"] .km-input,
#dsh-skin-keymark-panel[data-hosted="true"] .km-btn,
#dsh-skin-keymark-panel[data-hosted="true"] .km-ta,
#dsh-skin-keymark-panel[data-hosted="true"] .km-drop{color:#f2f3f5 !important}
#dsh-skin-keymark-panel[data-hosted="true"] .km-label,
#dsh-skin-keymark-panel[data-hosted="true"] .km-label-text,
#dsh-skin-keymark-panel[data-hosted="true"] .km-sub,
#dsh-skin-keymark-panel[data-hosted="true"] .km-readback,
#dsh-skin-keymark-panel[data-hosted="true"] .km-num{color:rgba(255,255,255,.82) !important}
/* 字号向宿主的 14/13/12 三档靠：分区标题与宿主「权限/语言/外观」同为 14px，
   只是宿主用 400 细体，这里保留 500 —— 插件分区标题要能一眼看出是分区入口。 */
#dsh-skin-keymark-panel[data-hosted="true"] .km-sec-title{font:500 14px/1.4 system-ui,sans-serif}
#dsh-skin-keymark-panel[data-hosted="true"] .km-label,
#dsh-skin-keymark-panel[data-hosted="true"] .km-label-text{font-size:13px}
#dsh-skin-keymark-panel[data-hosted="true"] .km-sub{font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.04em}
#dsh-skin-keymark-panel[data-hosted="true"] :is(.km-input,.km-btn,.km-ta){font-size:13px}
/* 控件：照宿主 selector 实测的 rgba(22,22,22,.21) + 10px 圆角。7533 那条把它
   们刷成 18% 白底、透明边框，在深底上等于没有容器，只剩文字可点。 */
#dsh-skin-keymark-panel[data-hosted="true"] :is(.km-btn,.km-input,.km-ta,.km-chip,.km-lib-item,.km-num){
  background-color:rgba(22,22,22,.21) !important;
  border-color:rgba(255,255,255,.10) !important;
}
#dsh-skin-keymark-panel[data-hosted="true"] :is(.km-btn,.km-chip):hover{
  background-color:rgba(22,22,22,.34) !important;
  border-color:rgba(255,255,255,.20) !important;
}
#dsh-skin-keymark-panel[data-hosted="true"] .km-btn[data-active="true"],
#dsh-skin-keymark-panel[data-hosted="true"] .km-chip[data-active="true"]{
  background-color:rgba(22,22,22,.46) !important;
  border-color:rgba(255,255,255,.34) !important;
}
#dsh-skin-keymark-panel[data-hosted="true"] .km-drop{
  background-color:rgba(255,255,255,.03) !important;
  border-color:rgba(255,255,255,.14) !important;
}
#dsh-skin-keymark-panel[data-hosted="true"] .km-find input{background-color:rgba(22,22,22,.21) !important;border-color:rgba(255,255,255,.10) !important}
#dsh-skin-keymark-panel[data-hosted="true"] .km-body{padding:0 0 4px}
#dsh-skin-keymark-panel[data-hosted="true"] .km-find{border-bottom-color:rgba(255,255,255,.12)}
/* 搜索条与下方控件同一条竖线（2026-11-24 第五轮实测）：
   7484 把它 padding 左右都写成 8px，可 7490 给 .km-sec 写的是 6px ⇒ 搜索框
   左边比卡片多缩 2px、右边多缩 10px（实测 l=8 r=16，卡片是 l=6 r=6）。
   同屏两套内衬，肉眼看到的就是「上面那根框跟下面全都没对齐」。 */
#dsh-skin-keymark-panel[data-hosted="true"] .km-find{
  padding:0 6px 10px !important;
  margin:0 0 4px !important;
}
/* 那条「匹配 N 项」计数在没搜索时是空的，但它仍占着 flex 的 8px gap，
   把输入框右缘又顶回 14px。空的时候整条不参与布局，右缘才落回 6px。 */
#dsh-skin-keymark-panel .km-find-count:empty{display:none}
#dsh-skin-keymark-panel[data-hosted="true"] .km-sub[data-km-grphead="1"]{border-top-color:rgba(255,255,255,.10)}
#dsh-skin-keymark-panel[data-hosted="true"] .km-body::-webkit-scrollbar-thumb{background-color:rgba(255,255,255,.18)}

/* ── 下拉行左缘对齐（2026-11-24 第二轮取证）──────────────────────────────
   .km-row 是 justify-content:space-between（7060），标签宽度随文字走，
   剩下的全给 .km-input（7063 flex:1 1 auto）。于是「类型」的 select 左边缘
   x=656、「适配方式」x=681 —— 同一列控件左右各错 25px。这里把标签改成
   定宽栅格列，行内剩下一律从同一 x 起排；开关行仍靠 margin-left:auto
   顶到最右。 */
#dsh-skin-keymark-panel .km-row{justify-content:flex-start}
#dsh-skin-keymark-panel .km-row > .km-label{flex:0 0 88px;min-width:0}
#dsh-skin-keymark-panel .km-row > select.km-input,
#dsh-skin-keymark-panel .km-row > .km-input{flex:1 1 auto;min-width:0}
#dsh-skin-keymark-panel .km-row > :last-child:not(.km-label):not(.km-input){margin-left:auto}

/* ── 渐变预设色片（2026-11-24 第四轮）────────────────────────────────────
   12 个渐变预设原来只是一排同色灰按钮，「极光 / 暮色 / 纸感 / 墨韵…」这些
   名字对不上任何可见差异 —— 用户要靠点开来猜。给每个按钮左侧加一枚 10px
   圆点，用该预设自己的 gradientCss 上色，一眼就能认出是「一片颜色的选择」，
   而不是十二个长得一样的表单零件。 */
#dsh-skin-keymark-panel .km-btn.km-grad{
  display:flex;
  align-items:center;
  justify-content:flex-start;
  gap:7px;
  padding:0 9px;
}
#dsh-skin-keymark-panel .km-grad-dot{
  flex:0 0 auto;
  width:14px;
  height:14px;
  border-radius:50%;
  background-color:rgba(255,255,255,.18);
  background-size:cover;
  background-position:center;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.28);
}
#dsh-skin-keymark-panel .km-grad-name{
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
#dsh-skin-keymark-panel[data-hosted="true"] .km-grad-dot{
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.30), 0 0 0 1px rgba(0,0,0,.28);
}
/* 选中态：宿主语言里没有更好的强调法，用描边 + 加亮底表达「当前是这一张」。 */
#dsh-skin-keymark-panel[data-hosted="true"] .km-btn.km-grad[data-active="true"]{
  background-color:rgba(22,22,22,.55) !important;
  border-color:rgba(255,255,255,.46) !important;
}

/* ── 滑条轨道（2026-11-24 第六轮）────────────────────────────────────────
   7345 把 track 写成 rgba(120,120,128,.3) —— 那是一块中灰，落在虚化壁纸上
   与背景同亮度（实测 track 与周围差 2–4 级灰），整条滑条只剩一个白钮悬空，
   看不出「这里能拖、拖到哪」。改成 14% 白 + 一圈内描边：在任何壁纸上都比
   背景亮一档，又不会自己抢注意力；同时把 accent-color 的填充感交还给
   thumb 的白色圆钮（宿主设置页也没有彩色进度条，这里是同一套语言）。 */
#dsh-skin-keymark-panel[data-hosted="true"] input[type="range"]::-webkit-slider-runnable-track{
  height:5px;
  border-radius:999px;
  background:rgba(255,255,255,.14);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.10);
}
#dsh-skin-keymark-panel[data-hosted="true"] input[type="range"]::-webkit-slider-thumb{
  width:14px;
  height:14px;
  margin-top:-4.5px;
  background:#fff;
  border:0;
  box-shadow:0 0 0 3px rgba(255,255,255,.10),0 1px 4px rgba(0,0,0,.42);
}
#dsh-skin-keymark-panel[data-hosted="true"] input[type="range"]:hover::-webkit-slider-runnable-track{
  background:rgba(255,255,255,.20);
}
`;

		function ensurePanelStyles() {
			if (document.getElementById(PANEL_STYLE_ID)) return;
			const el = document.createElement("style");
			el.id = PANEL_STYLE_ID;
			el.textContent = PANEL_CSS;
			(document.head || document.documentElement).appendChild(el);
		}

		let panelEl = null;
		let panelRefs = null;

		// Collapsible section. The panel is a single long scroll with seven
		// sections, so hunting for one control means scrolling past everything
		// else. Clicking the title (or its chevron) folds the body away; the
		// folded set is remembered in `ui.collapsed` and survives a restart.
		// `keepOpen` marks sections that must not start folded on a fresh
		// profile (the wallpaper section is the one people actually open).
		function section(title, opts) {
			const body = h("div", { class: "km-sec-body" });
			const chevron = h("span", { class: "km-sec-chevron", "aria-hidden": "true", text: "▾" });
			const titleEl = h("button", {
				class: "km-sec-title", type: "button",
				title: "点击折叠 / 展开",
				"aria-expanded": "true"
			}, [h("span", { class: "km-sec-text", text: title }), chevron]);
			const el = h("section", { class: "km-sec" });
			el.appendChild(titleEl);
			el.appendChild(body);

			const isFolded = () => {
				// `keepOpen` sections never start folded: a stale `collapsed` entry
				// (hand-edited state, an imported theme pack) would otherwise hide
				// the wallpaper controls on a fresh open, which reads as "broken".
				if (opts && opts.keepOpen) return false;
				const list = state.ui && Array.isArray(state.ui.collapsed) ? state.ui.collapsed : [];
				return list.indexOf(title) >= 0;
			};
			const paint = (folded) => {
				el.setAttribute("data-collapsed", folded ? "true" : "false");
				titleEl.setAttribute("aria-expanded", folded ? "false" : "true");
			};
			paint(isFolded());

			titleEl.addEventListener("click", () => {
				const folded = !isFolded();
				const list = state.ui && Array.isArray(state.ui.collapsed) ? state.ui.collapsed.slice() : [];
				const at = list.indexOf(title);
				if (folded && at < 0) list.push(title);
				else if (!folded && at >= 0) list.splice(at, 1);
				state.ui.collapsed = list;
				paint(folded);
				// Fold state is cosmetic, so it skips applyAll() and only persists:
				// re-running every engine just to hide a <div> would repaint the
				// wallpaper on each click.
				try { scheduleSave(); } catch { /* ignore */ }
			});

			return { el, body, titleEl, keepOpen: Boolean(opts && opts.keepOpen) };
		}

		function row(label, control) {
			return h("div", { class: "km-row" }, [h("span", { class: "km-label", text: label }), control]);
		}

		/** Group heading inside a section (see .km-sub). */
		function sub(parent, text) {
			parent.appendChild(h("div", { class: "km-sub", text }));
		}

		/* ── 分组折叠（0.1.23）────────────────────────────────────────
		 * 页签解决了「四处乱翻」，但背景页签里壁纸一节本身 1601px，
		 * 可视区只有 889px —— 一屏放不下，还是要滚两屏。
		 *
		 * 做法：不新建 DOM 层级，只给 `.km-sub` 标题和它下面的一串兄弟节点
		 * 打属性。包裹 div 会同时打断三处按 `sec.body.children` 遍历的逻辑
		 * （搜索索引、分组标题跟随、置灰），而折叠只是显示问题，不值得为它
		 * 重构那三处。
		 *
		 * 状态：`ui.groupAuto` 为真时按「每组只展开第一个」现算，用户点过
		 * 任何标题就转 `manual` 并把实际折叠集合写进 `ui.groupFolded`。
		 * 这样默认观感是收敛的，但一旦用户表达过偏好就不再自作主张。
		 */
		const GROUP_SEP = "::";
		const groupRegistry = [];

		function groupify(sec) {
			const title = (() => {
				const t = sec.titleEl && sec.titleEl.querySelector(".km-sec-text");
				return t ? String(t.textContent || "") : "";
			})();
			const groups = [];
			let current = null;
			for (const node of Array.prototype.slice.call(sec.body.children)) {
				// data-km-note 是「说明行」不是标题：它长得跟标题一样（都是
				// .km-sub），但不能当分组头，否则它会把本该连着的正文切开。
				if (node.classList && node.classList.contains("km-sub") && node.getAttribute("data-km-note") !== "1") {
					const key = title + GROUP_SEP + String(node.textContent || "").trim();
					current = { key, header: node, members: [] };
					groups.push(current);
					node.setAttribute("data-km-grphead", "1");
					node.setAttribute("role", "button");
					node.setAttribute("tabindex", "0");
					node.appendChild(h("span", { class: "km-grpchev", "aria-hidden": "true", text: "▾" }));
				} else if (current) {
					current.members.push(node);
				}
			}
			if (!groups.length) return;
			groupRegistry.push({ sec, title, groups });
		}

		const groupFoldedSet = () => {
			const list = state.ui && Array.isArray(state.ui.groupFolded) ? state.ui.groupFolded : [];
			return new Set(list);
		};

		/** 就地重算哪些分组要收起：search 期间一律全开。 */
		function applyGroups(expandAll) {
			const chosen = groupFoldedSet();
			const auto = !state.ui || state.ui.groupAuto !== false;
			for (const entry of groupRegistry) {
				entry.groups.forEach((g, index) => {
					// auto 模式：每个分区只留第一组展开，其余收起。
					const folded = expandAll ? false : (auto ? index > 0 : chosen.has(g.key));
					for (const m of g.members) {
						if (folded) m.setAttribute("data-km-grphide", "1");
						else m.removeAttribute("data-km-grphide");
					}
					g.header.setAttribute("data-km-grpfold", folded ? "true" : "false");
					g.header.setAttribute("aria-expanded", folded ? "false" : "true");
				});
			}
		}

		/** 把「当前实际折叠集合」落成用户偏好，然后翻转目标那一组。 */		function toggleGroup(entry, target) {
			// 以「屏幕上此刻的样子」为基准，而不是重算一遍 auto 规则：
			// 用户点的是他看见的那一版，中途任何规则变化都不该让他点到别的组。
			const chosen = new Set();
			for (const g of entry.groups) {
				if (g.header.getAttribute("data-km-grpfold") === "true") chosen.add(g.key);
			}
			if (chosen.has(target.key)) chosen.delete(target.key);
			else chosen.add(target.key);
			state.ui.groupAuto = false;
			state.ui.groupFolded = Array.from(chosen).slice(0, 40);
			applyGroups(false);
			try { scheduleSave(); } catch { /* ignore */ }
		}

		function installGroupToggles() {
			for (const entry of groupRegistry) {
				for (const g of entry.groups) {
					const flip = () => toggleGroup(entry, g);
					g.header.addEventListener("click", flip);
					g.header.addEventListener("keydown", (e) => {
						if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
					});
				}
			}
		}

		/**
		 * 把一个节点所在的组展开。
		 *
		 * 存在的理由：分组折叠默认每组只开第一组，于是「自定义 CSS 写错了」
		 * 这种必须被看见的反馈，红色提示行正好落在被收起的「主题包」组里 ——
		 * 用户写完点应用，屏幕毫无变化，会以为体检根本没跑。凡是「结果必须
		 * 立刻可见」的调用点都要先把自己亮出来（只展开自己所在的组，不改
		 * groupAuto 偏好：这是临时让路，不是替用户做决定）。
		 */
		function revealGroupOf(node) {
			if (!node) return;
			for (const entry of groupRegistry) {
				for (const g of entry.groups) {
					const inside = g.members.some((m) => m === node || (m.contains && m.contains(node)));
					if (!inside) continue;
					for (const m of g.members) m.removeAttribute("data-km-grphide");
					g.header.setAttribute("data-km-grpfold", "false");
					g.header.setAttribute("aria-expanded", "true");
				}
			}
		}

		// A range control with an editable readout: the number beside the label is a
		// real <input type="number">, so a precise value can be typed instead of
		// hunted for with the slider, and double-clicking the label restores the
		// default. `defVal` is optional — omitting it simply disables the reset.
		function sliderRow(parent, label, min, max, step, onInput, defVal) {
			const input = h("input", { type: "range", class: "km-range", min: String(min), max: String(max), step: String(step) });
			const val = h("input", { type: "number", class: "km-num", min: String(min), max: String(max), step: String(step) });
			const write = (v, fire) => {
				const n = clamp(isFinite(Number(v)) ? Number(v) : 0, min, max);
				input.value = String(n);
				val.value = String(n);
				if (fire) onInput(n);
			};
			input._set = write;
			// 拖动合并：range 的 input 事件是「每个像素一次」，一次正常拖动
			// 能触发上百次，而每次 onInput 都会 commit() → applyAll()（10 个
			// 引擎，其中 applyWallpaper 还要重建整条 cssText）。渲染本身是按
			// 帧的，同一帧内的中间值用户永远看不到 —— 把它们丢掉只跑最后一
			// 次，视觉完全等价，CPU 从「每像素一次全量应用」降到「每帧一次」。
			//
			// 数值框与双击复位**不走**这条路径：它们是一次性动作，延迟一帧
			// 反而让「点一下没反应」的错觉回来。
			let dragFrame = 0;
			input.addEventListener("input", () => {
				if (dragFrame) return;
				dragFrame = requestAnimationFrame(() => {
					dragFrame = 0;
					// 读 input.value 而不是闭包捕获的值：这一帧内可能又拖了
					// 几像素，只有最后那个值是有意义的。
					write(input.value, true);
				});
			});
			// Commit typed input on change/blur/Enter instead of on every keystroke:
			// typing "12" would otherwise publish 1 first and fight for the caret.
			const commitTyped = () => write(val.value, true);
			val.addEventListener("change", commitTyped);
			val.addEventListener("blur", commitTyped);
			val.addEventListener("keydown", (e) => {
				if (e.key === "Enter") { commitTyped(); val.blur(); }
			});
			const labelEl = h("span", { class: "km-label-text", text: label });
			labelEl.title = "双击恢复默认";
			if (isFinite(Number(defVal))) labelEl.addEventListener("dblclick", () => write(defVal, true));
			parent.appendChild(
				h("div", { class: "km-field" }, [h("div", { class: "km-label" }, [labelEl, val]), input])
			);
			return input;
		}

		function setRange(input, value) {
			if (!input) return;
			if (typeof input._set === "function") input._set(value, false);
			else {
				input.value = String(value);
				if (input._val) input._val.value = String(value);
			}
		}

		// 面板被设置页接走后它挂在 React 容器里，而不是 document.body 下；
		// 因此「已存在」的判据只能是 panelEl 本身，不能再用 body.contains()
		// —— 否则每次切回设置页都会重建整块面板，输入焦点与滚动位置全丢。
		function ensurePanel() {
			if (panelEl) return panelEl;
			ensurePanelStyles();
			panelEl = h("div", { id: PANEL_ID, "data-open": "false" });
			// Runtime probe: a capture-phase click listener records which
			// control a click actually reaches, so a "clicked, nothing
			// happened" report can be split into "the click never arrived"
			// (overlay / drag band) vs "it arrived but commit() failed".
			// Throttled so a burst of clicks does not rewrite the host state
			// file repeatedly.
			let lastClickDiagAt = 0;
			panelEl.addEventListener("click", (event) => {
				const now = Date.now();
				if (now - lastClickDiagAt < 1200) return;
				lastClickDiagAt = now;
				try {
					const t = event.target;
					const cls = (t && t.getAttribute && t.getAttribute("class")) || "";
					diagReport(
						"panel-click",
						(t && t.tagName ? String(t.tagName).toLowerCase() : "?") +
							(cls ? "." + String(cls).split(" ")[0] : "")
					);
				} catch { /* ignore */ }
			}, true);
			const refs = {};
			panelRefs = refs;
			// Every section registry lands here so the header's "全部展开" can
			// repaint them all without walking the DOM for `.km-sec` nodes.
			refs.sections = [];

			panelEl.appendChild(
				h("div", { class: "km-head" }, [
					h("span", { class: "km-title", text: "皮肤 · Keymark" }),
					h("div", { class: "km-head-actions" }, [
						h("button", {
							class: "km-btn km-mini", type: "button", text: "全部展开",
							title: "展开所有分区",
							onclick: () => {
								state.ui.collapsed = [];
								for (const sec of panelRefs && panelRefs.sections ? panelRefs.sections : []) {
									sec.el.setAttribute("data-collapsed", "false");
									sec.titleEl.setAttribute("aria-expanded", "true");
								}
								try { scheduleSave(); } catch { /* ignore */ }
							}						}),
						h("button", { class: "km-btn km-mini", type: "button", text: "恢复默认",
							title: "清空所有设置",
							onclick: () => {
								if (typeof window.confirm === "function" && !window.confirm("恢复默认？壁纸、外观、配色、字体都会清空。")) return;
								state = defaultState();
								commit();
								toast("已恢复默认设置");
							}
						}),
						h("button", { class: "km-x", type: "button", title: "关闭", "aria-label": "关闭", text: "×", onclick: () => setPanelOpen(false) })
					])
				])
			);

			/* ── 搜索栏 ──
			 * 面板现在 38+ 个控件散在 4 个分区里，「我想调对比度」需要先想
			 * 「它到底在壁纸还是外观」再滚。这里给一个字面过滤：输入即按
			 * 控件文本（标签 / 分组标题 / 分区标题 / title 提示）逐行隐藏。
			 *
			 * 为什么不做成「跳转到第一个命中」：跳转只解决一次，连续调几个
			 * 相关参数还是要反复找；就地过滤能让剩下的东西一直待在视野里。
			 *
			 * 实现要点：过滤粒度是 `.km-field` / `.km-row`，不是分区 —— 分区
			 * 标题永远保留（否则用户不知道命中的是在哪一组下面），命中的
			 * 分区自动强制展开（折叠着的分区里藏着命中项等于没找到）。 */
			const findInput = h("input", {
				type: "search", class: "km-find-input", placeholder: "搜索设置项",
				"aria-label": "搜索设置项", spellcheck: "false"
			});
			const findCount = h("span", { class: "km-find-count", text: "" });
			refs.findInput = findInput;
			refs.findCount = findCount;
			panelEl.appendChild(h("div", { class: "km-find" }, [findInput, findCount]));

			const body = h("div", { class: "km-body" });
			panelEl.appendChild(body);
			refs.body = body;
			// 「一条都没找到」的占位。空态必须显式画出来：全部行被隐藏时
			// 面板看起来像加载失败了。
			const findEmpty = h("div", { class: "km-find-empty km-hidden",
				text: "没有匹配项" });
			refs.findEmpty = findEmpty;
			body.appendChild(findEmpty);

			/* ── wallpaper ── */
			{
				const sec = section("壁纸", { keepOpen: true });
				refs.sections.push(sec);
				const enabled = h("input", { type: "checkbox" });
				refs.wpEnabled = enabled;
				enabled.addEventListener("change", () => {
					state.wallpaper.enabled = enabled.checked;
					commit();
				});
				sec.body.appendChild(row("启用壁纸", enabled));
				sub(sec.body, "素材");

				const urlInput = h("input", { type: "text", class: "km-input", placeholder: "图片或视频链接" });
				refs.wpUrl = urlInput;
				sec.body.appendChild(
					h("div", { class: "km-field" }, [
						h("div", { class: "km-label", text: "壁纸地址" }),
						h("div", { class: "km-inline" }, [
							urlInput,
							h("button", {
								class: "km-btn", type: "button", text: "应用",
								onclick: () => {
									const picked = urlInput.value.trim();
									state.wallpaper.url = picked;
									state.wallpaper.gradient = "";
									state.wallpaper.kind = "auto";
									state.wallpaper.enabled = true;
									commit();
									tuneOnPick(picked);
								}
							})
						])
					])
				);

				const fileInput = h("input", { type: "file", accept: "image/*,video/*", class: "km-hidden" });
				fileInput.addEventListener("change", async () => {
					const file = fileInput.files && fileInput.files[0];
					fileInput.value = "";
					await handleFile(file);
				});
				sec.body.appendChild(
					h("div", { class: "km-inline km-wrap" }, [
						h("button", { class: "km-btn", type: "button", text: "选择图片 / 视频", onclick: () => fileInput.click() }),
						h("button", {
							class: "km-btn km-danger", type: "button", text: "清除壁纸",
							onclick: () => { state.wallpaper.url = ""; state.wallpaper.gradient = ""; commit(); }
						}),
						fileInput
					])
				);

				// Drop zone: dragging a file anywhere onto the panel applies it, which
				// skips the file picker entirely. `dragover` must be cancelled or the
				// browser navigates away from the app to open the dropped file.
				const drop = h("div", { class: "km-drop", text: "拖入图片或视频" });
				const stopDrag = (e) => { e.preventDefault(); e.stopPropagation(); };
				panelEl.addEventListener("dragover", stopDrag);
				panelEl.addEventListener("drop", (e) => {
					stopDrag(e);
					const dt = e.dataTransfer;
					const f = dt && dt.files && dt.files[0];
					if (f) { drop.setAttribute("data-hot", "false"); handleFile(f); }
				});
				panelEl.addEventListener("dragenter", (e) => { stopDrag(e); drop.setAttribute("data-hot", "true"); });
				panelEl.addEventListener("dragleave", (e) => { stopDrag(e); drop.setAttribute("data-hot", "false"); });
				sec.body.appendChild(drop);

				const kindSel = h("select", { class: "km-input" });
				[["auto", "自动识别"], ["image", "图片"], ["video", "视频"]].forEach(([v, t]) =>
					kindSel.appendChild(h("option", { value: v, text: t }))
				);
				refs.wpKind = kindSel;
				kindSel.addEventListener("change", () => { state.wallpaper.kind = kindSel.value; commit(); });
				sec.body.appendChild(row("类型", kindSel));

				const fitSel = h("select", { class: "km-input" });
				for (const f of FITS) fitSel.appendChild(h("option", { value: f.id, text: f.label }));
				refs.wpFit = fitSel;
				fitSel.addEventListener("change", () => { state.wallpaper.fit = fitSel.value; commit(); });
				sec.body.appendChild(row("适配方式", fitSel));

				// ── 生成式壁纸（渐变） ──
				// 一个 id 就够：点击即把 url 清空并写入 gradient，两者互斥，
				// 所以「渐变 vs 图片/视频」永远只有一个生效，不必再加一个
				// 模式开关让用户猜当前是哪一种。
				sub(sec.body, "生成式壁纸");
				// km-grid：12 个预设按 4 列网格铺，等宽等高、边缘齐。
				// 用 flex-wrap 时最后一个不满的行会左对齐留豁口，看着像排版坏了。
				// 每个按钮左侧带一枚「该预设自己的渐变」色片（gradientCss），否则
				// 12 个同色灰按钮只剩「极光 / 暮色 / 纸感…」几个词可分辨 —— 一排
				// 长得一样的方块，是这块区域最像「表单零件堆」的地方。
				const gradWrap = h("div", { class: "km-inline km-wrap km-grid" });
				refs.gradientBtns = {};
				for (const g of GRADIENT_PRESETS) {
					const swatch = h("span", { class: "km-grad-dot", "aria-hidden": "true" });
					try {
						const css = gradientCss(g, null);
						if (css) swatch.style.backgroundImage = css;
					} catch { /* 预设编译失败就不画色片，按钮仍可用 */ }
					const btn = h("button", {
						class: "km-btn km-grad", type: "button", title: g.label,
						onclick: () => {
							state.wallpaper.gradient = state.wallpaper.gradient === g.id ? "" : g.id;
							if (state.wallpaper.gradient !== "") {
								// 渐变没有 url；留着一个旧的 url 只会让面板继续显示
								// 那张图的地址，看起来像"两张壁纸同时开着"。
								state.wallpaper.url = "";
								state.wallpaper.kind = "auto";
								state.wallpaper.enabled = true;
							}
							commit();
							toast(state.wallpaper.gradient ? "已切换为「" + g.label + "」渐变" : "已关闭渐变");
						}
					}, [swatch, h("span", { class: "km-grad-name", text: g.label })]);
					refs.gradientBtns[g.id] = btn;
					gradWrap.appendChild(btn);
				}
				sec.body.appendChild(gradWrap);
				const driftToggle = h("input", { type: "checkbox" });
				refs.gradientDrift = driftToggle;
				driftToggle.addEventListener("change", () => {
					state.ui.drift = driftToggle.checked;
					commit();
				});
				refs.gradientDriftRow = driftToggle.parentNode;
				sec.body.appendChild(row("缓慢漂移", driftToggle));

				sub(sec.body, "构图");
				// 平移与缩放都是纯 transform，所以对视频没有解码开销。平移按
				// 视口百分比存，窗口缩放后构图不变 —— 与 dsh-any-background
				// 位置编辑器同一个口径。
				refs.wpZoom = sliderRow(sec.body, "缩放", ZOOM_MIN, ZOOM_MAX, 1, (v) => { state.wallpaper.zoom = v; commit(); }, 100);
				refs.wpPanX = sliderRow(sec.body, "水平平移", -50, 50, 1, (v) => { state.wallpaper.panX = v; commit(); }, 0);
				refs.wpPanY = sliderRow(sec.body, "垂直平移", -50, 50, 1, (v) => { state.wallpaper.panY = v; commit(); }, 0);
				sec.body.appendChild(
					h("div", { class: "km-inline km-wrap" }, [
						h("button", {
							class: "km-btn km-mini", type: "button", text: "重置构图",
							onclick: () => {
								state.wallpaper.zoom = 100;
								state.wallpaper.panX = 0;
								state.wallpaper.panY = 0;
								commit();
								toast("构图已重置");
							}
						})
					])
				);

				sub(sec.body, "画面调整");
				refs.wpBlur = sliderRow(sec.body, "模糊", 0, 60, 1, (v) => { state.wallpaper.blur = v; commit(); }, 0);
				// 把死区写在控件下面，避免两种误读：以为「选了 1 没反应是坏了」，
				// 或以为「1 的那点糊是自己眼花」。滑条仍可停在任何值，只是不下发。
				refs.wpBlur.parentNode.appendChild(h("div", { class: "km-readback", text: "1px 及以下不下发：看不出糊，只掉清晰度" }));
				refs.wpDim = sliderRow(sec.body, "暗化", 0, 100, 1, (v) => { state.wallpaper.dim = v / 100; commit(); }, 0);
				refs.wpContrast = sliderRow(sec.body, "对比度", -100, 100, 1, (v) => { state.wallpaper.contrast = v; commit(); }, 0);
				refs.wpSaturate = sliderRow(sec.body, "饱和度", -100, 100, 1, (v) => { state.wallpaper.saturate = v; commit(); }, 0);
				refs.wpOpacity = sliderRow(sec.body, "面板不透明度", 0, 100, 1, (v) => { state.wallpaper.opacity = v / 100; commit(); }, 55);
				refs.wpGrain = sliderRow(sec.body, "颗粒噪点", 0, 100, 1, (v) => { state.wallpaper.grain = v / 100; commit(); }, 0);
				// Playback rate: native playbackRate, so changing it repaints nothing —
				// no reload, no decode hiccup, no black frame.
				refs.wpRate = sliderRow(sec.body, "播放倍速", RATE_MIN, RATE_MAX, 0.05, (v) => { state.wallpaper.rate = v; commit(); }, 1);
				// sliderRow returns the <input>; its parent is the .km-field wrapper,
				// which is what gets greyed out when the control cannot apply.
				refs.wpRateRow = refs.wpRate.parentNode;

				// Video-only extras. Both are opt-in because each costs an extra
				// decode context / seek loop; the loop-crossfade and the
				// pointer-orbit are mutually exclusive by design.
				sub(sec.body, "播放");
				const crossToggle = h("input", { type: "checkbox" });
				refs.wpCross = crossToggle;
				crossToggle.addEventListener("change", () => {
					state.wallpaper.crossfade = crossToggle.checked;
					if (crossToggle.checked) state.wallpaper.orbit = false;
					commit();
				});
				sec.body.appendChild(row("无缝循环", crossToggle));
				refs.wpCrossRow = crossToggle.parentNode;

				const orbitToggle = h("input", { type: "checkbox" });
				refs.wpOrbit = orbitToggle;
				orbitToggle.addEventListener("change", () => {
					state.wallpaper.orbit = orbitToggle.checked;
					if (orbitToggle.checked) state.wallpaper.crossfade = false;
					commit();
				});
				sec.body.appendChild(row("指针跟随", orbitToggle));
				refs.wpOrbitRow = orbitToggle.parentNode;

				// Mirroring works for stills and clips alike: a compositor-only
				// scaleX(-1), so it costs nothing per frame.
				const flipToggle = h("input", { type: "checkbox" });
				refs.wpFlip = flipToggle;
				flipToggle.addEventListener("change", () => { state.wallpaper.flip = flipToggle.checked; commit(); });
				sec.body.appendChild(row("水平翻转", flipToggle));

				// Occlusion tiers. Tier 1 (minimised / another tab) is always on; the
				// two here are the opt-out-able ones, on by default to save battery.
				const blurToggle = h("input", { type: "checkbox" });
				refs.wpPauseBlur = blurToggle;
				blurToggle.addEventListener("change", () => { state.wallpaper.pauseBlur = blurToggle.checked; commit(); });
				sec.body.appendChild(row("被遮挡时暂停", blurToggle));
				refs.wpPauseBlurRow = blurToggle.parentNode;

				const battToggle = h("input", { type: "checkbox" });
				refs.wpPauseBattery = battToggle;
				battToggle.addEventListener("change", () => { state.wallpaper.pauseBattery = battToggle.checked; commit(); });
				sec.body.appendChild(row("使用电池时暂停", battToggle));
				refs.wpPauseBatteryRow = battToggle.parentNode;

				// 轮播与过场单独成组：它们只在「有一组素材轮着换」时才有意义，
				// 和上面的单张壁纸调整不是同一件事。这个 sub 同时是下面折叠分组
				// 的切分点 —— 分组器按 .km-sub 切，没有它这一段会被并进「播放」。
				sub(sec.body, "轮播与过场");

				// Auto rotation: one URL per line, switched on a timer. The swap is
				// prepared to readiness first, so no black frame ever reaches the
				// screen; a dead URL is skipped instead of stalling the cycle.
				const rotToggle = h("input", { type: "checkbox" });
				refs.wpRotate = rotToggle;
				rotToggle.addEventListener("change", () => { state.wallpaper.rotate = rotToggle.checked; commit(); });
				sec.body.appendChild(row("自动轮播壁纸", rotToggle));

				const rotArea = h("textarea", { class: "km-ta km-ta-sm", placeholder: "每行一个地址，当前壁纸排在最前" });
				refs.wpRotateUrls = rotArea;
				rotArea.value = typeof state.wallpaper.rotateUrls === "string" ? state.wallpaper.rotateUrls : "";
				rotArea.addEventListener("change", () => { state.wallpaper.rotateUrls = rotArea.value; commit(); });
				sec.body.appendChild(rotArea);

				const rotBtn = h("button", {
					class: "km-btn km-mini", type: "button", text: "把素材库全部加入",
					onclick: async () => {
						const items = await listMedia();
						const urls = (items || []).map((it) => `${MEDIA_URL}/${it.name || it}`);
						if (!urls.length) { toast("素材库为空"); return; }
						const lines = [];
						for (const u of urls) {
							const k = resolveKind(u, "auto");
							// Only queue sources that actually load, so the browser is not
							// asked to probe a dead entry on every cycle.
							// eslint-disable-next-line no-await-in-loop
							if (await whenSourceReady(u, k)) lines.push(u);
						}
						if (!lines.length) { toast("没有可用素材"); return; }
						rotArea.value = lines.join("\n");
						state.wallpaper.rotateUrls = rotArea.value;
						state.wallpaper.rotate = true;
						if (refs.wpRotate) refs.wpRotate.checked = true;
						commit();
						toast(`已加入 ${lines.length} 项`);
					}
				});
				const rotMode = h("select", { class: "km-input km-mini" });
				[["seq", "顺序"], ["random", "随机"]].forEach(([v, t]) => rotMode.appendChild(h("option", { value: v, text: t })));
				refs.wpRotateMode = rotMode;
				rotMode.value = state.wallpaper.rotateMode === "random" ? "random" : "seq";
				rotMode.addEventListener("change", () => { state.wallpaper.rotateMode = rotMode.value; commit(); });
				sec.body.appendChild(h("div", { class: "km-inline km-wrap" }, [rotBtn, rotMode]));
				refs.wpRotateMin = sliderRow(sec.body, "切换间隔", 0.5, 60, 0.5, (v) => { state.wallpaper.rotateMin = v; commit(); }, 10);

				// Switch transition. `none` keeps the plain cut, which is also what
				// the OS "reduce motion" setting forces regardless of this choice.
				const transSel = h("select", { class: "km-input" });
				for (const t of TRANSITIONS) transSel.appendChild(h("option", { value: t.id, text: t.label }));
				refs.wpTransition = transSel;
				transSel.value = state.wallpaper.transition;
				transSel.addEventListener("change", () => { state.wallpaper.transition = transSel.value; commit(); });
				sec.body.appendChild(row("切换过场", transSel));

				const speedSel = h("select", { class: "km-input" });
				for (const s of TRANSITION_SPEEDS) speedSel.appendChild(h("option", { value: s.id, text: s.label }));
				refs.wpTransitionSpeed = speedSel;
				speedSel.value = state.wallpaper.transitionSpeed;
				speedSel.addEventListener("change", () => { state.wallpaper.transitionSpeed = speedSel.value; commit(); });
				sec.body.appendChild(row("过场速度", speedSel));

				// Direction only means something for the directional effects, so the
				// row is disabled for the rest instead of silently doing nothing.
				const dirSel = h("select", { class: "km-input" });
				[["left", "向左"], ["right", "向右"]].forEach(([v, t]) => dirSel.appendChild(h("option", { value: v, text: t })));
				refs.wpTransitionDir = dirSel;
				dirSel.value = state.wallpaper.transitionDir;
				dirSel.addEventListener("change", () => { state.wallpaper.transitionDir = dirSel.value; commit(); });
				refs.wpTransitionDirRow = row("过场方向", dirSel);
				sec.body.appendChild(refs.wpTransitionDirRow);
				body.appendChild(sec.el);
			}

			/* ── local media library ── */
			{
				const sec = section("本地素材库");
				refs.sections.push(sec);
				// Most-recent-first shortcuts. The library list below is ordered by
				// upload time, which is useless once it grows; these chips put the
				// handful of sources actually in rotation one click away.
				const recent = h("div", { class: "km-recent" });
				refs.recentList = recent;
				sec.body.appendChild(recent);
				const list = h("div", { class: "km-lib" });
				refs.libList = list;
				sec.body.appendChild(list);
				// Filter + order. Both re-render from the host list, so no state is
				// mutated and nothing needs to persist.
				const modeSel = h("select", { class: "km-input km-mini" });
				[["all", "全部"], ["image", "图片"], ["video", "视频"]].forEach(([v, t]) =>
					modeSel.appendChild(h("option", { value: v, text: t }))
				);
				modeSel.value = libView.mode;
				modeSel.addEventListener("change", () => { libView.mode = modeSel.value; renderLibrary(); });
				const sortSel = h("select", { class: "km-input km-mini" });
				[["newest", "最新"], ["oldest", "最早"], ["size", "按大小"]].forEach(([v, t]) =>
					sortSel.appendChild(h("option", { value: v, text: t }))
				);
				sortSel.value = libView.sort;
				sortSel.addEventListener("change", () => { libView.sort = sortSel.value; renderLibrary(); });
				sec.body.appendChild(
					h("div", { class: "km-inline km-wrap" }, [
						modeSel,
						sortSel,
						h("button", { class: "km-btn", type: "button", text: "刷新列表", onclick: () => renderLibrary() })
					])
				);
				body.appendChild(sec.el);
			}

			/* ── appearance ──────────────────────────────────────────────
			 * 原先这里是四个并列分节：界面透明 / 文字配色、界面主题、
			 * 强调色、标注字体颜色。它们改的是同一件事（界面长什么样），
			 * 拆开的结果是调一套配色要在四条折叠栏之间来回跳。现在收成
			 * 一个「外观」节，用 km-sub 分小标题，折叠态只剩一行。
			 */
			const appearance = section("外观");
			refs.sections.push(appearance);
			{
				const sec = appearance;
				sub(sec.body, "透明度");
				refs.uiTransparency = sliderRow(sec.body, "内容层透明", 0, 100, 1, (v) => { state.ui.transparency = v / 100; commit(); }, 0);

				// 全窗铺开：把皮肤从对话画布推到侧栏、面板、菜单、悬停态与
				// 窗口标题栏遮罩。它是**独立于上面那根滑条**的开关，因为它
				// 走的是另一套公式（以画布 alpha 为起点推导，而不是从 1 往下
				// 扣）。旧语义下这两件事被绑在一根滑条上，导致要么「什么都不
				// 变（默认 0）」，要么「内容层糊成一片」。
				const spreadToggle = h("input", { type: "checkbox" });
				refs.spread = spreadToggle;
				spreadToggle.addEventListener("change", () => {
					state.ui.spread = spreadToggle.checked;
					commit();
				});
				sec.body.appendChild(row("全窗铺开", spreadToggle));

				// 面板地板强度：这是「为什么壁纸滑条拉到底，中间那几条还是
				// 半实心」的唯一原因。铺开公式是 `max(alpha + lift, floor)`，
				// floor 是为「密排文字刚好还能读」设的硬下限（tip 0.55、
				// bg-layer-1 0.30、输入卡 0.22、侧栏 0.20），它不随壁纸
				// 不透明度下降。把它调到 0，面板就与画布同透。
				refs.floorScale = sliderRow(sec.body, "地板强度", 0, 100, 1, (v) => { state.ui.floorScale = v / 100; commit(); }, 100);

				sub(sec.body, "文字");
				// 文字亮度：dsh-claude-style 的 label 令牌是从画布色「推算」的
				// （--dsh-tone-ink-3: oklch(from var(--dsh-claude-custom-canvas-dark)
				// calc(l + .458) …)），画布越暗字就越暗 —— 面板全透之后正文
				// 会一起变灰。这个滑条直接把四档字色亮度写死在 body 上。
				refs.textBoost = sliderRow(sec.body, "文字亮度", 0, 100, 1, (v) => { state.ui.textBoost = v / 100; commit(); }, 60);

				// 字体族：Windows 上 -apple-system / BlinkMacSystemFont 都落空，
				// 中文就会掉进宿主字体栈里的 "PingFang SC" —— 而这台机器上的
				// PingFang SC 来自 pingfang_yahei.ttc（移植包），14px 下 hinting
				// 与字重和 macOS 原版差得远，看上去「字发虚、间距散」。这里直接
				// 覆盖 body 上的 --dsw-font-family，不动宿主文件。
				const fontSel = h("select", { class: "km-input" });
				for (const key of Object.keys(FONT_PRESETS)) fontSel.appendChild(h("option", { value: key, text: FONT_LABELS[key] || key }));
				refs.fontFamily = fontSel;
				fontSel.addEventListener("change", () => { state.ui.fontFamily = fontSel.value; commit(); });
				sec.body.appendChild(row("正文字体", fontSel));

				// 灰度抗锯齿：Chrome 在 Windows 默认走 ClearType 子像素渲染，
				// 白字压浅色壁纸时笔画边缘会出现彩边，这是「怪」的第二个来源。
				const smoothToggle = h("input", { type: "checkbox" });
				refs.fontSmoothing = smoothToggle;
				smoothToggle.addEventListener("change", () => {
					state.ui.fontSmoothing = smoothToggle.checked;
					commit();
				});
				sec.body.appendChild(row("灰度抗锯齿", smoothToggle));

				// 字重：宿主 CSS 里 400 占绝大多数，且没有 --dsh-*-font-weight
				// 变量可覆盖，只能对正文容器强制。只作用于消息正文与 markdown
				// 的段落/列表/表格文字，代码块与按钮保持原样。
				const weightSel = h("select", { class: "km-input" });
				for (const [v, t] of [[400, "标准（跟随宿主）"], [500, "中等加粗"], [600, "加粗"], [700, "很粗"]]) {
					weightSel.appendChild(h("option", { value: String(v), text: t }));
				}
				refs.fontWeight = weightSel;
				weightSel.addEventListener("change", () => { state.ui.fontWeight = Number(weightSel.value) || 400; commit(); });
				sec.body.appendChild(row("正文字重", weightSel));

				const tabs = h("div", { class: "km-tabs" });
				refs.contrastBtns = {};
				const CONTRASTS = [
					["theme", "跟随主题"],
					["auto", "自动适配"],
					["light", "浅底深字"],
					["dark", "深底浅字"]
				];
				for (const [id, label] of CONTRASTS) {
					const btn = h("button", { class: "km-tab", type: "button", text: label, onclick: () => {
						state.ui.contrast = id;
						// A hand-picked value must never be treated as auto-derived,
						// or the next bright wallpaper would silently revert it.
						state.ui.contrastFromTune = false;
						commit();
					} });
					refs.contrastBtns[id] = btn;
					tabs.appendChild(btn);
				}
				sec.body.appendChild(
					h("div", { class: "km-field" }, [
						h("div", { class: "km-label", text: "文字配色" }),
						tabs
					])
				);

				// Readability guard: when on, the sampler picks the scheme that
				// maximises the worst-tile contrast and, if even that fails the
				// AA threshold, raises the backing opacity to the computed floor.
				const readToggle = h("input", { type: "checkbox" });
				refs.readability = readToggle;
				readToggle.addEventListener("change", () => {
					state.ui.readability = readToggle.checked;
					commit();
				});
				sec.body.appendChild(row("自动保证可读性", readToggle));

				const readback = h("div", { class: "km-readback" });
				refs.readback = readback;
				sec.body.appendChild(readback);

				// Auto-tint: derive one hue from the wallpaper and re-point DSH's
				// neutral colour scales at it (same lightness, new hue), so the
				// whole interface follows the artwork. Off by default because it
				// is a whole-UI change rather than a per-surface one.
				const tintToggle = h("input", { type: "checkbox" });
				refs.autotint = tintToggle;
				tintToggle.addEventListener("change", () => {
					state.ui.autotint = tintToggle.checked;
					commit();
				});
				sec.body.appendChild(row("壁纸取色", tintToggle));

				const tintReadback = h("div", { class: "km-readback" });
				refs.tintReadback = tintReadback;
				sec.body.appendChild(tintReadback);

				// Auto-tune text colours: solve the six mark tones against the
				// artwork's own worst tile, so the reading text stays legible over
				// the busiest part of the picture instead of inheriting whatever
				// preset (or previous wallpaper) was set. This is why picking a
				// wallpaper visibly sharpens the text; turning it off leaves the
				// manually edited palette alone.
				const marksToggle = h("input", { type: "checkbox" });
				refs.tuneMarks = marksToggle;
				marksToggle.addEventListener("change", () => {
					state.ui.tuneMarks = marksToggle.checked;
					commit();
				});
				sec.body.appendChild(row("字色随壁纸调", marksToggle));

				// ── drawer glass ──
				// Only ever touches the panel surface (a real backdrop-filter over
				// whatever sits behind the drawer). The artwork's own blur is the
				// 模糊 slider in the 壁纸 section — the two are independent by design,
				// so there is deliberately no combined preset here.
				refs.glassBlur = sliderRow(sec.body, "面板毛玻璃", 0, 40, 1, (v) => {
					state.ui.glass.blur = v;
					commit();
				}, 0);
				refs.glassTint = sliderRow(sec.body, "玻璃通透度", 0, 100, 1, (v) => {
					state.ui.glass.tint = v / 100;
					commit();
				}, 100);

				// ── 分部位透明度 ──
				// 每根滑条是一个 0.2–1 的**系数**，不是绝对值：它在「该令牌自己的
				// 可读性地板」与「内容层总强度算出的整面」之间压缩。所以它永远
				// 越不过 CONTENT_FLOOR（菜单不会被读穿），也永远不会把总强度
				// 滑条架空（总强度 = 0 时这些滑条只是恢复原样，不制造新值）。
				sub(sec.body, "分区透明");
				refs.surfaceSliders = {};
				for (const group of SURFACE_GROUPS) {
					refs.surfaceSliders[group.id] = sliderRow(
						sec.body, group.label, 20, 100, 1,
						(v) => { state.ui.surfaces[group.id] = v / 100; commit(); },
						100
					);
				}

				// ── 界面主题 ──
				sub(sec.body, "界面主题");
				const note = h("div", { class: "km-label", text: "整套界面的配色。壁纸和透明层盖在它上面。" });
				sec.body.appendChild(note);
				const wrap = h("div", { class: "km-inline km-wrap" });
				refs.uiThemeBtns = {};
				for (const id of Object.keys(UI_THEMES)) {
					const btn = h("button", { class: "km-btn", type: "button", text: UI_THEMES[id].label, onclick: () => setUiTheme(id) });
					refs.uiThemeBtns[id] = btn;
					wrap.appendChild(btn);
				}
				sec.body.appendChild(wrap);
				// 主题可见度：这条滑条存在的唯一理由是「换主题之后画面必须
				// 看得出来」。令牌那条路被画布 alpha 乘掉了（0.08 时每通道只
				// 差 1.4/255），所以改成把强调色按这个比例混进底色 —— alpha
				// 不动，换的只是 rgba 的前三个数。默认 70%：实测画布 Δ19.7
				// 一眼可见，壁纸明暗纹理还剩 94%。
				refs.themeInk = sliderRow(sec.body, "主题可见度", 0, 100, 1, (v) => {
					state.ui.themeInk = clamp(v / 100, 0, 1);
					commit();
				}, 50);
				sec.body.appendChild(h("div", { class: "km-readback", text: "0 只改文字与边框，调高后强调色会染进面板和画布" }));
			}

			{
				// ── 强调色 ──
				// 这里曾经有 5 条输入改同一个值（圆点回显、hex 文本回显、取色器、
				// 文本框、12 个色板）。圆点和 hex 文本只是**显示**，却各占一个
				// 控件位；现在只留一个圆点做预览，改值动作交给取色器 / 文本框 /
				// 色板三种，回显合并进文本框本身。
				const sec = appearance;
				sub(sec.body, "强调色");
				const dot = h("span", { class: "km-accent-dot" });
				refs.accentDot = dot;

				const color = h("input", { type: "color", class: "km-color", value: "#4f83f2" });
				refs.accentColor = color;
				const text = h("input", { type: "text", class: "km-input km-mini", placeholder: "跟随原生" });
				refs.accentText = text;

				color.addEventListener("input", () => { text.value = color.value; setAccent(color.value); });
				text.addEventListener("change", () => setAccent(text.value));

				// One-click swatches; the picker + random + reset sit below them.
				const wrap = h("div", { class: "km-inline km-wrap" });
				refs.accentBtns = {};
				for (const preset of ACCENT_PRESETS) {
					const sw = h("button", {
						class: "km-swatch", type: "button", title: preset,
						style: `background:${preset}`,
						onclick: () => setAccent(preset)
					});
					refs.accentBtns[preset] = sw;
					wrap.appendChild(sw);
				}

				sec.body.appendChild(
					h("div", { class: "km-field" }, [
						h("div", { class: "km-label", text: "强调色（品牌 / 主按钮，跟随原生则不覆盖）" }),
						h("div", { class: "km-inline" }, [dot, color, text])
					])
				);
				sec.body.appendChild(wrap);
				sec.body.appendChild(
					h("div", { class: "km-inline km-wrap" }, [
						h("button", {
							class: "km-btn", type: "button", text: "随机",
							onclick: () => setAccent(randomAccent())
						}),
						h("button", {
							class: "km-btn", type: "button", text: "跟随原生",
							onclick: () => setAccent("")
						})
					])
				);
			}

			/* ── keymark colours ── */
			{
				const sec = appearance;
				sub(sec.body, "标注字体颜色");
				const lightTab = h("button", { class: "km-tab", type: "button", text: "浅色", onclick: () => { marksSchemeManual = true; state.marks.editScheme = "light"; commit(); } });
				const darkTab = h("button", { class: "km-tab", type: "button", text: "深色", onclick: () => { marksSchemeManual = true; state.marks.editScheme = "dark"; commit(); } });
				refs.tabLight = lightTab;
				refs.tabDark = darkTab;
				sec.body.appendChild(
					h("div", { class: "km-field" }, [
						h("div", { class: "km-label", text: "编辑配色" }),
						h("div", { class: "km-tabs" }, [lightTab, darkTab])
					])
				);

				refs.markInputs = {};
				for (const k of MARK_KEYS) {
					const color = h("input", { type: "color", class: "km-color" });
					const text = h("input", { type: "text", class: "km-input km-mini", placeholder: "继承" });
					const commitValue = () => setMark(k, text.value.trim());
					color.addEventListener("input", () => { text.value = color.value; commitValue(); });
					text.addEventListener("change", commitValue);
					refs.markInputs[k] = { color, text };
					sec.body.appendChild(
						h("div", { class: "km-field" }, [
							h("div", { class: "km-label", text: MARK_LABELS[k] }),
							h("div", { class: "km-inline" }, [
								color,
								text,
								h("button", { class: "km-btn km-mini", type: "button", text: "继承", onclick: () => setMark(k, "") })
							])
						])
					);
				}

				// ── 预设配色 ──
				// 预设只写 MARK_KEYS 那六个键（body 恒为空），所以它本来就
				// 是「标注字体颜色」的一排水龙头，不是一个独立功能。以前它
				// 占着一条独立折叠栏，让人以为还有第二套配色体系。
				sub(sec.body, "预设配色");
				const presetWrap = h("div", { class: "km-inline km-wrap" });
				refs.presetBtns = {};
				for (const id of Object.keys(PRESETS)) {
					const btn = h("button", { class: "km-btn", type: "button", text: PRESETS[id].label, onclick: () => applyPreset(id) });
					refs.presetBtns[id] = btn;
					presetWrap.appendChild(btn);
				}
				sec.body.appendChild(presetWrap);
			}

			// ── 高级：自检 + 导入导出。都是「偶尔用一次、平时不该看」的东西，
			// 收在同一节里并默认折叠，避免它们挤占上面真正天天调的控件。
			const advanced = section("高级", { keepOpen: false });
			refs.sections.push(advanced);

			/* ── upgrade check ── */
			{
				const sec = advanced;
				sub(sec.body, "皮肤锚点自检");
				const box = h("div", { class: "km-label", text: "尚未检查" });
				refs.upgradeBox = box;
				sec.body.appendChild(box);
				sec.body.appendChild(h("div", { class: "km-inline km-wrap" }, [
					h("button", {
						class: "km-btn", type: "button", text: "立即检查",
						onclick: () => {
							try {
								auditAnchors("manual");
								toast("已检查，结果见上方");
							} catch (error) {
								toast("检查失败：" + String((error && error.message) || error));
							}
							syncPanel();
						}
					}),
					h("button", {
						class: "km-btn", type: "button", text: "清空基线",
						title: "清空基线，下次重新列出全部",
						onclick: () => {
							try {
								window.localStorage.removeItem(ANCHOR_BASELINE_KEY);
								toast("锚点基线已清空");
							} catch {
								toast("清空失败");
							}
							syncPanel();
						}
					})
				]));
			}

			/* ── user css ── */
			{
				const sec = advanced;
				sub(sec.body, "自定义 CSS");
				const css = h("textarea", {
					class: "km-ta",
					rows: "8",
					spellcheck: "false",
					placeholder: "/* 例：\n:root { --km-body: #7dd3fc; }\n[data-chat-flow] h1 { text-shadow: 0 0 12px currentColor; }\n*/"
				});
				refs.userCss = css;
				sec.body.appendChild(css);
				const note = h("div", {
					class: "km-sub",
					// 这不是分组标题，只是文本框下面的一行灰字说明。分组器按
					// .km-sub 切段，不标这一笔的话「已保存（N 字符）」会和它下面
					// 的体检行一起被当成新一组，默认收起 —— 写错了当场看不见。
					"data-km-note": "1",
					text: "保存后立即生效，留空则关闭。共 " + USER_CSS_MAX + " 字符上限"
				});
				refs.userCssNote = note;
				sec.body.appendChild(note);
				// 体检结果单独一行：正常不出现，写坏了才亮红。
				const lint = h("div", { class: "km-readback km-lint" });
				refs.userCssLint = lint;
				sec.body.appendChild(lint);
				const paintLint = (raw) => {
					const result = lintUserCss(raw);
					if (result.ok) {
						lint.textContent = "";
						lint.removeAttribute("data-bad");
						return result;
					}
					lint.textContent = "✗ " + result.error + "　（其余规则照常生效）";
					lint.setAttribute("data-bad", "true");
					// 报错行必须当场可见：它所在的组可能是收起的（默认每组只
					// 开第一组），那样红色提示会被 display:none 一起带走，用户
					// 只看到「点了应用但什么都没发生」。
					revealGroupOf(lint);
					return result;
				};
				const apply = () => {
					state.ui.userCss = css.value;
					commit();
					if (refs.userCssNote) {
						const n = typeof state.ui.userCss === "string" ? state.ui.userCss.length : 0;
						refs.userCssNote.textContent = n >= USER_CSS_MAX
							? "已保存，超长部分被截断（上限 " + USER_CSS_MAX + " 字符）"
							: "已保存（" + n + " 字符）";
					}
					const result = paintLint(css.value);
					toast(result.ok ? "自定义 CSS 已生效" : "已保存，但有一段写错了");
				};
				// 边写边查：不提交，只更新红灯。in 500ms 的防抖由浏览器
				// 自己合并 —— 这里改的只是一个 textContent。
				css.addEventListener("input", () => paintLint(css.value));
				// Ctrl+Enter 应用：textarea 里的 Enter 是换行，不能抢。
				css.addEventListener("keydown", (event) => {
					if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
						event.preventDefault();
						apply();
					}
				});
				sec.body.appendChild(
					h("div", { class: "km-inline km-wrap" }, [
						h("button", { class: "km-btn", type: "button", text: "应用", onclick: apply }),
						h("button", {
							class: "km-btn", type: "button", text: "清空",
							onclick: () => {
								css.value = "";
								state.ui.userCss = "";
								commit();
								if (refs.userCssNote) refs.userCssNote.textContent = "已清空（自定义 CSS 关闭）";
								paintLint("");
								toast("已清空");
							}
						})
					])
				);
			}

			/* ── theme pack ── */
			{
				const sec = advanced;
				sub(sec.body, "主题包");
				const ta = h("textarea", { class: "km-ta", rows: "6", spellcheck: "false", placeholder: "导出后 JSON 显示在这里，粘回去点导入" });
				refs.io = ta;
				sec.body.appendChild(ta);
				const status = h("div", { class: "km-readback", text: "" });
				refs.ioStatus = status;
				sec.body.appendChild(status);
				// 导入前留一份快照。keymark 的整份状态就是一个 JSON 对象，
				// 所以「回滚」= 把旧对象写回去再 commit 一次，代价是零；
				// 不需要像带素材库的插件那样做事务日志。
				let previous = null;
				const ioStatus = (text, bad) => {
					status.textContent = text;
					if (bad) status.setAttribute("data-bad", "true");
					else status.removeAttribute("data-bad");
					// 状态行只在有话要说时才需要被看见；空串本来就被 CSS 收起。
					// 导入失败 / 需要撤销这类反馈落在被折叠的组里就等于没发生。
					if (text) revealGroupOf(status);
				};
				const exportValue = () => {
					const snap = exportSnapshot(state);
					ta.value = JSON.stringify(snap.value, null, 2);
					if (snap.hits.length) {
						const kinds = [];
						for (const hit of snap.hits) if (kinds.indexOf(hit.kind) < 0) kinds.push(hit.kind);
						ioStatus("已遮掉 " + snap.hits.length + " 处" + kinds.join(" / ") + "（诊断字段已移除）", true);
					} else {
						ioStatus("");
					}
					return ta.value;
				};
				const commitIn = (raw, source) => {
					let next;
					try {
						next = normalizeState(JSON.parse(raw));
					} catch (error) {
						ioStatus("解析失败：" + String((error && error.message) || error) + "　设置未改动", true);
						toast("导入失败，设置未改动");
						return false;
					}
					const snapshot = JSON.parse(JSON.stringify(state));
					try {
						state = next;
						commit();
					} catch (error) {
						// commit() 内部已按阶段 try/catch，走到这里说明是
						// 赋值之外的问题；照样退回，不给用户留半个状态。
						state = snapshot;
						previous = null;
						try { commit(); } catch { /* 回滚也失败：保持原样，交给用户手动重置 */ }
						ioStatus("应用失败，已退回：" + String((error && error.message) || error), true);
						toast("导入失败，已退回");
						return false;
					}
					previous = snapshot;
					ioStatus("已导入" + source + "　可点「撤销」退回", false);
					toast("已导入");
					return true;
				};
				sec.body.appendChild(
					h("div", { class: "km-inline km-wrap" }, [
						// One button does both: render the JSON into the box AND copy it.
						// The old pair of 「导出 / 复制」 was near-duplicate — 导出 already
						// filled the textarea, so 复制 only repeated that write.
						h("button", {
							class: "km-btn", type: "button", text: "导出并复制",
							onclick: () => {
								const text = exportValue();
								try {
									navigator.clipboard.writeText(text);
									toast("已导出到文本框并复制");
								} catch {
									toast("已导出到文本框（复制失败，请手动选择）");
								}
							}
						}),
						h("button", {
							class: "km-btn", type: "button", text: "导入",
							onclick: () => commitIn(ta.value, "")
						}),
						h("button", {
							class: "km-btn", type: "button", text: "撤销",
							title: "退回上一次导入之前的设置",
							onclick: () => {
								if (!previous) {
									ioStatus("没有可撤销的导入", false);
									toast("没有可撤销的导入");
									return;
								}
								state = previous;
								previous = null;
								commit();
								ioStatus("已退回导入前的设置", false);
								toast("已撤销上次导入");
							}
						}),
						h("button", {
							class: "km-btn", type: "button", text: "下载文件",
							onclick: () => {
								// Save the same JSON as a portable .dsh-theme.json so a
								// theme pack can be shared / re-imported from disk. The
								// textarea is filled too, so both routes stay in sync.
								const text = exportValue();
								try {
									const blob = new Blob([text], { type: "application/json" });
									const url = URL.createObjectURL(blob);
									const a = h("a", { href: url, download: "dsh-skin-keymark.dsh-theme.json" });
									(document.body || document.documentElement).appendChild(a);
									a.click();
									a.remove();
									setTimeout(() => URL.revokeObjectURL(url), 0);
									toast("已下载主题包文件");
								} catch {
									toast("下载失败，请手动复制文本框内容");
								}
							}
						}),
						h("button", {
							class: "km-btn km-danger", type: "button", text: "重置全部",
							onclick: () => {
								previous = JSON.parse(JSON.stringify(state));
								state = defaultState();
								commit();
								ioStatus("已重置　可点「撤销」退回", false);
								toast("已重置");
							}
						})
					])
				);

				const fileInput = h("input", { type: "file", accept: ".json,.dsh-theme.json,application/json", class: "km-hidden" });
				fileInput.addEventListener("change", () => {
					const file = fileInput.files && fileInput.files[0];
					fileInput.value = "";
					if (!file) return;
					const reader = new FileReader();
					reader.onload = () => commitIn(String(reader.result), "主题包文件");
					reader.onerror = () => {
						ioStatus("文件读取失败", true);
						toast("文件读取失败");
					};
					reader.readAsText(file);
				});
				sec.body.appendChild(
					h("div", { class: "km-inline km-wrap" }, [
						h("button", { class: "km-btn", type: "button", text: "导入文件", onclick: () => fileInput.click() }),
						fileInput
					])
				);
			}

			body.appendChild(appearance.el);
			body.appendChild(advanced.el);

			/* ── 顶部页签 ──
			 * 四个分区拉成一条时，滚到底要 1400px 以上，找一项得靠搜索框 ——
			 * 那就等于「面板本来没设计好」的承认。改成三个页签：同一时刻
			 * 只有一组控件在场，滚动条立刻退回到一屏左右。
			 *
			 * 只加属性，不改 DOM 归属：分区仍挂在 body 里（搜索索引、折叠态、
			 * 置灰逻辑全都按 refs.sections 遍历，搬走会连锁改三处）。
			 */
			const TAB_DEFS = [
				{ id: "wall", label: "背景", titles: ["壁纸", "本地素材库"] },
				{ id: "look", label: "外观", titles: ["外观"] },
				{ id: "pro", label: "高级", titles: ["高级"] }
			];
			const sectionTitleOf = (sec) => {
				const el = sec.el.querySelector(".km-sec-text");
				return el ? el.textContent : "";
			};
			let activeTab = "wall";
			const tabBar = h("div", { class: "km-tabbar", role: "tablist", "aria-label": "皮肤设置分类" });
			const tabButtons = [];
			const applyTab = () => {
				for (const sec of refs.sections) {
					const title = sectionTitleOf(sec);
					let tabId = "";
					for (const def of TAB_DEFS) {
						if (def.titles.indexOf(title) >= 0) { tabId = def.id; break; }
					}
					sec.el.setAttribute("data-km-tab", tabId);
					sec.el.setAttribute("data-km-tabon", tabId === activeTab ? "true" : "false");
				}
				for (const btn of tabButtons) {
					btn.setAttribute("data-active", btn._kmTab === activeTab ? "true" : "false");
					btn.setAttribute("aria-selected", btn._kmTab === activeTab ? "true" : "false");
				}
			};
			for (const def of TAB_DEFS) {
				const btn = h("button", {
					class: "km-tab", type: "button", text: def.label, role: "tab",
					onclick: () => {
						activeTab = def.id;
						applyTab();
						if (body) body.scrollTop = 0;
					}
				});
				btn._kmTab = def.id;
				tabButtons.push(btn);
				tabBar.appendChild(btn);
			}
			refs.tabs = tabBar;
			panelEl.insertBefore(tabBar, body);
			applyTab();
			// 页签生效时由 CSS 隐藏其它分区；搜索框一有字就整体退出页签模式，
			// 否则「搜到了但那一页不在前台」会变成一次假的空结果。
			panelEl.setAttribute("data-km-tabview", "on");

			/* ── 分区内分组折叠 ──
			 * 页签只解决「三类不要互相挤」，每一类内部仍可能很长（壁纸 1601px）。
			 * 这里把每个 `.km-sub` 变成可折叠的组标题，默认每组只开第一组。
			 * 必须在搜索索引建立之前跑：索引按 `.km-field/.km-row` 抓单元，
			 * 分组只打属性、不搬节点，所以顺序上不影响索引，但先跑能让
			 * `applyGroups` 的默认折叠在首屏就位，避免打开时闪一下全展开。
			 */
			for (const sec of refs.sections) groupify(sec);
			installGroupToggles();
			applyGroups(false);

			/* ── 搜索过滤 ──
			 * 每行可过滤单元 = `.km-field`（label + 控件）或 `.km-row`
			 * （一行开关）。索引文本一次性缓存：面板建好后 DOM 不再增删行，
			 * 只有值在变，所以每次输入都重新爬一遍 DOM 是白烧。
			 *
			 * 收纳属性 data-km-hide 而不是改 display：inline style 会和
			 * 回读（syncPanel 写 style）抢同一个属性，且关搜后要能一键复原。
			 */
			const findable = [];
			// 分区标题文本（标题按钮里带一个 ▾ 箭头，直接用 textContent 会把箭头
			// 也拼进来，同时也拿不到和 state.ui.collapsed 对齐的键）。
			const secTitle = (sec) => {
				if (!sec._kmTitle) {
					const t = sec.titleEl && sec.titleEl.querySelector(".km-sec-text");
					sec._kmTitle = t ? String(t.textContent || "") : "";
				}
				return sec._kmTitle;
			};
			for (const sec of refs.sections) {
				const units = sec.el.querySelectorAll(".km-field, .km-row");
				for (const el of units) {
					const labelEl = el.querySelector(".km-label-text") || el.querySelector(".km-label") || el;
					const own = (labelEl.textContent || "").trim();
					// 分区标题与分组标题也算命中面：「壁纸」「玻璃」这种词在
					// 标签里常常不出现，但用户就是按它想的。
					const hints = [own, secTitle(sec)];
					if (labelEl.title) hints.push(labelEl.title);
					const tip = el.querySelector("[title]");
					if (tip && tip.title) hints.push(tip.title);
					findable.push({ el, sec, text: hints.join(" ").toLowerCase(), own: own.toLowerCase() });
				}
			}
			const applyFind = () => {
				const q = String(findInput.value || "").trim().toLowerCase();
				let hits = 0;
				// 搜索期间退出页签模式：结果散在所有分区里，页签会把其中两页
				// 藏起来，用户会以为「搜不到」。清空搜索立刻回页签。
				if (panelEl) {
					if (q) panelEl.removeAttribute("data-km-tabview");
					else panelEl.setAttribute("data-km-tabview", "on");
				}
				// 分组折叠同步：搜索时全开（命中的行不能被收起藏掉），
				// 清空搜索时回到用户自己的状态（auto 或手工勾选）。
				applyGroups(!!q);
				if (!q) {
					for (const item of findable) item.el.removeAttribute("data-km-hide");
					for (const sec of refs.sections) sec.el.removeAttribute("data-km-hide");
					// 分组标题也一并复位：上一轮搜索可能把它们藏了。
					for (const el of body.querySelectorAll(".km-sub")) el.removeAttribute("data-km-hide");
					findCount.textContent = "";
					findEmpty.classList.add("km-hidden");
					// 搜索期间我们把命中的分区强制展开了（可能改动了 DOM 上的
					// data-collapsed / aria-expanded）。退出时必须按 state 把它
					// 还原，否则 DOM 说「展开」而 state 说「折叠」——下一轮点标题
					// 会按 state 算反，第一次点击像没反应。paint 是 section 闭包内
					// 私有的，这里就地按同一份 state 复算一次。
					const folded = state.ui && Array.isArray(state.ui.collapsed) ? state.ui.collapsed : [];
					for (const sec of refs.sections) {
						const isFolded = sec.keepOpen ? false : folded.indexOf(sec.titleEl.querySelector(".km-sec-text").textContent) >= 0;
						sec.el.setAttribute("data-collapsed", isFolded ? "true" : "false");
						sec.titleEl.setAttribute("aria-expanded", isFolded ? "false" : "true");
					}
					return;
				}
				for (const item of findable) {
					if (item.text.indexOf(q) >= 0) {
						item.el.removeAttribute("data-km-hide");
						hits++;
					} else {
						item.el.setAttribute("data-km-hide", "1");
					}
				}
				// 分区级：一个命中都没有的分区整块隐藏（连标题一起），否则
				// 会剩一堆空标题；有命中的分区强制展开，否则命中被折叠吞掉。
				for (const sec of refs.sections) {
					const any = Array.prototype.some.call(
						sec.el.querySelectorAll(".km-field, .km-row"),
						(el) => el.getAttribute("data-km-hide") !== "1"
					);
					if (any) sec.el.removeAttribute("data-km-hide");
					else sec.el.setAttribute("data-km-hide", "1");
					if (any) {
						sec.el.setAttribute("data-collapsed", "false");
						sec.titleEl.setAttribute("aria-expanded", "true");
					}
				}
				findCount.textContent = hits > 0 ? hits + " 项" : "";
				findEmpty.classList.toggle("km-hidden", hits > 0);

				/* 分组标题（.km-sub）得跟着走：它是纯文本标题，不属于任何
				 * .km-field，上面那轮循环根本不会碰它。若不处理，搜「模糊」
				 * 会看到「播放」这类标题孤零零挂着、下面一片空白。
				 * 判据：从它开始往后数，直到下一个 .km-sub / 分区结束，
				 * 只要还有一个可见单元就保留，否则一起隐藏。 */
				for (const sec of refs.sections) {
					const kids = Array.prototype.slice.call(sec.body.children);
					for (let i = 0; i < kids.length; i++) {
						const node = kids[i];
						if (!node.classList || !node.classList.contains("km-sub")) continue;
						let keep = false;
						for (let j = i + 1; j < kids.length; j++) {
							const nxt = kids[j];
							if (nxt.classList && nxt.classList.contains("km-sub")) break;
							if (!nxt.classList) continue;
							if (!nxt.classList.contains("km-field") && !nxt.classList.contains("km-row")) continue;
							if (nxt.getAttribute("data-km-hide") !== "1") { keep = true; break; }
						}
						if (keep) node.removeAttribute("data-km-hide");
						else node.setAttribute("data-km-hide", "1");
					}
				}
			};
			findInput.addEventListener("input", applyFind);
			findInput.addEventListener("keydown", (e) => {
				if (e.key === "Escape") { findInput.value = ""; applyFind(); }
			});

			(document.body || document.documentElement).appendChild(panelEl);
			syncPanel();
			return panelEl;
		}

		// 把最近一次自检结果渲染成一段人话：先看「有没有升级」，再看「有没有
		// 断了」，最后才是细节。顺序对应 troubleshooting 时的实际问法 ——
		// 用户先问「是不是刚升级才坏的」，再问「具体哪条坏了」。
		function describeUpgrade() {
			let last = null;
			try {
				const raw = window.localStorage.getItem(LAST_AUDIT_KEY);
				if (raw) last = JSON.parse(raw);
			} catch {
				last = null;
			}
			if (!last || typeof last !== "object") return "尚未检查";
			const host = (last.host && last.host.version) ? last.host.version + (last.host.commit ? " (" + last.host.commit + ")" : "") : "未知";
			const changes = Array.isArray(last.changes) ? last.changes : [];
			const dead = String(last.dead || "");
			const susp = String(last.suspicious || "");
			const tokens = String(last.missingTokens || "");
			const when = String(last.at || "").replace("T", " ").slice(0, 19);
			const lines = [];
			lines.push("宿主 " + host);
			lines.push("上次检查 " + when + " · " + String(last.mode || ""));
			if (changes.length) lines.push("版本变化：" + changes.join("；"));
			else lines.push("版本变化：无");
			if (dead) lines.push("已失效：" + dead);
			else lines.push("已失效：无");
			if (susp) lines.push("存疑：" + susp);
			if (tokens) lines.push("缺令牌：" + tokens);
			return lines.join("\n");
		}

		function setMark(key, value) {
			// A manual edit diverges from the named preset, so drop the preset
			// marker — otherwise the old preset button keeps glowing as if it
			// still described the current colours (stale UI).
			state.marks.preset = "";
			state.marks[state.marks.editScheme][key] = value;
			// Hand-written colours: revoke the boot-time re-derivation's permission
			// so the next launch leaves them alone. `ui.tuneMarks` stays as the user
			// set it — this only stops the plugin overwriting its own output, it is
			// not a second copy of that switch.
			state.ui.marksAuto = false;
			commit();
		}

		function applyPreset(id) {
			const preset = PRESETS[id];
			if (!preset) return;
			state.marks.preset = id;
			state.marks.light = Object.assign({}, preset.light);
			state.marks.dark = Object.assign({}, preset.dark);
			// A named preset is an explicit choice too, so it takes the same
			// protection a hand-typed colour does: revoke the boot-time
			// re-derivation's permission rather than silently restyling it on the
			// next launch. Picking a wallpaper again re-grants it in autoTune().
			state.ui.marksAuto = false;
			commit();
		}

		// Source the auto-tuner last ran for, so the same wallpaper is never tuned
		// twice in a row (e.g. a pick that re-commits the current URL).
		let tunedUrl = null;

		/**
		 * Run auto-tune for a wallpaper the user JUST chose. Only the explicit
		 * selection entry points call this — rotation and host-restore deliberately
		 * do not, so a carousel tick or a restart never rewrites manual settings.
		 */
		function tuneOnPick(url) {
			const clean = typeof url === "string" ? url.trim() : "";
			if (clean === "" || clean === tunedUrl) return;
			tunedUrl = clean;
			// Fire-and-forget: autoTune() commits its own result. Any failure
			// (unsafe URL, undecodable file, cross-origin sample) leaves the
			// current settings untouched.
			autoTune(clean).then((scheme) => {
				if (scheme) toast("已按壁纸自动调优");
			}).catch((error) => {
				diagReport("autotune-throw", String((error && error.message) || error));
			});
		}

		function commit() {
			// Isolate the three phases. Previously a throw inside the visual
			// layer (applyAll) aborted persistence AND syncPanel(), so one
			// failing control froze the whole panel — every active marker and
			// slider read-out is driven by syncPanel(), which made it look as
			// if "clicking any option does nothing at all".
			//
			// The recent-source log is updated here rather than at each of the
			// six call sites that assign `wallpaper.url`: commit() is the single
			// choke point they all pass through, so one hook cannot drift out of
			// sync with them.
			try {
				if (markRecent(state.wallpaper.url)) renderRecent();
			} catch (error) {
				diagReport("commit-recent-throw", String((error && error.message) || error));
			}
			try {
				applyAll();
			} catch (error) {
				diagReport("commit-applyAll-throw", String((error && error.message) || error));
			}
			try {
				scheduleSave();
			} catch (error) {
				diagReport("commit-save-throw", String((error && error.message) || error));
			}
			try {
				syncPanel();
			} catch (error) {
				diagReport("commit-sync-throw", String((error && error.message) || error));
			}
		}

		/**
		 * 面板是否「能被人看到」。两种宿主形式：独立抽屉挂在 document.body，
		 * 或设置页接走后挂在 React 容器里。用 isConnected 一次覆盖两种，
		 * 而不是假定父节点是 body —— 后者会让设置页里的面板永远不同步。
		 */
		function panelAttached() {
			return Boolean(panelEl && panelEl.isConnected);
		}

		function syncPanel() {
			if (!panelEl || !panelRefs || !panelAttached()) return;
			const refs = panelRefs;
			// Point the editor at the scheme the app is painting BEFORE reading it
			// back, so the swatches always show the layer being rendered.
			syncEditScheme();
			if (refs.upgradeBox) refs.upgradeBox.textContent = describeUpgrade();
			// 自定义 CSS 只在「不在编辑中」时回填：否则边打字边被覆盖成存档值。
			if (refs.userCss && document.activeElement !== refs.userCss) {
				refs.userCss.value = typeof state.ui.userCss === "string" ? state.ui.userCss : "";
			}
			const wp = state.wallpaper;
			if (refs.wpEnabled) refs.wpEnabled.checked = wp.enabled;
			if (refs.wpUrl && document.activeElement !== refs.wpUrl) {
				const isLocal = /^data:/i.test(wp.url) || /^\/dsh-skin-keymark\/media\//i.test(wp.url);
				refs.wpUrl.value = isLocal ? "" : wp.url;
				refs.wpUrl.placeholder = isLocal ? "（已使用本地素材）" : "图片或视频链接";
			}
			if (refs.wpKind) refs.wpKind.value = wp.kind;
			if (refs.wpFit) refs.wpFit.value = wp.fit;
			setRange(refs.wpBlur, Math.round(wp.blur));
			setRange(refs.wpDim, Math.round(wp.dim * 100));
			setRange(refs.wpContrast, Math.round(wp.contrast));
			setRange(refs.wpSaturate, Math.round(wp.saturate));
			setRange(refs.wpOpacity, Math.round(wp.opacity * 100));
			setRange(refs.wpGrain, Math.round(wp.grain * 100));
			// Quantise the displayed rate to the slider's own step so a stored
			// 1.0000000001 never shows up as a long decimal string.
			setRange(refs.wpRate, Math.round(clamp(isFinite(Number(wp.rate)) ? Number(wp.rate) : 1, RATE_MIN, RATE_MAX) * 20) / 20);
			if (refs.wpCross) refs.wpCross.checked = wp.crossfade === true;
			if (refs.wpOrbit) refs.wpOrbit.checked = wp.orbit === true;
			if (refs.wpFlip) refs.wpFlip.checked = wp.flip === true;
			if (refs.wpPauseBlur) refs.wpPauseBlur.checked = wp.pauseBlur !== false;
			if (refs.wpPauseBattery) refs.wpPauseBattery.checked = wp.pauseBattery !== false;
			if (refs.wpRotate) refs.wpRotate.checked = wp.rotate === true;
			if (refs.wpRotateUrls && document.activeElement !== refs.wpRotateUrls) {
				refs.wpRotateUrls.value = typeof wp.rotateUrls === "string" ? wp.rotateUrls : "";
			}
			if (refs.wpRotateMode) refs.wpRotateMode.value = wp.rotateMode === "random" ? "random" : "seq";
			setRange(refs.wpRotateMin, wp.rotateMin);

			// Greying out controls that cannot do anything: a knob that looks usable
			// but silently no-ops is exactly what makes a panel feel "full of dead
			// options". Reuses the same visual treatment as 过场方向 below.
			const isVideo = resolveKind(typeof wp.url === "string" ? wp.url.trim() : "", wp.kind) === "video";
			const dim = (el, row, off) => {
				if (el) el.disabled = off;
				if (row) row.style.opacity = off ? "0.45" : "";
			};
			// Playback controls only apply to <video>.
			dim(refs.wpRate, refs.wpRateRow, !isVideo);
			dim(refs.wpCross, refs.wpCrossRow, !isVideo);
			dim(refs.wpOrbit, refs.wpOrbitRow, !isVideo);
			dim(refs.wpPauseBlur, refs.wpPauseBlurRow, !isVideo);
			dim(refs.wpPauseBattery, refs.wpPauseBatteryRow, !isVideo);
			if (refs.wpTransition) refs.wpTransition.value = wp.transition;
			if (refs.wpTransitionSpeed) refs.wpTransitionSpeed.value = wp.transitionSpeed;
			if (refs.wpTransitionDir) {
				refs.wpTransitionDir.value = wp.transitionDir;
				// Direction is meaningless for fade / iris / zoom, so grey the row out.
				const directional = wp.transition === "slide" || wp.transition === "wipe";
				if (refs.wpTransitionDirRow) {
					refs.wpTransitionDirRow.style.opacity = directional ? "" : "0.45";
					refs.wpTransitionDir.disabled = !directional;
				}
			}
			if (refs.uiTransparency) setRange(refs.uiTransparency, Math.round(state.ui.transparency * 100));
			if (refs.textBoost) setRange(refs.textBoost, Math.round((isFinite(Number(state.ui.textBoost)) ? state.ui.textBoost : 0.6) * 100));
			if (refs.spread) refs.spread.checked = state.ui.spread === true;
			if (refs.floorScale) setRange(refs.floorScale, Math.round((isFinite(Number(state.ui.floorScale)) ? state.ui.floorScale : 1) * 100));
			if (refs.fontFamily) refs.fontFamily.value = fontFamilySpec(state.ui && state.ui.fontFamily).id;
			if (refs.fontSmoothing) refs.fontSmoothing.checked = !(state.ui && state.ui.fontSmoothing === false);
			if (refs.fontWeight) refs.fontWeight.value = String(isFinite(Number(state.ui && state.ui.fontWeight)) ? state.ui.fontWeight : 400);
			// 渐变与构图回填。渐变按钮用 data-active 高亮当前那张（同一按钮
			// 再点一次即关闭，所以它是开关而不是单选组）。
			if (refs.gradientBtns) {
				for (const g of GRADIENT_PRESETS) {
					const btn = refs.gradientBtns[g.id];
					if (btn) btn.setAttribute("data-active", wp.gradient === g.id ? "true" : "false");
				}
			}
			if (refs.gradientDrift) refs.gradientDrift.checked = state.ui.drift === true;
			// 漂移只对渐变有意义：图片/视频下把它置灰，避免出现"开了却没用"的死开关。
			if (refs.gradientDriftRow) {
				const onGradient = Boolean(wp.gradient);
				refs.gradientDriftRow.style.opacity = onGradient ? "" : "0.45";
				if (refs.gradientDrift) refs.gradientDrift.disabled = !onGradient;
			}
			setRange(refs.wpZoom, Math.round(clamp(isFinite(Number(wp.zoom)) ? Number(wp.zoom) : 100, ZOOM_MIN, ZOOM_MAX)));
			setRange(refs.wpPanX, Math.round(clamp(isFinite(Number(wp.panX)) ? Number(wp.panX) : 0, -50, 50)));
			setRange(refs.wpPanY, Math.round(clamp(isFinite(Number(wp.panY)) ? Number(wp.panY) : 0, -50, 50)));
			if (refs.readability) refs.readability.checked = state.ui.readability !== false;
			if (refs.autotint) refs.autotint.checked = state.ui.autotint === true;
			if (refs.tuneMarks) refs.tuneMarks.checked = state.ui.tuneMarks !== false;
			// Drawer glass (ui.glass) is written only by its own two sliders, so it
			// cannot drift when the artwork's 模糊 slider is adjusted.
			const gl = state.ui.glass || { blur: 0, tint: 1 };
			setRange(refs.glassBlur, gl.blur);
			setRange(refs.glassTint, Math.round(clamp(gl.tint, 0, 1) * 100));
			// 主题可见度：缺省 1（满强度）。normalizeState 已保证是 0–1 的数，
			// 这里只取整回显，避免滑条上出现 49.999999 这种长小数。
			if (refs.themeInk) {
				const ink = isFinite(Number(state.ui.themeInk)) ? clamp(Number(state.ui.themeInk), 0, 1) : 1;
				setRange(refs.themeInk, Math.round(ink * 100));
			}
			// 分部位系数：读回落盘值（缺省 1 = 100%），保证拖完之后重开面板
			// 读到的是真正生效的那个数，而不是滑条自己的初值。
			if (refs.surfaceSliders) {
				for (const group of SURFACE_GROUPS) {
					const el = refs.surfaceSliders[group.id];
					if (!el) continue;
					const v = state.ui.surfaces ? state.ui.surfaces[group.id] : SURFACE_SCALE_DEFAULT;
					setRange(el, Math.round(clamp(isFinite(Number(v)) ? Number(v) : 1, SURFACE_SCALE_MIN, 1) * 100));
					// 系数是纯乘法，任何总强度下都能算出不同的数，所以这里不禁用
					// 控件；只有「总强度 = 0 且系数 = 1」时该组整体不写值（归还宿主），
					// 但滑条本身仍然可拖 —— 拖下去就有意义，不该灰掉。
					el.disabled = false;
					const field = el.parentNode;
					if (field) field.style.opacity = "";
				}
			}
			if (refs.contrastBtns) {
				for (const id of Object.keys(refs.contrastBtns)) {
					refs.contrastBtns[id].setAttribute("data-active", state.ui.contrast === id ? "true" : "false");
				}
			}
			updateReadout();
			updateTintReadout();
			renderRecent();

			const scheme = state.marks.editScheme;
			if (refs.tabLight) refs.tabLight.setAttribute("data-active", scheme === "light" ? "true" : "false");
			if (refs.tabDark) refs.tabDark.setAttribute("data-active", scheme === "dark" ? "true" : "false");
			const colors = state.marks[scheme];
			for (const k of MARK_KEYS) {
				const ref = refs.markInputs && refs.markInputs[k];
				if (!ref) continue;
				const v = colors[k] || "";
				// Never overwrite a field the user is currently editing: a
				// commit triggered from elsewhere would otherwise clobber the
				// in-progress value and the edit would appear not to take.
				if (document.activeElement !== ref.text) ref.text.value = v;
				if (document.activeElement !== ref.color) {
					ref.color.value = /^#[0-9a-f]{6}$/i.test(v) ? v : "#888888";
				}
			}
			for (const id of Object.keys(PRESETS)) {
				const btn = refs.presetBtns && refs.presetBtns[id];
				if (btn) btn.setAttribute("data-active", state.marks.preset === id ? "true" : "false");
			}
			if (refs.uiThemeBtns) {
				const active = state.ui && UI_THEMES[state.ui.theme] ? state.ui.theme : "native";
				for (const id of Object.keys(refs.uiThemeBtns)) {
					refs.uiThemeBtns[id].setAttribute("data-active", active === id ? "true" : "false");
				}
			}

			// Accent: an empty value means "follow native", so the dot shows a
			// neutral ring and the text box reads 跟随原生 instead of a stale colour.
			const accent = normalizeAccent(state.accent);
			if (refs.accentDot) refs.accentDot.style.background = accent || "transparent";
			if (refs.accentColor && document.activeElement !== refs.accentColor) {
				refs.accentColor.value = accent || "#4f83f2";
			}
			if (refs.accentText && document.activeElement !== refs.accentText) {
				refs.accentText.value = accent || "";
			}
			if (refs.accentBtns) {
				for (const key of Object.keys(refs.accentBtns)) {
					refs.accentBtns[key].setAttribute("data-active", accent === key ? "true" : "false");
				}
			}
		}

		// The drawer must start below the native Windows caption buttons. Electron
		// paints those through titleBarOverlay ABOVE all page content, so a drawer
		// anchored at top:0 places its own × directly under the native ✕. The
		// preload normally publishes --dsh-windows-titlebar-height, but the CSS
		// fallback for that variable is 0px, so any miss (stale bundle, variable
		// not yet written, non-primary window) re-creates the overlap. Resolve the
		// inset in JS instead: the CSS variable first, then the shell frame's own
		// titlebar padding, then 40px whenever the shell flags a Windows titlebar.
		function titlebarInset() {
			if (!document.documentElement.hasAttribute("data-windows-titlebar")) return 0;
			const cs = getComputedStyle(document.documentElement);
			const raw = parseFloat(cs.getPropertyValue("--dsh-windows-titlebar-height"));
			if (raw > 0) return raw;
			const frame = document.querySelector('[class*="_frame"]');
			if (frame) {
				const pt = parseFloat(getComputedStyle(frame).paddingTop);
				if (pt > 0) return pt;
			}
			return 40;
		}

		function setPanelOpen(open) {
			const el = ensurePanel();
			// Recompute on every open: a window that gains or loses its native
			// titlebar (maximise/restore, moving between displays) would otherwise
			// keep a stale offset.
			const inset = titlebarInset();
			el.style.top = inset > 0 ? inset + "px" : "";
			el.setAttribute("data-open", open ? "true" : "false");
			if (open) {
				syncPanel();
				// applyAcrylic() no-ops while the panel is absent, so a saved glass
				// setting has to be re-applied the moment the panel exists.
				applyAcrylic();
				// Refresh the host media library on each open: it may have been
				// changed by another window, and the list is cheap to re-fetch.
				renderLibrary();
			}
			try { document.dispatchEvent(new CustomEvent(PANEL_EVENT)); } catch { /* ignore */ }
		}

		function togglePanel() {
			const el = ensurePanel();
			// 面板已搬进设置页时，抽屉语义不存在了：再给它写 data-open
			// 只会让设置页里那块内容闪一下。改为指路，快捷键不至于「按了没反应」。
			if (el.getAttribute("data-hosted") === "true") {
				toast("皮肤已移到 设置 → 皮肤（⌘, / Ctrl+,）");
				return;
			}
			setPanelOpen(el.getAttribute("data-open") !== "true");
		}

		function isPanelOpen() {
			if (!panelEl) return false;
			// 被设置页接走后「开着」= 那块 DOM 还在文档里；抽屉形态才看
			// data-open。用 data-open 判会在设置页里恒为 true（挂载时被写成
			// true 以便 .km-body 正常展开），进而让 focus 恢复逻辑误判。
			if (panelEl.getAttribute("data-hosted") === "true") return panelAttached();
			return panelEl.getAttribute("data-open") === "true";
		}

		// ── local image intake ─────────────────────────────────────────────

		function compressImage(file, maxDim, quality) {
			return new Promise((resolve) => {
				const reader = new FileReader();
				reader.onload = () => {
					const img = new Image();
					img.onload = () => {
						const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
						const width = Math.max(1, Math.round(img.width * scale));
						const height = Math.max(1, Math.round(img.height * scale));
						const canvas = document.createElement("canvas");
						canvas.width = width;
						canvas.height = height;
						const g = canvas.getContext("2d");
						if (!g) { resolve(null); return; }
						g.drawImage(img, 0, 0, width, height);
						try { resolve(canvas.toDataURL("image/jpeg", quality)); } catch { resolve(null); }
					};
					img.onerror = () => resolve(null);
					img.src = reader.result;
				};
				reader.onerror = () => resolve(null);
				reader.readAsDataURL(file);
			});
		}

		/**
		 * Upload a local video to the host media library and return its
		 * same-origin URL. Videos cannot be inlined as data URLs (the 1.8 MB
		 * cap is far below any clip), and a same-origin blob keeps the
		 * readability sampler's canvas untainted.
		 */
		async function uploadMedia(file) {
			try {
				const ext = (file.name.split(".").pop() || "").toLowerCase();
				const res = await fetch(`${MEDIA_URL}?ext=${encodeURIComponent(ext)}`, {
					method: "POST",
					headers: { "content-type": "application/octet-stream" },
					body: file
				});
				const data = await res.json().catch(() => null);
				if (!res.ok || !data || data.ok !== true || typeof data.url !== "string") {
					const code = data && data.error && data.error.code;
					toast(code === "payload-too-large" ? "视频过大（上限 512 MB）" : "视频上传失败");
					return null;
				}
				return data.url;
			} catch {
				toast("视频上传失败");
				return null;
			}
		}

		async function handleFile(file) {
			if (!file) return;
			if (/^video\//.test(file.type) || VIDEO_EXT.test(file.name || "")) {
				const url = await uploadMedia(file);
				if (!url) return;
				state.wallpaper.url = url;
				state.wallpaper.gradient = "";
				state.wallpaper.kind = "video";
				state.wallpaper.enabled = true;
				commit();
				tuneOnPick(url);
				toast("已应用本地视频");
				// The host just recorded this clip in its library index.
				renderLibrary();
				return;
			}
			if (!/^image\//.test(file.type)) {
				toast("仅支持图片或视频文件");
				return;
			}
			let url = await compressImage(file, 1920, 0.85);
			if (url && url.length > MAX_DATA_URL) url = await compressImage(file, 1280, 0.7);
			if (url && url.length > MAX_DATA_URL) url = await compressImage(file, 900, 0.6);
			if (!url || url.length > MAX_DATA_URL) {
				toast("图片过大，压缩后仍超出上限");
				return;
			}
			state.wallpaper.url = url;
			state.wallpaper.gradient = "";
			state.wallpaper.kind = "image";
			state.wallpaper.enabled = true;
			commit();
			tuneOnPick(url);
			toast("已应用本地图片");
		}

		// ── React slot entry ───────────────────────────────────────────────

		/**
		 * 设置页里的「皮肤」一栏。
		 *
		 * 面板 DOM 只有一份（ensurePanel 建的那块），这里做的是**搬家**而不是
		 * 复制：挂载时把 #dsh-skin-keymark-panel 挪进自己的容器并打上
		 * data-hosted，卸载时摘下来放回 body 并复位成隐藏抽屉。
		 *
		 * 之所以搬而不是重画：面板里有十几个 `refs.*` 直接指向建好的节点，
		 * 重画等于把 syncPanel() 的全部回读逻辑重写一遍；而搬家零成本，且
		 * 两种入口（设置页 / Alt+W 抽屉）天然共享同一份状态与同一批控件。
		 */
		function SkinSettingsSection() {
			const hostRef = React.useRef(null);
			React.useEffect(() => {
				const host = hostRef.current;
				if (!host) return undefined;
				const el = ensurePanel();
				el.setAttribute("data-hosted", "true");
				el.setAttribute("data-open", "true");
				host.appendChild(el);
				// 设置页里没有抽屉的浮层语义，毛玻璃与标题栏内缩都该停手，
				// 但它俩都是幂等的，直接调一次让样式回到「干净」即可。
				el.style.top = "";
				applyAcrylic();
				syncPanel();
				renderLibrary();
				try { document.dispatchEvent(new CustomEvent(PANEL_EVENT)); } catch { /* ignore */ }
				return () => {
					el.removeAttribute("data-hosted");
					el.setAttribute("data-open", "false");
					// 放回 body 而不是直接删：快捷键 Alt+W 仍走抽屉路径，
					// 直接删会让下次 ensurePanel() 重建、丢光已绑定的 refs。
					const parent = el.parentNode;
					if (parent && parent !== document.body && parent !== document.documentElement) {
						parent.removeChild(el);
					}
					(document.body || document.documentElement).appendChild(el);
					try { document.dispatchEvent(new CustomEvent(PANEL_EVENT)); } catch { /* ignore */ }
				};
			}, []);
			return React.createElement("div", { className: "dsh-skin-keymark-settings", ref: hostRef });
		}

		// ── lifecycle ──────────────────────────────────────────────────────

		function whenBody(fn) {
			if (document.body) {
				fn();
				return;
			}
			document.addEventListener("DOMContentLoaded", fn, { once: true });
		}

		/** True while the caret is inside a text field — shortcuts must not steal it. */
		function typingTarget(node) {
			if (!node || typeof node.tagName !== "string") return false;
			const tag = node.tagName.toLowerCase();
			if (tag === "textarea" || tag === "select") return true;
			if (tag === "input") {
				const type = String(node.type || "text").toLowerCase();
				return type !== "range" && type !== "checkbox" && type !== "color";
			}
			return Boolean(node.isContentEditable);
		}

		/**
		 * Skin hotkeys, kept deliberately few:
		 *   Alt+W   toggle the drawer
		 *   Alt+[ / Alt+]   step playback rate down / up
		 *   Alt+0   reset the rate to 1x
		 * Alt is the modifier because DSH already claims Ctrl+R/F5 and the bare
		 * letter keys belong to the app. Returns true when the event was consumed.
		 */
		function handleSkinShortcut(event) {
			if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return false;
			if (typingTarget(event.target)) return false;
			const wp = state.wallpaper;
			const step = (dir) => {
				const cur = clamp(isFinite(Number(wp.rate)) ? Number(wp.rate) : 1, RATE_MIN, RATE_MAX);
				// Quantise to the slider grid so the read-out never shows 1.1500000001.
				const next = clamp(Math.round((cur + dir * 0.25) * 20) / 20, RATE_MIN, RATE_MAX);
				if (next === cur) return;
				wp.rate = next;
				commit();
				toast(`播放倍速 ${next}×`);
			};
			switch (event.code) {
				case "KeyW":
					togglePanel();
					break;
				case "BracketLeft":
					step(-1);
					break;
				case "BracketRight":
					step(1);
					break;
				case "Digit0":
					if (clamp(isFinite(Number(wp.rate)) ? Number(wp.rate) : 1, RATE_MIN, RATE_MAX) === 1) return false;
					wp.rate = 1;
					commit();
					toast("播放倍速 1×");
					break;
				default:
					return false;
			}
			event.preventDefault();
			return true;
		}

		/*
		 * 皮肤快捷键装配 —— 只保留 Alt 系。
		 *
		 * 历史教训（2026-10-12）：这里曾经额外做「Ctrl+R / F5 刷新兜底」，前提是
		 * 「DSH Desktop 正式版没绑 Ctrl+R（main.js 里 role:"reload" 只在 development
		 * 分支）」。这个前提只对了一半，结论是错的：框架自己用
		 * dsh-client-ui-sidebar-right/lib/client.js 注册了 `page.refresh`（desktop 档
		 * code KeyR + modifiers ["primary"]），主进程对主框架的非 priority 按键**不**
		 * preventDefault，所以 Ctrl+R 是能正常到达渲染层的宿主快捷键。
		 * 而旧实现在 **capture 阶段**调 preventDefault()，会先把 defaultPrevented 置位，
		 * 宿主随后的快捷键处理链看到该标志即放弃 ⇒ 宿主自带的 Ctrl+R 刷新被吞掉。
		 * 刷新兜底与 dshDesktop.keyboard 订阅已整体删除，宿主快捷键恢复原生行为。
		 *
		 * 现在只用**冒泡阶段**处理 Alt 系皮肤键，并尊重 defaultPrevented：任何已被
		 * 宿主先认领的按键都不会被本插件改写语义。
		 */
		function installSkinShortcuts() {
			const onKeyDown = (event) => {
				if (event.defaultPrevented) return;
				handleSkinShortcut(event);
			};
			document.addEventListener("keydown", onKeyDown, false);
			// 装机自报：覆盖历史遗留的 reloadDiag 值，避免读到「reload-installed」
			// 这种已失效的旧结论。
			diagReport("shortcuts-alt-only", "native-host-shortcuts", "reloadDiag");
			diagReport("titlebar-inset", String(titlebarInset()), "titlebarDiag");
			return () => document.removeEventListener("keydown", onKeyDown, false);
		}

		const plugin = {
			name: "dsh-skin-keymark",
			/*
			 * 不声明 inject：激活不再被服务注入门控（slots 晚到时由 registerPanelEntry
			 * 轮询补挂）。历史教训：inject 不满足 → 客户端行判 failed → web boot 致命
			 * 恢复 → profile 全部插件被禁（2026-10-04 的 profile 反复被重置即此因）。
			 */
			inject: [],
			apply(ctx) {
				try {
				diagReport("apply-start", "enter");
				const slots = softService(ctx, "slots");
				/*
				 * 只能经 ctx.get(name) 软取：客户端 cordis 对**未在 inject 里声明的
				 * 服务做属性访问会直接抛错**（"cannot get property \"theme\" without
				 * inject"）。旧代码的 `|| ctx.theme` 正是 2026-10-04 把 web boot 打崩、
				 * 触发致命恢复洗掉 profile 的那一行。
				 */
				diagReport("services", "slots=" + String(Boolean(slots)) + " effect=" + String(typeof ctx.effect) + " on=" + String(typeof ctx.on) + " get=" + String(typeof ctx.get));

				state = normalizeState(loadLocal());
				diagReport("state-loaded", JSON.stringify(state).slice(0, 400));

				ctx.effect(() => {
					try {
						ensurePanelStyles();
						whenBody(() => {
							try {
								applyAll();
								diagReport("applyAll", "ok");
							} catch (error) {
								diagReport("applyAll-throw", error);
							}
						});
						pullHost();
					} catch (error) {
						diagReport("effect-body-throw", error);
					}
					return () => {
						uninstallPowerGuard();
						stopLumWatch();
						stopCross();
						stopOrbit();
						stopRotate();
						clearTransition();
						lastAppliedUrl = null;
						if (panelEl) {
							// The panel node is about to be detached; drop the inline
							// glass declarations with it so a re-apply starts clean.
							panelEl.style.removeProperty("backdrop-filter");
							panelEl.style.removeProperty("-webkit-backdrop-filter");
							panelEl.style.removeProperty("background");
						}
						removeWallpaperEl();
						removeGrainEl();
						// Unmount, not a repaint: strip everything we wrote rather
						// than falling back to the palette, so a disabled plugin
						// leaves no trace of its theme on <body>.
						removeAllTokens();
						// 引擎签名随卸载一起作废：见 resetApplySigs() 的注释，
						// 留着会让「关掉插件再打开」少应用一半样式。
						resetApplySigs();
						tintReset();
						const markStyle = document.getElementById(STYLE_ID);
						if (markStyle) markStyle.remove();
						const userStyle = document.getElementById(USER_STYLE_ID);
						if (userStyle) userStyle.remove();
						stopUserCssGuard();
						const panelStyle = document.getElementById(PANEL_STYLE_ID);
						if (panelStyle) panelStyle.remove();
						const panel = document.getElementById(PANEL_ID);
						if (panel) panel.remove();
						// Drop the cached node references too; otherwise a
						// re-apply would keep handing out the detached panel.
						panelEl = null;
						panelRefs = null;
						const toastEl = document.getElementById(TOAST_ID);
						if (toastEl) toastEl.remove();
						if (saveTimer) {
							clearTimeout(saveTimer);
							saveTimer = null;
						}
					};
				});

				if (typeof ctx.on === "function") {
					ctx.effect(() => {
						const off = ctx.on("theme/change", () => {
							// ThemePresenter 在同一个事件里才写 body[data-ds-dark-theme]，
							// 订阅顺序不确定；延后一帧再重算，保证 isDarkTheme() 读到已落定值。
							const defer = typeof requestAnimationFrame === "function"
								? requestAnimationFrame
								: (cb) => setTimeout(cb, 16);
							defer(() => {
								applyAll();
								// The app just swapped which layer wins, so the colour
								// editor has to follow it — otherwise an open panel keeps
								// pointing at the now-shadowed slot. syncPanel() runs
								// syncEditScheme() itself; the extra call keeps the tabs
								// honest even when the panel was never built.
								if (isPanelOpen()) syncPanel();
								else syncEditScheme();
							});
						});
						return () => { if (typeof off === "function") off(); };
					});
				}

				// 皮肤快捷键（仅 Alt 系）随插件生命周期一起装卸。
				ctx.effect(() => installSkinShortcuts());

				/*
				 * 面板入口：软取 slots 并在服务晚到时轮询重试。激活绝不依赖服务注入
				 * 是否就绪 —— 旧版本 inject: ["slots"] 一旦不满足，整条客户端行会被
				 * 判 failed，触发 web boot 致命恢复并连带禁用 profile 里的所有插件。
				 */
				let slotDispose = null;
				let slotTimer = null;
				const registerPanelEntry = () => {
					let api = null;
					try { api = (ctx.get && ctx.get("slots")) || slots || null; } catch { api = null; }
					if (!api || typeof api.inject !== "function" || typeof api.register !== "function") return false;
					try {
						slotDispose = api.inject("settings.section", () =>
							api.register(
								{ name: "settings.section", id: "keymark", order: 40, label: () => "皮肤" },
								() => React.createElement(SkinSettingsSection)
							)
						);
						diagReport("slot-registered", "settings.section");
					} catch (error) {
						diagReport("slot-register-throw", error);
					}
					return true;
				};
				if (!registerPanelEntry()) {
					let tries = 0;
					slotTimer = setInterval(() => {
						tries += 1;
						if (registerPanelEntry()) {
							clearInterval(slotTimer);
							slotTimer = null;
						} else if (tries >= 40) {
							clearInterval(slotTimer);
							slotTimer = null;
							diagReport("slot-timeout", "slots 服务 10s 内未就绪");
						}
					}, 250);
				}
				ctx.effect(() => () => {
					if (slotTimer) { clearInterval(slotTimer); slotTimer = null; }
					if (typeof slotDispose === "function") { try { slotDispose(); } catch { /* ignore */ } slotDispose = null; }
				});
				} catch (error) {
					diagReport("apply-throw", error);
				}
			}
		};

		exports.default = plugin;
		exports.name = plugin.name;
		exports.inject = plugin.inject;
		exports.apply = plugin.apply;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		return module.exports;
	}
});
