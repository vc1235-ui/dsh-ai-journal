/**
 * dsh-ai-journal · Client 半区（浏览器插件 bundle，契约 v2）
 *
 * 职责：注册左侧栏「AI 日报」入口与 main keyed 面板（key = 'ai-journal'），
 * 按 API-CONTRACT.md v2 消费 Host 的只读接口，展示日报 / 周报。
 *
 * 结构：一个目标（无目标时一个项目）一个大块，块内按「行动 → 结果 → 待办」展示；
 * 待办全量渲染，每条提供「新开对话」按钮，把 suggestedPrompt 预填进新会话。
 *
 * 约束：
 * - 纯 JS，无 JSX、无编译步骤，只用 React.createElement。
 * - 只 require('react')，不 import 任何 @deepseek-ai/* 运行时包。
 * - 不设置字号与字族，完全继承 DSH 全局；层级用字重、颜色、间距表达。
 * - 样式用 ctx.effect 注入 <style> 并在清理时移除，只用 --dsw-alias-* 变量上色。
 */
window.__ModuleLoader__.load({
	id: 'dsh-ai-journal',
	factory: (require) => {
		'use strict';

		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react');
		const h = React.createElement;

		const PANEL_ID = 'ai-journal';
		const API_PATH = '/ai-journal/api';
		const STYLE_ATTR = 'data-dsh-ai-journal-style';
		const DEFAULT_TZ = 'Asia/Singapore';
		const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
		const GOAL_PHASES = {
			active: '进行中',
			completed: '已完成',
			blocked: '受阻',
			paused: '已暂停'
		};
		const TODO_STATES = {
			pending: '待办',
			in_progress: '进行中',
			completed: '已完成',
			active: '进行中',
			blocked: '受阻',
			paused: '已暂停'
		};
		const ACTION_EMPTY_HINT = '本周期没有记录到可概括的行动。';
		const RESULT_EMPTY_HINT = '本周期没有标记完成的结果';
		const TODO_EMPTY_HINT = '本周期没有遗留待办。';
		const DONUT_RADIUS = 34;
		const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
		const DIST_SEGMENT_CLASSES = ['aij-distSeg0', 'aij-distSeg1', 'aij-distSeg2', 'aij-distSeg3'];
		const OPEN_NOTICE_MS = 3000;

		// ---------------------------------------------------------------------
		// 小工具：日期、时间、格式化
		// ---------------------------------------------------------------------

		/** 两位补零。 */
		function pad2(value) {
			return value < 10 ? '0' + value : String(value);
		}

		/** 本地时区的 YYYY-MM-DD。 */
		function dateKeyOf(date) {
			return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
		}

		/** 把 YYYY-MM-DD 解析成本地时区当天 00:00。 */
		function parseKey(key) {
			const parts = String(key).split('-');
			const year = Number(parts[0]);
			const month = Number(parts[1]);
			const day = Number(parts[2]);
			if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return new Date();
			return new Date(year, month - 1, day);
		}

		/** 在日期键上加减天数（跨月/跨年由 Date 处理）。 */
		function shiftKey(key, days) {
			const date = parseKey(key);
			date.setDate(date.getDate() + days);
			return dateKeyOf(date);
		}

		/** 某一日期所在周的周一（本地时区）。 */
		function weekStartKey(key) {
			const date = parseKey(key);
			const weekday = date.getDay();
			// 周日是 0，需要回到 6 天前；其余回到 1 - weekday 天前。
			const diff = weekday === 0 ? -6 : 1 - weekday;
			date.setDate(date.getDate() + diff);
			return dateKeyOf(date);
		}

		/** 今天（本地时区）的日期键。 */
		function todayKey() {
			return dateKeyOf(new Date());
		}

		/** 浏览器时区，取不到时回落到契约默认值。 */
		function resolveTimeZone() {
			try {
				const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
				return typeof zone === 'string' && zone ? zone : DEFAULT_TZ;
			} catch (error) {
				return DEFAULT_TZ;
			}
		}

		/** HH:MM。 */
		function formatClock(value) {
			const ms = Number(value);
			if (!Number.isFinite(ms)) return '';
			const date = new Date(ms);
			return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
		}

		/** HH:MM:SS，用于「更新于」。 */
		function formatUpdated(value) {
			const ms = Number(value);
			if (!Number.isFinite(ms)) return '';
			const date = new Date(ms);
			return formatClock(ms) + ':' + pad2(date.getSeconds());
		}

		/** 单个时间点：日报只给时间，周报补上月日。 */
		function formatMoment(value, withDate) {
			const ms = Number(value);
			if (!Number.isFinite(ms)) return '';
			if (!withDate) return formatClock(ms);
			const date = new Date(ms);
			return date.getMonth() + 1 + '月' + date.getDate() + '日 ' + formatClock(ms);
		}

		/** MM-DD，用于「待跟进」来源日期。 */
		function formatMonthDay(value) {
			const ms = Number(value);
			if (!Number.isFinite(ms)) return '';
			const date = new Date(ms);
			return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
		}

		/**
		 * 活动时间区间。日报只显示时间；周报带月日，跨天时两端都带。
		 * @returns 形如 "09:12–11:40" / "11月5日 09:12–11:40" / "11月3日 22:10–11月5日 01:20"
		 */
		function formatSpan(first, last, kind) {
			const hasFirst = Number.isFinite(first);
			const hasLast = Number.isFinite(last);
			if (!hasFirst && !hasLast) return '';
			const start = hasFirst ? first : last;
			const end = hasLast ? last : first;
			const withDate = kind === 'weekly';
			const startText = formatMoment(start, withDate);
			const sameDay = dateKeyOf(new Date(start)) === dateKeyOf(new Date(end));
			if (sameDay) {
				return Math.abs(end - start) >= 60000 ? startText + '–' + formatClock(end) : startText;
			}
			return startText + '–' + formatMoment(end, true);
		}

		/** 非空字符串判断。 */
		function hasText(value) {
			return typeof value === 'string' && value.trim() !== '';
		}

		/** 安全取数字，缺失时回落。 */
		function num(value, fallback) {
			return Number.isFinite(value) ? value : fallback === undefined ? 0 : fallback;
		}

		/** 安全取数组。 */
		function listOf(value) {
			return Array.isArray(value) ? value : [];
		}

		/** 阶段的中文标签。 */
		function phaseLabel(phase) {
			return typeof phase === 'string' && GOAL_PHASES[phase] ? GOAL_PHASES[phase] : '';
		}

		/** 阶段徽章的样式类：进行中强调、受阻报错、其余弱化。 */
		function phaseBadgeClass(phase) {
			if (phase === 'active') return 'aij-badge aij-badgeGoal';
			if (phase === 'blocked') return 'aij-badge aij-badgeBlocked';
			return 'aij-badge';
		}

		/** 把 HTTP / 契约错误翻译成中文提示。 */
		function readableError(body, fallback) {
			const code = body && typeof body.code === 'string' ? body.code : '';
			const detail = body && hasText(body.message) ? body.message.trim() : '';
			let base = fallback || '加载失败，请稍后重试。';
			if (code === 'unavailable') {
				base = 'AI 日报服务暂不可用：当前 DSH 运行环境缺少会话查询能力。';
			} else if (code === 'bad-request') {
				base = '请求参数无效，请刷新后重试。';
			} else if (code === 'forbidden') {
				base = '请求被拒绝：AI 日报只允许在本机同源访问。';
			} else if (code === 'internal') {
				base = '生成日报时出错，请稍后重试。';
			}
			return detail ? base + '（' + detail + '）' : base;
		}

		// ---------------------------------------------------------------------
		// 样式：不设置字号/字族，只用 --dsw-alias-* 主题变量上色；
		// 满高布局、内容区滚动、窄屏可用，文本控件用 min-height + padding。
		// ---------------------------------------------------------------------

		const CSS_TEXT = [
			'.aij-page{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);line-height:1.5}',
			'.aij-header{flex:none;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);padding:20px clamp(16px,4vw,40px) 12px}',
			'.aij-headerInner{box-sizing:border-box;margin:0 auto;max-width:960px;min-width:0}',
			'.aij-headRow{align-items:flex-start;display:flex;flex-wrap:wrap;gap:12px 16px;justify-content:space-between}',
			'.aij-headText{min-width:0}',
			'.aij-title{margin:0;font-weight:600;line-height:1.3}',
			'.aij-subtitle{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
			'.aij-refreshBtn{box-sizing:border-box;flex:none;min-height:32px;padding:6px 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;line-height:1.5;cursor:pointer;transition:background-color .15s,border-color .15s}',
			'.aij-refreshBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.aij-refreshBtn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.7}',
			'.aij-toolbar{align-items:center;display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:14px;min-width:0}',
			'.aij-segment{display:inline-flex;flex:none;gap:2px;padding:3px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1)}',
			'.aij-segmentBtn{min-height:28px;padding:3px 14px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;line-height:1.5;cursor:pointer}',
			'.aij-segmentBtn:hover{color:var(--dsw-alias-label-primary)}',
			'.aij-segmentBtn[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.aij-nav{align-items:center;display:inline-flex;flex:1 1 220px;gap:4px;min-width:0}',
			'.aij-navBtn{box-sizing:border-box;min-width:28px;min-height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:2px 6px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;line-height:1;cursor:pointer}',
			'.aij-navBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.aij-navBtn:disabled{color:var(--dsw-alias-border-l3);cursor:default}',
			'.aij-navLabel{min-width:0;max-width:100%;color:var(--dsw-alias-label-secondary);line-height:1.5;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.aij-todayBtn{box-sizing:border-box;flex:none;min-height:28px;padding:3px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;line-height:1.5;cursor:pointer}',
			'.aij-todayBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.aij-todayBtn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
			'.aij-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;padding:0 clamp(16px,4vw,40px) 48px}',
			'.aij-content{box-sizing:border-box;margin:0 auto;max-width:960px;min-width:0;padding-top:16px}',
			'.aij-statusLine{margin:0 0 12px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
			'.aij-overview{box-sizing:border-box;margin:0 0 12px;padding:16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
			'.aij-overviewMeta{display:flex;flex-wrap:wrap;gap:2px 16px;margin-top:0;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
			'.aij-kpiRow{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px 16px;margin-top:14px;min-width:0}',
			'.aij-kpi{min-width:0;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:8px}',
			'.aij-kpiValue{font-size:1.5em;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
			'.aij-kpiLabel{margin-top:2px;color:var(--dsw-alias-label-tertiary);line-height:1.4;overflow-wrap:anywhere}',
			'.aij-chartsSection{margin:0 0 12px;min-width:0}',
			'.aij-charts{display:grid;gap:12px;grid-template-columns:repeat(3,minmax(0,1fr));min-width:0}',
			'.aij-chartCard{box-sizing:border-box;min-width:0;padding:16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}',
			'.aij-chartWide{grid-column:1/-1}',
			'@media (max-width:900px){.aij-charts{grid-template-columns:repeat(2,minmax(0,1fr))}.aij-kpiRow{grid-template-columns:repeat(3,minmax(0,1fr))}}',
			'@media (max-width:560px){.aij-charts{grid-template-columns:minmax(0,1fr)}.aij-kpiRow{grid-template-columns:repeat(2,minmax(0,1fr))}}',
			'.aij-chartTitle{margin:0 0 10px;font-weight:600;line-height:1.4}',
			'.aij-chartSvg{display:block;width:100%;max-width:520px;margin:0 auto}',
			'.aij-donutSvg{max-width:150px}',
			'.aij-donutTrack{fill:none;stroke:var(--dsw-alias-bg-mask-2);stroke-width:10}',
			'.aij-donutArc{fill:none;stroke:var(--dsw-alias-state-success-primary);stroke-width:10;stroke-linecap:round}',
			'.aij-donutPercent{fill:var(--dsw-alias-label-primary);font-weight:600}',
			'.aij-chartLegend{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);line-height:1.6;text-align:center}',
			'.aij-chartFootnote{margin:10px 0 0;color:var(--dsw-alias-label-tertiary);line-height:1.6}',
			'.aij-distBar{display:flex;width:100%;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-mask-2);min-height:10px}',
			'.aij-distSegment{min-height:10px}',
			'.aij-distSeg0{background:var(--dsw-alias-state-business-primary)}',
			'.aij-distSeg1{background:var(--dsw-alias-state-success-primary)}',
			'.aij-distSeg2{background:var(--dsw-alias-state-warn-primary)}',
			'.aij-distSeg3{background:var(--dsw-alias-label-dimmed)}',
			'.aij-distLegend{display:flex;flex-direction:column;gap:4px;margin:10px 0 0;padding:0;list-style:none}',
			'.aij-distLegendItem{align-items:center;display:flex;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary);line-height:1.5}',
			'.aij-swatch{flex:none;width:10px;min-height:10px;border-radius:3px}',
			'.aij-distLegendName{min-width:0;overflow-wrap:anywhere}',
			'.aij-distLegendCount{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
			'.aij-weekBar{fill:var(--dsw-alias-state-business-primary)}',
			'.aij-weekBarSlot{cursor:default}',
			'.aij-weekValue{fill:var(--dsw-alias-label-primary);opacity:0;transition:opacity .12s;pointer-events:none}',
			'.aij-weekBarSlot:hover .aij-weekValue,.aij-weekBarSlot:focus-within .aij-weekValue{opacity:1}',
			'.aij-weekAxis{fill:var(--dsw-alias-label-tertiary)}',
			'.aij-weekBase{stroke:var(--dsw-alias-border-l1);stroke-width:1}',
			'.aij-block{box-sizing:border-box;margin:0 0 12px;padding:16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
			'.aij-blockHead{align-items:center;display:flex;flex-wrap:wrap;gap:6px 8px;min-width:0}',
			'.aij-blockTitle{flex:0 1 auto;margin:0;font-weight:600;line-height:1.4;overflow-wrap:anywhere;min-width:0}',
			'.aij-blockMeta{margin-left:auto;color:var(--dsw-alias-label-tertiary);line-height:1.5;font-variant-numeric:tabular-nums}',
			'.aij-blockSummary{margin:8px 0 0;color:var(--dsw-alias-label-secondary);line-height:1.6;overflow-wrap:anywhere}',
			'.aij-blockSection{margin-top:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l1)}',
			'.aij-blockSectionTitle{margin:0 0 6px;color:var(--dsw-alias-label-secondary);font-weight:600;line-height:1.4}',
			'.aij-badge{flex:none;display:inline-flex;align-items:center;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;color:var(--dsw-alias-label-secondary);line-height:1.5;white-space:nowrap}',
			'.aij-badgeGoal{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
			'.aij-badgeBlocked{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
			'.aij-badgeWarn{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-label)}',
			'.aij-badgeFollowup{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-label)}',
			'.aij-actions{margin:0;padding-left:1.4em;color:var(--dsw-alias-label-primary);line-height:1.7}',
			'.aij-actions li{overflow-wrap:anywhere}',
			'.aij-actions li+li{margin-top:2px}',
			'.aij-actions li::marker{color:var(--dsw-alias-label-tertiary)}',
			'.aij-results{display:flex;flex-direction:column;gap:4px;list-style:none;margin:0;padding:0}',
			'.aij-result{align-items:flex-start;display:flex;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary);line-height:1.6}',
			'.aij-resultMark{flex:none;color:var(--dsw-alias-state-business-primary)}',
			'.aij-resultText{min-width:0;overflow-wrap:anywhere}',
			'.aij-resultDeliverable{align-items:flex-start}',
			'.aij-resultMarkDeliverable{color:var(--dsw-alias-state-business-primary)}',
			'.aij-deliverableMain{min-width:0}',
			'.aij-deliverableLink{display:inline-flex;flex-wrap:wrap;align-items:center;gap:2px 8px;min-height:26px;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;line-height:1.5;text-align:left;cursor:pointer;overflow-wrap:anywhere}',
			'.aij-deliverableLink:hover .aij-deliverableText{text-decoration:underline}',
			'.aij-deliverableAction{flex:none;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
			'.aij-deliverablePath{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);line-height:1.5;overflow-wrap:anywhere;user-select:text}',
			'.aij-muted{margin:0;color:var(--dsw-alias-label-tertiary);line-height:1.6}',
			'.aij-todos{display:flex;flex-direction:column;gap:6px;list-style:none;margin:0;padding:0}',
			'.aij-todoRow{align-items:flex-start;display:flex;flex-wrap:wrap;gap:4px 8px;min-width:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}',
			'.aij-todoMain{align-items:flex-start;display:flex;flex:1 1 240px;gap:8px;min-width:0}',
			'.aij-todoBody{min-width:0}',
			'.aij-todoText{line-height:1.5;overflow-wrap:anywhere}',
			'.aij-todoMeta{color:var(--dsw-alias-label-tertiary);line-height:1.5;overflow-wrap:anywhere}',
			'.aij-newSessionBtn{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;min-height:26px;padding:2px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;line-height:1.5;cursor:pointer;white-space:nowrap}',
			'.aij-newSessionBtn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary)}',
			'.aij-failures{margin:12px 0 0;color:var(--dsw-alias-label-tertiary);line-height:1.6;overflow-wrap:anywhere}',
			'.aij-openNotice{margin:8px 0 0;color:var(--dsw-alias-label-secondary);line-height:1.5}',
			'.aij-followups{box-sizing:border-box;margin:0 0 12px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-state-warn-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
			'.aij-followupsHead{align-items:center;display:flex;flex-wrap:wrap;gap:6px 8px;min-width:0}',
			'.aij-followupsTitle{margin:0;font-weight:600;line-height:1.4;min-width:0;overflow-wrap:anywhere}',
			'.aij-countBadge{box-sizing:border-box;flex:none;min-width:20px;min-height:20px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-mask-2);color:var(--dsw-alias-label-secondary);line-height:1.4;text-align:center}',
			'.aij-followupsHint{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);line-height:1.6;overflow-wrap:anywhere}',
			'.aij-followupList{display:flex;flex-direction:column;gap:8px;margin:10px 0 0;padding:0;list-style:none;min-width:0}',
			'.aij-followupRow{align-items:flex-start;display:flex;flex-wrap:wrap;gap:6px 12px;justify-content:space-between;min-width:0}',
			'.aij-followupMain{align-items:flex-start;display:flex;flex:1 1 240px;gap:8px;min-width:0}',
			'.aij-followupBody{min-width:0}',
			'.aij-followupText{overflow-wrap:anywhere}',
			'.aij-followupMeta{margin-top:2px;color:var(--dsw-alias-label-tertiary);line-height:1.5;overflow-wrap:anywhere}',
			'.aij-followupActions{align-items:center;display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;min-width:0}',
			'.aij-dismissBtn{box-sizing:border-box;flex:none;min-height:26px;padding:2px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;line-height:1.5;cursor:pointer}',
			'.aij-dismissBtn:hover:not(:disabled){color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-label)}',
			'.aij-dismissBtn:disabled{opacity:.6;cursor:default}',
			'.aij-followupIgnored{align-items:center;display:flex;flex-wrap:wrap;gap:4px 8px;margin:10px 0 0;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
			'.aij-undoBtn{box-sizing:border-box;flex:none;min-height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;line-height:1.5;cursor:pointer}',
			'.aij-undoBtn:disabled{opacity:.6;cursor:default}',
			'.aij-followupNotice{margin:8px 0 0;line-height:1.5;overflow-wrap:anywhere}',
			'.aij-followupNoticeError{color:var(--dsw-alias-state-error-primary)}',
			'.aij-followupNoticeWarn{color:var(--dsw-alias-state-warn-label)}',
			'.aij-section{box-sizing:border-box;margin:0 0 12px;padding:16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
			'.aij-sectionHead{align-items:baseline;display:flex;flex-wrap:wrap;gap:4px 8px;justify-content:space-between;margin-bottom:10px}',
			'.aij-sectionTitle{margin:0;font-weight:600;line-height:1.4}',
			'.aij-sectionMeta{color:var(--dsw-alias-label-tertiary);line-height:1.5}',
			'.aij-dayTable{display:flex;flex-direction:column;gap:2px}',
			'.aij-dayGrid{display:grid;grid-template-columns:minmax(88px,1.3fr) minmax(40px,.6fr) minmax(80px,1.6fr) minmax(44px,.7fr);align-items:center;gap:8px;padding:6px 8px;border-radius:8px;line-height:1.5}',
			'.aij-dayGrid:nth-child(even){background:var(--dsw-alias-bg-base)}',
			'.aij-dayGridHead{padding-bottom:4px;border-bottom:.5px solid var(--dsw-alias-border-l1);border-radius:0;color:var(--dsw-alias-label-tertiary)}',
			'.aij-dayLabel{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
			'.aij-dayNum{align-items:center;display:flex;gap:6px;min-width:0;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
			'.aij-dayBarTrack{flex:1;min-width:20px;height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden}',
			'.aij-dayBar{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary)}',
			'.aij-empty{display:flex;flex-direction:column;align-items:center;padding:48px 20px;text-align:center;color:var(--dsw-alias-label-tertiary);line-height:1.6}',
			'.aij-emptyGlyph{margin-bottom:12px;color:var(--dsw-alias-label-caption)}',
			'.aij-emptyTitle{margin:0 0 6px;color:var(--dsw-alias-label-secondary);font-weight:600;line-height:1.4}',
			'.aij-emptyHint{max-width:440px;margin:0;line-height:1.6;overflow-wrap:anywhere}',
			'.aij-errorBox{margin:8px 0;padding:16px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}',
			'.aij-errorTitle{margin:0 0 6px;color:var(--dsw-alias-state-error-primary);font-weight:600;line-height:1.4}',
			'.aij-errorText{margin:0;color:var(--dsw-alias-label-secondary);line-height:1.6;overflow-wrap:anywhere}',
			'.aij-errorActions{display:flex;gap:8px;margin-top:12px}',
			'.aij-retryBtn{box-sizing:border-box;min-height:32px;padding:6px 16px;border:.5px solid var(--dsw-alias-state-business-primary);border-radius:999px;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;line-height:1.5;cursor:pointer}',
			'.aij-retryBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.aij-loadingText{margin:0 0 12px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
			'.aij-skeletonCard{margin:0 0 12px;padding:16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}',
			'.aij-skeletonLine{height:10px;border-radius:6px;background:var(--dsw-alias-border-l1);animation:aij-pulse 1.4s ease-in-out infinite}',
			'.aij-skeletonLine+.aij-skeletonLine{margin-top:8px}',
			'.aij-footnote{margin:16px 0 0;color:var(--dsw-alias-label-caption);line-height:1.6}',
			'.aij-page :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
			'@keyframes aij-pulse{0%{opacity:.45}50%{opacity:.9}100%{opacity:.45}}',
			'@media (prefers-reduced-motion: reduce){.aij-skeletonLine{animation:none}}',
			'@media (max-width:720px){.aij-header{padding:16px 16px 10px}.aij-nav{flex:1 1 100%;order:3}.aij-scroll{padding:0 16px 36px}.aij-block,.aij-overview,.aij-section,.aij-chartCard{padding:14px}.aij-dayGrid{grid-template-columns:minmax(76px,1.2fr) minmax(34px,.6fr) minmax(64px,1.4fr) minmax(36px,.7fr);gap:6px}.aij-blockMeta{margin-left:0}}',
			'@media (max-width:420px){.aij-subtitle{display:none}.aij-dayGrid{grid-template-columns:minmax(66px,1.1fr) minmax(30px,.6fr) minmax(52px,1.2fr) minmax(32px,.7fr)}.aij-dayBarTrack{display:none}}'
		].join('\n');

		/** 把样式插到 <head>；disposer 由 ctx.effect 在卸载时调用。 */
		function installStyles() {
			if (typeof document === 'undefined' || !document.head) return () => {};
			const previous = document.querySelector('style[' + STYLE_ATTR + ']');
			if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
			const tag = document.createElement('style');
			tag.setAttribute(STYLE_ATTR, '');
			tag.textContent = CSS_TEXT;
			document.head.appendChild(tag);
			return () => {
				if (tag.parentNode) tag.parentNode.removeChild(tag);
			};
		}

		// ---------------------------------------------------------------------
		// 左侧栏图标：接收 { size, active }，用 currentColor 上色。
		// ---------------------------------------------------------------------

		function JournalIcon(props) {
			const size = props && Number.isFinite(props.size) ? props.size : 16;
			const active = !!(props && props.active);
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: active ? 1.9 : 1.6,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
					className: 'aij-icon'
				},
				h('rect', { key: 'frame', x: 4.5, y: 3.5, width: 15, height: 17, rx: 2.5 }),
				h('path', { key: 'line', d: 'M8.5 8h7' }),
				h('path', { key: 'bar-1', d: 'M8.5 17v-2.5' }),
				h('path', { key: 'bar-2', d: 'M12 17v-4.5' }),
				h('path', { key: 'bar-3', d: 'M15.5 17v-6.5' })
			);
		}

		// ---------------------------------------------------------------------
		// 通用展示组件
		// ---------------------------------------------------------------------

		function Badge(props) {
			return h('span', { className: props.className || 'aij-badge' }, props.label);
		}

		/** 「新开对话」：把建议提示词预填进新会话输入框。 */
		function NewSessionButton(props) {
			const todo = props.todo || {};
			const subject = hasText(todo.content) ? todo.content : hasText(todo.text) ? todo.text : '未命名事项';
			return h(
				'button',
				{
					type: 'button',
					className: 'aij-newSessionBtn',
					title: '用建议提示词新开一个 DSH 会话',
					'aria-label': '新开对话：' + subject,
					onClick: () => {
						if (typeof props.onStartSession === 'function') props.onStartSession(todo);
					}
				},
				'新开对话'
			);
		}

		/** 一条待办（todo 或 goal），全量渲染，右侧带「新开对话」。 */
		function TodoRow(props) {
			const todo = props.todo || {};
			const isGoal = todo.kind === 'goal';
			const statusLabel = TODO_STATES[todo.status] || (isGoal ? '目标' : '待办');
			const badgeClass = isGoal
				? todo.status === 'blocked'
					? 'aij-badge aij-badgeBlocked'
					: 'aij-badge aij-badgeGoal'
				: 'aij-badge';
			const badgeLabel = isGoal ? '目标 · ' + statusLabel : statusLabel;
			const context = [hasText(todo.project) ? todo.project : '', hasText(todo.sessionTitle) ? todo.sessionTitle : '']
				.filter(hasText)
				.join(' · ');
			return h(
				'li',
				{ className: 'aij-todoRow' },
				h(
					'div',
					{ className: 'aij-todoMain' },
					h(Badge, { className: badgeClass, label: badgeLabel }),
					h(
						'div',
						{ className: 'aij-todoBody' },
						h('div', { className: 'aij-todoText' }, hasText(todo.content) ? todo.content : '未命名事项'),
						context ? h('div', { className: 'aij-todoMeta' }, context) : null
					)
				),
				h(NewSessionButton, { todo: todo, onStartSession: props.onStartSession })
			);
		}

		/** 一个目标或项目块：标题行 + 块摘要 + 行动 / 结果 / 待办。 */
		function BlockCard(props) {
			const block = props.block || {};
			const isGoal = block.kind === 'goal';
			const label = hasText(block.label) ? block.label : isGoal ? '目标' : '项目';
			const title = hasText(block.title) ? block.title : isGoal ? '未命名目标' : '未命名项目';
			const phase = phaseLabel(block.phase);
			const actions = listOf(block.actions).filter((action) => action && hasText(action.text));
			const results = listOf(block.results).filter((result) => result && hasText(result.text));
			const todos = listOf(block.todos).filter((todo) => todo && hasText(todo.content));
			const stats = block.stats && typeof block.stats === 'object' ? block.stats : {};
			const metaItems = [];
			if (Number.isFinite(stats.sessions)) metaItems.push(stats.sessions + ' 个会话');
			if (Number.isFinite(stats.turns)) metaItems.push(stats.turns + ' 轮');
			const span = formatSpan(block.firstTime, block.lastTime, props.kind);
			if (span) metaItems.push(span);

			return h(
				'section',
				{ className: 'aij-block' },
				h(
					'div',
					{ className: 'aij-blockHead' },
					h(Badge, { className: isGoal ? 'aij-badge aij-badgeGoal' : 'aij-badge', label: label }),
					h('h2', { className: 'aij-blockTitle' }, title),
					phase ? h(Badge, { className: phaseBadgeClass(block.phase), label: phase }) : null,
					metaItems.length ? h('span', { className: 'aij-blockMeta' }, metaItems.join(' · ')) : null
				),
				hasText(block.summary) ? h('p', { className: 'aij-blockSummary' }, block.summary) : null,
				h(
					'div',
					{ className: 'aij-blockSection' },
					h('h3', { className: 'aij-blockSectionTitle' }, '行动'),
					actions.length
						? h(
								'ol',
								{ className: 'aij-actions' },
								actions.map((action, index) => h('li', { key: index }, action.text))
							)
						: h('p', { className: 'aij-muted' }, ACTION_EMPTY_HINT)
				),
				h(
					'div',
					{ className: 'aij-blockSection' },
					h('h3', { className: 'aij-blockSectionTitle' }, '结果'),
					h(ResultsSection, {
						results: results,
						onOpenDeliverable: (item) => {
							if (typeof props.onOpenDeliverable === 'function') props.onOpenDeliverable(item, props.blockKey);
						},
						openNotice: props.openNotice
					})
				),
				h(
					'div',
					{ className: 'aij-blockSection' },
					h('h3', { className: 'aij-blockSectionTitle' }, '待办'),
					todos.length
						? h(
								'ul',
								{ className: 'aij-todos' },
								todos.map((todo, index) =>
									h(TodoRow, {
										key: (hasText(todo.sessionId) ? todo.sessionId : 'todo') + '-' + index,
										todo: todo,
										onStartSession: props.onStartSession
									})
								)
							)
						: h('p', { className: 'aij-muted' }, TODO_EMPTY_HINT)
				)
			);
		}

		/** 交付物展示名：优先描述，其次文件名。 */
		function deliverableLabel(item) {
			if (hasText(item.text)) return item.text;
			if (!hasText(item.path)) return '交付物';
			const normalized = String(item.path).replace(/[\\/]+$/, '');
			const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
			return index === -1 ? normalized : normalized.slice(index + 1);
		}

		/** 结果列表：交付物是可点击文件行（POST 打开），其余是完成项。 */
		function ResultsSection(props) {
			const results = listOf(props.results);
			return h(
				'div',
				null,
				results.length
					? h(
							'ul',
							{ className: 'aij-results' },
							results.map((result, index) =>
								result.kind === 'deliverable'
									? h(DeliverableRow, {
											key: (result.path || 'deliverable') + '-' + index,
											item: result,
											onOpen: props.onOpenDeliverable
										})
									: h(
											'li',
											{ key: index, className: 'aij-result' },
											h('span', { className: 'aij-resultMark', 'aria-hidden': 'true' }, '✓'),
											h('span', { className: 'aij-resultText' }, result.text)
										)
							)
						)
					: h('p', { className: 'aij-muted' }, RESULT_EMPTY_HINT),
				props.openNotice ? h('p', { className: 'aij-openNotice', role: 'status' }, props.openNotice) : null
			);
		}

		/** 交付物行：描述/文件名可点击打开，原始路径可复制并带全路径 title。 */
		function DeliverableRow(props) {
			const item = props.item || {};
			const path = hasText(item.path) ? item.path : '';
			const text = deliverableLabel(item);
			return h(
				'li',
				{ className: 'aij-result aij-resultDeliverable' },
				h('span', { className: 'aij-resultMark aij-resultMarkDeliverable', 'aria-hidden': 'true' }, '↗'),
				h(
					'div',
					{ className: 'aij-deliverableMain' },
					h(
						'button',
						{
							type: 'button',
							className: 'aij-deliverableLink',
							title: path ? '打开：' + path : '打开交付物',
							'aria-label': '打开交付物：' + text,
							onClick: () => {
								if (typeof props.onOpen === 'function') props.onOpen(item);
							}
						},
						h('span', { className: 'aij-deliverableText' }, text),
						h('span', { className: 'aij-deliverableAction', 'aria-hidden': 'true' }, '打开')
					),
					path ? h('span', { className: 'aij-deliverablePath', title: path }, path) : null
				)
			);
		}

		/** 完成率环：弧长 = 完成 /（完成 + 进行中 + 待办），分母 0 显示 0%。 */
		function CompletionChart(props) {
			const stats = props.stats || {};
			const completed = num(stats.todosCompleted);
			const inProgress = num(stats.todosInProgress);
			const pending = num(stats.todosPending);
			const total = completed + inProgress + pending;
			const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
			const dash = (percent / 100) * DONUT_CIRCUMFERENCE;
			const ariaLabel =
				'完成率 ' + percent + '%：完成 ' + completed + ' 项，进行中 ' + inProgress + ' 项，待办 ' + pending + ' 项';
			return h(
				'section',
				{ className: 'aij-chartCard' },
				h('h3', { className: 'aij-chartTitle' }, '完成率'),
				h(
					'svg',
					{ className: 'aij-chartSvg aij-donutSvg', viewBox: '0 0 96 96', role: 'img', 'aria-label': ariaLabel },
					h('circle', { className: 'aij-donutTrack', cx: 48, cy: 48, r: DONUT_RADIUS }),
					h('circle', {
						className: 'aij-donutArc',
						cx: 48,
						cy: 48,
						r: DONUT_RADIUS,
						transform: 'rotate(-90 48 48)',
						strokeDasharray: dash.toFixed(2) + ' ' + DONUT_CIRCUMFERENCE.toFixed(2)
					}),
					h(
						'text',
						{ className: 'aij-donutPercent', x: 48, y: 48, textAnchor: 'middle', dominantBaseline: 'central' },
						percent + '%'
					)
				),
				h('p', { className: 'aij-chartLegend' }, '完成 ' + completed + ' · 进行中 ' + inProgress + ' · 待办 ' + pending)
			);
		}

		/** 块分布条：按块 sessions 占比堆叠，最多 4 段（超出后其余归「其它」）。 */
		function DistributionChart(props) {
			const segments = distributionSegments(props.blocks);
			const total = segments.reduce((sum, segment) => sum + segment.sessions, 0);
			const ariaLabel = segments.length
				? '块分布：' + segments.map((segment) => segment.name + ' ' + segment.sessions + ' 会话').join('，')
				: '块分布：暂无数据';
			return h(
				'section',
				{ className: 'aij-chartCard' },
				h('h3', { className: 'aij-chartTitle' }, '块分布'),
				segments.length
					? h(
							'div',
							{ className: 'aij-distBar', role: 'img', 'aria-label': ariaLabel },
							segments.map((segment) =>
								h('div', {
									key: segment.key,
									className: 'aij-distSegment ' + segment.className,
									style: { width: segment.percent + '%' },
									title: segment.title
								})
							)
						)
					: h('p', { className: 'aij-muted' }, '暂无可统计的块分布。'),
				segments.length
					? h(
							'ul',
							{ className: 'aij-distLegend' },
							segments.map((segment) =>
								h(
									'li',
									{ key: segment.key, className: 'aij-distLegendItem' },
									h('span', { className: 'aij-swatch ' + segment.className, 'aria-hidden': 'true' }),
									h('span', { className: 'aij-distLegendName' }, segment.name),
									h('span', { className: 'aij-distLegendCount' }, segment.sessions + ' 会话')
								)
							)
						)
					: null,
				segments.length ? h('p', { className: 'aij-chartFootnote' }, '共 ' + total + ' 个会话，按块占比堆叠。') : null
			);
		}

		/** 周报 7 天轮次柱状图：0 轮保留空位。 */
		function WeekChart(props) {
			const days = listOf(props.days);
			const width = 280;
			const baseline = 66;
			const plotHeight = 56;
			const slot = days.length > 0 ? width / days.length : width;
			const maxTurns = days.reduce((current, day) => Math.max(current, num(day && day.turns)), 0) || 1;
			return h(
				'section',
				{ className: 'aij-chartCard' },
				h('h3', { className: 'aij-chartTitle' }, '每日轮次'),
				h(
					'svg',
					{
						className: 'aij-chartSvg aij-weekSvg',
						viewBox: '0 0 280 96',
						role: 'img',
						'aria-label': '本周每日轮次柱状图，最高 ' + maxTurns + ' 轮'
					},
					h('line', { className: 'aij-weekBase', x1: 0, y1: baseline, x2: width, y2: baseline }),
					days.map((day, index) => {
						const turns = num(day && day.turns);
						const sessions = num(day && day.sessions);
						const center = slot * index + slot / 2;
						const barWidth = Math.min(18, slot * 0.5);
						const height = turns > 0 ? Math.max(2, (turns / maxTurns) * plotHeight) : 0;
						const label =
							(hasText(day && day.label) ? day.label : hasText(day && day.date) ? day.date : '') +
							' · ' +
							sessions +
							' 会话 · ' +
							turns +
							' 轮';
						const axis = hasText(day && day.date) ? day.date.slice(5) : String(index + 1);
						return h(
							'g',
							{ key: (day && day.date) || index, className: 'aij-weekBarSlot', role: 'img', 'aria-label': label },
							h('title', null, label),
							height > 0
								? h('rect', {
										className: 'aij-weekBar',
										x: center - barWidth / 2,
										y: baseline - height,
										width: barWidth,
										height: height,
										rx: 2
									})
								: null,
							h(
								'text',
								{
									className: 'aij-weekValue',
									x: center,
									y: height > 0 ? baseline - height - 4 : baseline - 4,
									textAnchor: 'middle',
									fontSize: 9
								},
								turns + ' 轮'
							),
							h('text', { className: 'aij-weekAxis', x: center, y: 84, textAnchor: 'middle', fontSize: 9 }, axis)
						);
					})
				),
				h('p', { className: 'aij-chartFootnote' }, '按天统计轮次，0 轮保留空位。')
			);
		}

		/** 图形化总览：完成率 / 块分布 / 指标微条，周报额外 7 天柱状图。 */
		function ChartsSection(props) {
			const data = props.data || {};
			const stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
			return h(
				'section',
				{ className: 'aij-chartsSection', 'aria-label': '图形化总览' },
				h(
					'div',
					{ className: 'aij-charts' },
					h(CompletionChart, { stats: stats }),
					h(DistributionChart, { blocks: listOf(data.blocks) }),
					props.kind === 'weekly' ? h(WeekChart, { days: listOf(data.days) }) : null
				)
			);
		}

		/** 把块换算成堆叠条段：最多 4 段，超过 3 个块时其余归「其它」。 */
		function distributionSegments(blocks) {
			const usable = listOf(blocks).filter(
				(block) => block && block.stats && Number.isFinite(block.stats.sessions) && block.stats.sessions > 0
			);
			const total = usable.reduce((sum, block) => sum + block.stats.sessions, 0);
			if (total <= 0) return [];
			const named = usable.length > 4 ? usable.slice(0, 3) : usable;
			const rest = usable.slice(named.length);
			const segments = named.map((block, index) => ({
				key: hasText(block.key) ? block.key : 'block-' + index,
				name: hasText(block.title) ? block.title : hasText(block.label) ? block.label : '未命名块',
				sessions: block.stats.sessions,
				className: DIST_SEGMENT_CLASSES[index % DIST_SEGMENT_CLASSES.length]
			}));
			if (rest.length > 0) {
				segments.push({
					key: 'other',
					name: '其它',
					sessions: rest.reduce((sum, block) => sum + block.stats.sessions, 0),
					className: DIST_SEGMENT_CLASSES[3]
				});
			}
			return segments.map((segment) =>
				Object.assign({}, segment, {
					percent: Math.round((segment.sessions / total) * 10000) / 100,
					title: segment.name + ' · ' + segment.sessions + ' 会话'
				})
			);
		}

		/**
		 * 待跟进区（可选数据）：会话里提到、但没有写进结构化待办清单的事项。
		 * 启发式识别，只标注、不当作已确认待办；数据为空时整块不渲染。
		 */
		function FollowupsSection(props) {
			const dismissedKeys = listOf(props.dismissedKeys);
			const followups = listOf(props.followups).filter(
				(item) => item && hasText(item.text) && !dismissedKeys.includes(item.key)
			);
			const dismissedCount = num(props.dismissedCount);
			if (followups.length === 0 && dismissedCount === 0) return null;
			const notice = props.notice;
			return h(
				'section',
				{ className: 'aij-followups', 'aria-label': '待跟进事项' },
				h(
					'div',
					{ className: 'aij-followupsHead' },
					h('h3', { className: 'aij-followupsTitle' }, '待跟进 · 会话里提到、未写入待办'),
					followups.length > 0
						? h(
								'span',
								{ className: 'aij-countBadge', 'aria-label': followups.length + ' 条待跟进' },
								String(followups.length)
							)
						: null
				),
				h('p', { className: 'aij-followupsHint' }, '根据会话里的措辞识别，可能不准确；已写成待办的事项不在这里。'),
				followups.length > 0
					? h(
							'ul',
							{ className: 'aij-followupList' },
							followups.map((item, index) =>
								h(FollowupRow, {
									key: (hasText(item.sessionId) ? item.sessionId : 'followup') + '-' + index,
									item: item,
									dismissPendingKey: props.dismissPendingKey,
									onDismiss: props.onDismiss,
									onStartSession: props.onStartSession
								})
							)
						)
					: null,
				notice
					? h(
							'p',
							{
								className:
									'aij-followupNotice ' +
									(notice.kind === 'error' ? 'aij-followupNoticeError' : 'aij-followupNoticeWarn'),
								role: 'status'
							},
							notice.text
						)
					: null,
				dismissedCount > 0
					? h(
							'div',
							{ className: 'aij-followupIgnored' },
							h('span', null, '已忽略 ' + dismissedCount + ' 条 · '),
							h(
								'button',
								{
									type: 'button',
									className: 'aij-undoBtn',
									disabled: props.restorePending === true,
									title: '撤销最近一次忽略，并重新拉取报告',
									onClick: () => {
										if (typeof props.onUndo === 'function') props.onUndo();
									}
								},
								'撤销'
							)
						)
					: null
			);
		}

		/** 单条待跟进：徽章 + 文案 + 来源 + 「新开对话 / 这不是待办」。 */
		function FollowupRow(props) {
			const item = props.item || {};
			const meta = [
				hasText(item.sessionTitle) ? item.sessionTitle : '',
				hasText(item.project) ? item.project : '',
				formatMonthDay(item.time)
			]
				.filter(hasText)
				.join(' · ');
			const canDismiss = hasText(item.key);
			const pending = canDismiss && props.dismissPendingKey === item.key;
			return h(
				'li',
				{ className: 'aij-followupRow' },
				h(
					'div',
					{ className: 'aij-followupMain' },
					h(Badge, { className: 'aij-badge aij-badgeFollowup', label: '待跟进' }),
					h(
						'div',
						{ className: 'aij-followupBody' },
						h('div', { className: 'aij-followupText' }, item.text),
						meta ? h('div', { className: 'aij-followupMeta' }, '来源：' + meta) : null
					)
				),
				h(
					'div',
					{ className: 'aij-followupActions' },
					h(NewSessionButton, { todo: item, onStartSession: props.onStartSession }),
					canDismiss
						? h(
								'button',
								{
									type: 'button',
									className: 'aij-dismissBtn',
									disabled: pending,
									title: '忽略这条：它不是待办',
									'aria-label': '这不是待办：' + item.text,
									onClick: () => {
										if (pending) return;
										if (typeof props.onDismiss === 'function') props.onDismiss(item);
									}
								},
								'这不是待办'
							)
						: null
				)
			);
		}		// ---------------------------------------------------------------------
		// 概览 / 每日分布 / 读取失败
		// ---------------------------------------------------------------------

		/** 概览卡的关键指标：一排大数字 + 标签（统计口径来自 stats）。 */
		function buildKpis(stats) {
			const source = stats && typeof stats === 'object' ? stats : {};
			const rows = [
				['会话', source.sessions],
				['轮次', source.turns],
				['我的输入', source.humanMessages],
				['工具调用', source.toolCalls],
				['交付物', source.deliverables],
				['完成待办', source.todosCompleted]
			];
			return rows.filter((row) => Number.isFinite(row[1])).map((row) => ({ label: row[0], value: row[1] }));
		}

		function OverviewCard(props) {
			const data = props.data || {};
			const stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
			const range = data.range && typeof data.range === 'object' ? data.range : {};
			const scopeDays = listOf(range.days).length || (props.kind === 'weekly' ? 7 : 1);
			const updated = formatUpdated(data.generatedAt);
			const kpis = buildKpis(stats);
			return h(
				'section',
				{ className: 'aij-overview' },
				h(
					'div',
					{ className: 'aij-overviewMeta' },
					h('span', null, '范围 ' + (hasText(range.label) ? range.label : props.label)),
					h('span', null, scopeDays + ' 天'),
					h('span', null, '时区 ' + (hasText(data.tz) ? data.tz : props.tz)),
					updated ? h('span', null, '更新于 ' + updated) : null
				),
				kpis.length
					? h(
							'div',
							{ className: 'aij-kpiRow', role: 'group', 'aria-label': '关键指标' },
							kpis.map((kpi) =>
								h(
									'div',
									{ key: kpi.label, className: 'aij-kpi', title: kpi.label + '：' + kpi.value },
									h('div', { className: 'aij-kpiValue' }, String(kpi.value)),
									h('div', { className: 'aij-kpiLabel' }, kpi.label)
								)
							)
						)
					: null
			);
		}

		function DayRow(props) {
			const day = props.day || {};
			const maxTurns = props.maxTurns > 0 ? props.maxTurns : 1;
			const turns = num(day.turns);
			const width = Math.max(2, Math.round((turns / maxTurns) * 100));
			return h(
				'div',
				{ className: 'aij-dayGrid' },
				h('span', { className: 'aij-dayLabel' }, hasText(day.label) ? day.label : hasText(day.date) ? day.date : '—'),
				h('span', { className: 'aij-dayNum' }, String(num(day.sessions))),
				h(
					'span',
					{ className: 'aij-dayNum' },
					h('span', { className: 'aij-dayBarTrack' }, h('span', { className: 'aij-dayBar', style: { width: width + '%' } })),
					h('span', null, String(turns))
				),
				h('span', { className: 'aij-dayNum' }, String(num(day.unfinishedCount)))
			);
		}

		function DaysSection(props) {
			const days = listOf(props.days);
			const maxTurns = days.reduce((max, day) => Math.max(max, num(day && day.turns)), 0);
			return h(
				'section',
				{ className: 'aij-section' },
				h(
					'div',
					{ className: 'aij-sectionHead' },
					h('h2', { className: 'aij-sectionTitle' }, '每日分布'),
					h('span', { className: 'aij-sectionMeta' }, days.length ? '共 ' + days.length + ' 天' : null)
				),
				days.length
					? h(
							'div',
							{ className: 'aij-dayTable' },
							h(
								'div',
								{ className: 'aij-dayGrid aij-dayGridHead' },
								h('span', null, '日期'),
								h('span', null, '会话'),
								h('span', null, '轮次'),
								h('span', null, '未完成')
							),
							days.map((day, index) => h(DayRow, { key: (day && day.date) || index, day: day, maxTurns: maxTurns }))
						)
					: h('p', { className: 'aij-muted' }, '本周没有可用的每日统计。')
			);
		}

		function FailuresNotice(props) {
			const failures = listOf(props.failures).filter((item) => item && hasText(item.message));
			if (failures.length === 0) return null;
			const messages = failures.map((item) => item.message.trim()).join('；');
			return h('p', { className: 'aij-failures', role: 'status' }, '有 ' + failures.length + ' 个会话读取失败：' + messages);
		}

		// ---------------------------------------------------------------------
		// 状态视图：loading / empty / error
		// ---------------------------------------------------------------------

		function LoadingView(props) {
			const label = props.kind === 'weekly' ? '正在生成周报…' : '正在生成日报…';
			const cards = [3, 3, 2];
			return h(
				'div',
				null,
				h('p', { className: 'aij-loadingText' }, label),
				cards.map((lines, cardIndex) =>
					h(
						'div',
						{ key: cardIndex, className: 'aij-skeletonCard' },
						Array.from({ length: lines }).map((unused, lineIndex) =>
							h('div', {
								key: lineIndex,
								className: 'aij-skeletonLine',
								style: { width: [64, 100, 82][lineIndex % 3] + '%' }
							})
						)
					)
				)
			);
		}

		function EmptyView(props) {
			const title = props.kind === 'weekly' ? '这一周没有 AI 会话活动' : '这一天没有 AI 会话活动';
			return h(
				'div',
				{ className: 'aij-empty' },
				h('div', { className: 'aij-emptyGlyph' }, h(JournalIcon, { size: 28 })),
				h('h2', { className: 'aij-emptyTitle' }, title),
				h('p', { className: 'aij-emptyHint' }, '当前范围：' + props.label + '。换一个日期看看，或先在 DSH 里开始一次会话。')
			);
		}

		function ErrorView(props) {
			return h(
				'div',
				{ className: 'aij-errorBox', role: 'alert' },
				h('h2', { className: 'aij-errorTitle' }, 'AI 日报加载失败'),
				h('p', { className: 'aij-errorText' }, props.message),
				h('div', { className: 'aij-errorActions' }, h('button', { type: 'button', className: 'aij-retryBtn', onClick: props.onRetry }, '重试'))
			);
		}

		// ---------------------------------------------------------------------
		// 面板主组件
		// ---------------------------------------------------------------------

		function JournalPanel(props) {
			const onStartSession = props && typeof props.onStartSession === 'function' ? props.onStartSession : null;
			const [kind, setKind] = React.useState('daily');
			const [dailyDate, setDailyDate] = React.useState(todayKey);
			const [weeklyDate, setWeeklyDate] = React.useState(() => weekStartKey(todayKey()));
			const [nonce, setNonce] = React.useState(0);
			const [status, setStatus] = React.useState('loading');
			const [data, setData] = React.useState(null);
			const [dataKey, setDataKey] = React.useState('');
			const [errorMsg, setErrorMsg] = React.useState('');
			const [openNotice, setOpenNotice] = React.useState(null);
			const [dismissedStack, setDismissedStack] = React.useState([]);
			const [dismissNotice, setDismissNotice] = React.useState(null);
			const [dismissPendingKey, setDismissPendingKey] = React.useState(null);
			const [restorePending, setRestorePending] = React.useState(false);
			const seqRef = React.useRef(0);
			const loadedKeyRef = React.useRef('');
			const noticeTimerRef = React.useRef(null);
			const dismissInFlightRef = React.useRef(false);
			const restoreInFlightRef = React.useRef(false);
			const tz = resolveTimeZone();

			const anchor = kind === 'daily' ? dailyDate : weeklyDate;
			const queryKey = kind + '|' + anchor;
			const today = todayKey();
			const currentWeekStart = weekStartKey(today);
			const isCurrentPeriod = kind === 'daily' ? dailyDate === today : weeklyDate === currentWeekStart;
			const atCurrent = kind === 'daily' ? dailyDate >= today : weeklyDate >= currentWeekStart;
			const loading = status === 'loading';
			const computedLabel =
				kind === 'daily'
					? dailyDate + ' ' + WEEKDAYS[parseKey(dailyDate).getDay()]
					: weeklyDate + ' ~ ' + shiftKey(weeklyDate, 6);
			const serverLabel =
				data && dataKey === queryKey && data.range && hasText(data.range.label) ? data.range.label : '';
			const displayLabel = serverLabel || computedLabel;

			React.useEffect(() => {
				if (loadedKeyRef.current !== queryKey) {
					// 换视图或换日期时先清掉旧数据，避免短暂展示错窗口内容。
					loadedKeyRef.current = queryKey;
					setData(null);
				}
				const seq = ++seqRef.current;
				const controller = new AbortController();
				setStatus('loading');
				setErrorMsg('');
				const url =
					API_PATH +
					'?kind=' +
					encodeURIComponent(kind) +
					'&date=' +
					encodeURIComponent(anchor) +
					'&tz=' +
					encodeURIComponent(tz) +
					(nonce > 0 ? '&refresh=1' : '');

				(async () => {
					try {
						const response = await fetch(url, {
							credentials: 'same-origin',
							cache: 'no-store',
							headers: { accept: 'application/json' },
							signal: controller.signal
						});
						let body = null;
						try {
							body = await response.json();
						} catch (parseError) {
							body = null;
						}
						if (controller.signal.aborted || seqRef.current !== seq) return;
						if (!response.ok) {
							setData(null);
							setStatus('error');
							setErrorMsg(readableError(body, '请求失败（HTTP ' + response.status + '）。'));
							return;
						}
						if (!body || typeof body !== 'object' || body.ok !== true) {
							setData(null);
							setStatus('error');
							setErrorMsg(readableError(body, '服务返回了无法识别的数据。'));
							return;
						}
						setData(body);
						setDataKey(queryKey);
						setStatus('ready');
					} catch (error) {
						if (controller.signal.aborted || seqRef.current !== seq) return;
						setData(null);
						setStatus('error');
						setErrorMsg(
							error && error.name === 'TypeError'
								? '网络请求失败，请检查连接后重试。'
								: readableError(null, '加载失败，请稍后重试。')
						);
					}
				})();

				return () => {
					controller.abort();
				};
			}, [kind, anchor, nonce, tz]);

			React.useEffect(
				() => () => {
					if (noticeTimerRef.current !== null) {
						clearTimeout(noticeTimerRef.current);
						noticeTimerRef.current = null;
					}
				},
				[]
			);

			// 报告数据变化（切换视图 / 刷新 / 撤销后重拉）时，本窗口的忽略状态随之归零。
			React.useEffect(() => {
				setDismissedStack([]);
				setDismissNotice(null);
				setDismissPendingKey(null);
			}, [data]);

			function selectKind(nextKind) {
				if (nextKind === kind) return;
				setKind(nextKind);
			}

			function step(delta) {
				if (kind === 'daily') {
					setDailyDate((current) => shiftKey(current, delta));
				} else {
					setWeeklyDate((current) => shiftKey(current, delta * 7));
				}
			}

			function goToday() {
				const now = todayKey();
				if (kind === 'daily') {
					setDailyDate(now);
				} else {
					setWeeklyDate(weekStartKey(now));
				}
			}

			function refresh() {
				setNonce((current) => current + 1);
			}

			function showOpenNotice(text, blockKey) {
				setOpenNotice({ text: text, blockKey: blockKey });
				if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
				noticeTimerRef.current = setTimeout(() => {
					noticeTimerRef.current = null;
					setOpenNotice(null);
				}, OPEN_NOTICE_MS);
			}

			// 交付物打开：对 openUrl 追加 action=open 后 POST（GET 只返回元数据）。
			// 204 → 已在宿主打开；409 → 宿主桌面不可用；404 → 文件已不存在；其它/网络失败 → 打开失败。
			function openDeliverable(item, blockKey) {
				const target = item && hasText(item.openUrl) ? item.openUrl : '';
				if (!target) {
					showOpenNotice('打开失败', blockKey);
					return;
				}
				const url = target + (target.indexOf('?') === -1 ? '?action=open' : '&action=open');
				fetch(url, { method: 'POST', credentials: 'same-origin' })
					.then((response) => {
						const status = response && Number.isFinite(response.status) ? response.status : 0;
						if (status === 204) showOpenNotice('已在宿主打开', blockKey);
						else if (status === 409) showOpenNotice('宿主桌面不可用', blockKey);
						else if (status === 404) showOpenNotice('文件已不存在', blockKey);
						else showOpenNotice('打开失败', blockKey);
					})
					.catch(() => showOpenNotice('打开失败', blockKey));
			}

			// 忽略/撤销共用的写接口：只 POST /ai-journal/api/followups，不读 GET。
			function postFollowupAction(action, item) {
				return fetch('/ai-journal/api/followups', {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						action: action,
						key: item.key,
						sessionId: item.sessionId,
						text: item.text
					})
				}).then((response) =>
					response
						.json()
						.then((body) => ({ ok: response.ok, body: body }))
						.catch(() => ({ ok: response.ok, body: null }))
				);
			}

			// 「这不是待办」：成功才从本地列表移除；失败保留条目并提示。
			function dismissFollowup(item) {
				if (!item || !hasText(item.key) || dismissInFlightRef.current) return;
				dismissInFlightRef.current = true;
				setDismissPendingKey(item.key);
				setDismissNotice(null);
				postFollowupAction('dismiss', item)
					.then((result) => {
						if (!result.ok || !result.body || result.body.ok !== true) throw new Error('dismiss failed');
						setDismissedStack((current) => current.concat([item]));
						setDismissNotice(
							result.body.persisted === false ? { kind: 'warn', text: '已忽略，但未能写入本机记录' } : null
						);
					})
					.catch(() => setDismissNotice({ kind: 'error', text: '操作失败，请重试' }))
					.then(() => {
						dismissInFlightRef.current = false;
						setDismissPendingKey(null);
					});
			}

			// 「撤销」：对最近一条忽略项 POST restore，成功后复用加载逻辑重新拉取（refresh=1）。
			function restoreFollowup() {
				if (dismissedStack.length === 0 || restoreInFlightRef.current) return;
				const item = dismissedStack[dismissedStack.length - 1];
				restoreInFlightRef.current = true;
				setRestorePending(true);
				setDismissNotice(null);
				postFollowupAction('restore', item)
					.then((result) => {
						if (!result.ok || !result.body || result.body.ok !== true) throw new Error('restore failed');
						setDismissedStack((current) => current.slice(0, -1));
						setNonce((current) => current + 1);
					})
					.catch(() => setDismissNotice({ kind: 'error', text: '操作失败，请重试' }))
					.then(() => {
						restoreInFlightRef.current = false;
						setRestorePending(false);
					});
			}

			// ---- 内容区 ----
			// 只有 data 与当前查询键匹配才渲染：切换视图不会闪现上一窗口的内容。
			// 同窗口刷新时 status 回到 loading 但 dataKey 仍匹配：继续渲染旧内容，
			// 顶部提示「正在刷新当前视图…」，等新数据到达后再替换。
			const readyData = data !== null && dataKey === queryKey ? data : null;
			let content;
			if (status === 'error') {
				content = h(ErrorView, { message: errorMsg || '加载失败，请稍后重试。', onRetry: refresh });
			} else if (readyData) {
				if (readyData.empty === true) {
					content = h(EmptyView, { kind: kind, label: displayLabel });
				} else {
					const blocks = listOf(readyData.blocks);
					const pieces = [
						h(OverviewCard, { key: 'overview', data: readyData, kind: kind, label: displayLabel, tz: tz }),
						h(ChartsSection, { key: 'charts', data: readyData, kind: kind }),
					h(FollowupsSection, {
						key: 'followups',
						followups: listOf(readyData.followups),
						dismissedKeys: dismissedStack.map((item) => item.key),
						dismissedCount: dismissedStack.length,
						dismissPendingKey: dismissPendingKey,
						restorePending: restorePending,
						notice: dismissNotice,
						onDismiss: dismissFollowup,
						onUndo: restoreFollowup,
						onStartSession: onStartSession
					}),
						...blocks.map((block, index) => {
							const blockKey = (block && block.key) || 'block-' + index;
							return h(BlockCard, {
								key: blockKey,
								block: block,
								kind: kind,
								blockKey: blockKey,
								onStartSession: onStartSession,
								onOpenDeliverable: openDeliverable,
								openNotice: openNotice !== null && openNotice.blockKey === blockKey ? openNotice.text : null
							});
						}),
						h(FailuresNotice, { key: 'failures', failures: listOf(readyData.failures) })
					];
					if (kind === 'weekly') {
						pieces.push(h(DaysSection, { key: 'days', days: listOf(readyData.days) }));
					}
					pieces.push(
						h(
							'p',
							{ key: 'footnote', className: 'aij-footnote' },
							'统计自本机 DSH 会话日志，仅计入人类输入；不包含注入上下文、定时任务与子 agent 消息。'
						)
					);
					content = h('div', null, pieces);
				}
			} else {
				content = h(LoadingView, { kind: kind });
			}

			const refreshing = status === 'loading' && readyData !== null;

			return h(
				'div',
				{ className: 'aij-page' },
				h(
					'header',
					{ className: 'aij-header' },
					h(
						'div',
						{ className: 'aij-headerInner' },
						h(
							'div',
							{ className: 'aij-headRow' },
							h(
								'div',
								{ className: 'aij-headText' },
								h('h1', { className: 'aij-title' }, 'AI 日报'),
								h('p', { className: 'aij-subtitle' }, '按目标/项目汇总做过的事、完成的结果与留下的待办。')
							),
							h(
								'button',
								{
									type: 'button',
									className: 'aij-refreshBtn',
									onClick: refresh,
									disabled: loading,
									'aria-label': loading ? '正在刷新' : '刷新日报数据'
								},
								loading ? '刷新中…' : '刷新'
							)
						),
						h(
							'div',
							{ className: 'aij-toolbar' },
							h(
								'div',
								{ className: 'aij-segment', role: 'group', 'aria-label': '日报或周报视图' },
								h(
									'button',
									{
										type: 'button',
										className: 'aij-segmentBtn',
										'aria-pressed': kind === 'daily',
										onClick: () => selectKind('daily')
									},
									'日报'
								),
								h(
									'button',
									{
										type: 'button',
										className: 'aij-segmentBtn',
										'aria-pressed': kind === 'weekly',
										onClick: () => selectKind('weekly')
									},
									'周报'
								)
							),
							h(
								'div',
								{ className: 'aij-nav' },
								h(
									'button',
									{
										type: 'button',
										className: 'aij-navBtn',
										onClick: () => step(-1),
										'aria-label': kind === 'daily' ? '前一天' : '上一周'
									},
									'‹'
								),
								h('span', { className: 'aij-navLabel', title: displayLabel }, displayLabel),
								h(
									'button',
									{
										type: 'button',
										className: 'aij-navBtn',
										onClick: () => step(1),
										disabled: atCurrent,
										'aria-label': kind === 'daily' ? '后一天' : '下一周'
									},
									'›'
								)
							),
							h(
								'button',
								{
									type: 'button',
									className: 'aij-todayBtn',
									onClick: goToday,
									disabled: isCurrentPeriod
								},
								kind === 'daily' ? '今天' : '本周'
							)
						)
					)
				),
				h(
					'div',
					{ className: 'aij-scroll' },
					h(
						'div',
						{ className: 'aij-content' },
						refreshing ? h('p', { className: 'aij-statusLine', role: 'status' }, '正在刷新当前视图…') : null,
						content
					)
				)
			);
		}

		// ---------------------------------------------------------------------
		// 插件入口
		// ---------------------------------------------------------------------

		/**
		 * 把建议提示词预填进新会话：cwd 能匹配到 Workspace 就指定工作区，
		 * 否则省略工作区（走最近工作区）。
		 */
		function apply(ctx) {
			ctx.effect(() => installStyles(), 'ai-journal: styles');

			function workspaceIdForPath(path) {
				if (!hasText(path)) return undefined;
				try {
					const snapshot = ctx.workspaces.list.getSnapshot();
					const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
					const match = items.find((item) => item && item.path === path);
					return match ? match.workspaceId : undefined;
				} catch (error) {
					return undefined;
				}
			}

			function startSessionForTodo(todo) {
				const subject = todo && typeof todo === 'object' ? todo : {};
				const prompt = hasText(subject.suggestedPrompt)
					? subject.suggestedPrompt
					: hasText(subject.content)
						? subject.content
						: '';
				const options = hasText(prompt) ? { prompt: prompt } : undefined;
				const workspaceId = workspaceIdForPath(subject.cwd);
				try {
					if (workspaceId !== undefined && workspaceId !== null) {
						ctx.uiWorkspace.startSession(workspaceId, options);
					} else {
						// 匹配不到 Workspace 时省略第一个参数，使用最近工作区。
						ctx.uiWorkspace.startSession(undefined, options);
					}
				} catch (error) {
					// 宿主未提供可用的导航能力时静默失败，不阻塞面板渲染。
				}
			}

			// main 为根作用域的 keyed 槽位；先注册面板，再注册左侧栏入口。
			ctx.slots.inject('main', () =>
				ctx.slots.register(
					{ name: 'main', key: PANEL_ID, inject: () => ({ onStartSession: startSessionForTodo }) },
					JournalPanel
				)
			);
			ctx.slots.inject('sidebar.panellist', () =>
				ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'AI 日报' }, JournalIcon)
			);
		}

		exports.PANEL_ID = PANEL_ID;
		exports.JournalIcon = JournalIcon;
		exports.JournalPanel = JournalPanel;
		exports.apply = apply;
		exports.inject = ['slots', 'uiWorkspace', 'workspaces'];
		return module.exports;
	}
});
