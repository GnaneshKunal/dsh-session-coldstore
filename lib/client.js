window.__ModuleLoader__.load({
  id: '@gnanesh/dsh-session-coldstore',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const API_BASE = '/session-coldstore/api';
    const PAGE_SIZE = 20;
    const SEARCH_DEBOUNCE_MS = 250;
    const STATUS_INTERVAL_MS = 5000;
    const DAY_MS = 86400000;

    // Host settings page look, copied from the host's management list rows and
    // re-prefixed under `cs_`. Every declaration references an alias theme
    // token; there are no literal colors on this page.
    const css = `
.cs_section{width:100%;max-width:820px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.cs_header{display:flex;flex-direction:column;gap:2px;padding:0 2px}
.cs_title{font-size:18px;font-weight:600;line-height:26px;margin:0}
.cs_subtitle{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.cs_strip{display:flex;flex-wrap:wrap;gap:18px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px 14px}
.cs_stat{display:flex;flex-direction:column;gap:2px;min-width:104px}
.cs_statLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.cs_statValue{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.cs_banner{border:1px solid var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary);border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px}
.cs_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cs_notice{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
.cs_search{width:100%;color:var(--dsw-alias-label-tertiary);align-items:center;display:flex;position:relative}
.cs_search>svg{pointer-events:none;position:absolute;left:12px}
.cs_search input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;height:36px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 34px 0 36px;font-size:13px}
.cs_search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.cs_search input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.cs_filters{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;padding:0 2px}
.cs_field{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.cs_field input{font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.cs_check{display:inline-flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;padding-bottom:7px}
.cs_check input{accent-color:var(--dsw-alias-state-business-primary)}
.cs_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:0 2px}
.cs_sectionHead{align-items:baseline;gap:7px;padding:0 2px;display:flex}
.cs_sectionHeadTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary)}
.cs_sectionHeadCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}
.cs_list{display:flex;flex-direction:column;gap:10px}
.cs_row{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px 14px}
.cs_rowHead{display:flex;align-items:center;gap:8px;min-width:0}
.cs_name{font-weight:600;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.cs_path{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;word-break:break-all}
.cs_meta{display:flex;flex-wrap:wrap;gap:12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cs_metaKey{color:var(--dsw-alias-label-tertiary)}
.cs_snippet{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}
.cs_badge{background:var(--dsw-alias-bg-layer-1);min-height:20px;color:var(--dsw-alias-label-secondary);border-radius:5px;align-items:center;padding:1px 8px;font-size:11px;line-height:16px;display:inline-flex;flex:none}
.cs_badge.starred{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary)}
.cs_actions{margin-left:auto;display:flex;gap:6px;flex:none}
.cs_btn{cursor:pointer;font-size:12px;line-height:18px;padding:3px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
.cs_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cs_btn:disabled{opacity:.5;cursor:default}
.cs_btn.primary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}
.cs_btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.cs_btn.danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.cs_empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:2px}
.cs_actionsBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 2px}
.cs_batch{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border:1px solid var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent);border-radius:10px;padding:10px 12px}
.cs_batchText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.cs_batchTitle{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}
.cs_batchMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.cs_batchHint{font-size:12px;line-height:18px;color:var(--dsw-alias-state-business-primary)}
.cs_groupTitle{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary);padding:0 2px;margin-top:4px}
.cs_planRow{display:flex;align-items:center;gap:8px;min-width:0;padding:4px 2px}
.cs_planRow .cs_name{font-weight:500;font-size:12px;line-height:18px}
.cs_planRow .cs_path{min-width:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cs_config{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px 14px}
.cs_configRow{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.cs_switchRow{align-items:center;gap:8px;display:inline-flex;min-width:0}
.cs_switch{box-sizing:border-box;width:36px;height:20px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:999px;cursor:pointer;padding:0;position:relative;flex:none;transition:background-color .2s ease,border-color .2s ease}
.cs_switch:disabled{cursor:default;opacity:.6}
.cs_switch[data-on=true]{border-color:transparent;background:var(--dsw-alias-state-business-primary)}
.cs_switchThumb{box-sizing:border-box;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);position:absolute;top:2px;left:2px;transition:transform .22s cubic-bezier(.34,1.56,.64,1),background-color .18s ease}
.cs_switch[data-on=true] .cs_switchThumb{transform:translateX(18px);background:var(--dsw-alias-label-primary-foreground)}
.cs_switchText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cs_overlay{position:fixed;inset:0;background:color-mix(in srgb,var(--dsw-alias-label-primary) 35%,transparent);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px}
.cs_dialog{background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:20px;max-width:560px;width:100%;max-height:80vh;overflow:auto;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}
.cs_dialogTitle{font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
.cs_dialogBody{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.cs_dialogActions{display:flex;justify-content:flex-end;gap:8px}
.cs_pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0}
`;

    // Mirrors locale/en.json. The extra `loadMore`/`filter*`/`plan*`/`previewEmpty`/
    // `reason.*` entries cover controls the JSON has no key for; a plain-JS client
    // cannot import the package locale JSON, so dictionaries register here.
    const en = {
      sectionLabel: 'Coldstore',
      title: 'Session Coldstore',
      subtitle: 'Move idle sessions out of the live list without deleting anything.',
      statusLive: 'Live sessions',
      statusCold: 'Cold sessions',
      statusSince: 'Last sweep',
      statusNever: 'never',
      statusBytes: 'On disk',
      searchPlaceholder: 'Search cold sessions…',
      searchEmpty: 'No cold sessions match.',
      searchHint: 'Full-text search runs against an on-disk index, so it costs no session memory.',
      colTitle: 'Session',
      colWorkspace: 'Workspace',
      colAge: 'Last prompt',
      colSize: 'Size',
      actionRestore: 'Restore',
      actionStar: 'Star',
      actionUnstar: 'Unstar',
      actionDelete: 'Delete',
      actionPreview: 'Preview',
      actionSweep: 'Run sweep now',
      actionPreviewPlan: 'Preview what would freeze',
      actionReindex: 'Rebuild search index',
      dryRunOn: 'Dry run — nothing moves until you turn this off.',
      dryRunOff: 'Live mode — a sweep will move sessions.',
      confirmFreeze: 'Freeze {n} sessions? They leave the live list but stay on disk and can be restored.',
      confirmDelete: 'Move {n} sessions to the trash? They stay recoverable in the trash folder.',
      frozen: 'Frozen {n} sessions ({bytes}).',
      restored: 'Restored {n} sessions.',
      starred: 'Starred — this session will never be frozen.',
      empty: 'Nothing is cold yet.',
      error: 'Something went wrong: {message}',
      retainDays: 'Keep live for (days)',
      minIdleMinutes: 'Minimum idle (minutes)',
      keepPinned: 'Never freeze pinned sessions',
      keepStarred: 'Never freeze starred sessions',
      keepUnread: 'Never freeze sessions you have not opened',
      notifyOnSweep: 'Notify after an automatic sweep moves sessions',
      keepLive: 'Never freeze running or waiting sessions',
      save: 'Save',
      saved: 'Saved.',
      loadMore: 'Load more',
      filterStarred: 'Starred only',
      filterFrom: 'From',
      filterTo: 'To',
      planCandidates: 'Would freeze',
      planExempt: 'Kept',
      previewEmpty: 'No preview available.',
      actionStageSweep: 'Stage sweep',
      actionCommit: 'Commit',
      actionDiscard: 'Discard',
      staged: 'Staged batch',
      skipped: 'Skipped',
      'reason.goal': 'Active goal',
      'reason.todo': 'Open todos',
      'reason.subagent': 'Subagent session',
      'reason.too-new': 'Too recent',
      'reason.already-cold': 'Already cold',
      'reason.no-longer-eligible': 'No longer eligible',
      'reason.missing': 'Session missing',
    };

    // ── defensive shape helpers ────────────────────────────────────────────

    function asObject(value) {
      return value !== null && typeof value === 'object' ? value : {};
    }

    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function asText(value) {
      return typeof value === 'string' ? value : '';
    }

    function asCount(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    }

    function formatBytes(value) {
      const bytes = asCount(value);
      const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      if (bytes <= 0) return '0 ' + units[0];
      const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      const scaled = bytes / Math.pow(1024, exponent);
      const digits = exponent === 0 || scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return scaled.toFixed(digits) + ' ' + units[exponent];
    }

    // Policy fields are merged by the Host, but the portal always posts the
    // complete policy. A cleared or unparsable draft falls back to the value
    // last reported by `/status` instead of silently writing a destructive
    // default such as `retainDays: 0`.
    function toFiniteNumber(value, fallback) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
      const text = typeof value === 'string' ? value.trim() : '';
      if (text === '') return fallback;
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function clampInteger(value, fallback) {
      return Math.max(0, Math.floor(toFiniteNumber(value, fallback)));
    }

    function minutesToMs(value, fallbackMs) {
      const fallbackMinutes = Math.max(0, toFiniteNumber(fallbackMs, 0)) / 60000;
      const minutes = Math.max(0, toFiniteNumber(value, fallbackMinutes));
      return Math.round(minutes * 60000);
    }

    function msToMinutesText(value) {
      const ms = Math.max(0, toFiniteNumber(value, 0));
      return String(Math.round((ms / 60000) * 100) / 100);
    }

    function policyFlag(value) {
      return value !== false;
    }

    /**
     * The complete storage policy for `POST /config`. Every call sends all six
     * keys; the Host merges them, but a merge still cannot resurrect a value a
     * partial patch never sent, so the portal always writes the whole policy.
     */
    function buildConfigPayload(currentStatus, drafts) {
      const current = asObject(currentStatus);
      const draft = asObject(drafts);
      return {
        retainDays: clampInteger(draft.retainDays, toFiniteNumber(current.retainDays, 0)),
        dryRun: draft.dryRun === true,
        keepPinned: draft.keepPinned === true,
        keepStarred: draft.keepStarred === true,
        keepUnread: draft.keepUnread === true,
        notifyOnSweep: draft.notifyOnSweep === true,
        minIdleMs: minutesToMs(draft.minIdleMs, toFiniteNumber(current.minIdleMs, 0)),
      };
    }

    /**
     * Optimistic plan mutation for a starred candidate: move the row out of the
     * freeze list into the exempt list with reason `starred`, and shrink totals
     * to match. Returns the same reference when the id is not a candidate.
     */
    function starCandidateInPlan(currentPlan, id) {
      const previous = asObject(currentPlan);
      const candidates = asArray(previous.candidates);
      const target = asText(id);
      const moved = candidates.filter((entry) => asText(asObject(entry).id) === target);
      if (moved.length === 0) return currentPlan;
      const totals = asObject(previous.totals);
      const movedBytes = moved.reduce((sum, entry) => sum + asCount(asObject(entry).bytes), 0);
      return {
        busy: previous.busy === true,
        error: asText(previous.error),
        candidates: candidates.filter((entry) => asText(asObject(entry).id) !== target),
        exempt: asArray(previous.exempt).concat(moved.map((entry) => Object.assign({}, asObject(entry), { reason: 'starred' }))),
        totals: {
          count: Math.max(0, asCount(totals.count) - moved.length),
          bytes: Math.max(0, asCount(totals.bytes) - movedBytes),
        },
      };
    }

    let relativeFormatter;
    function relativeFormatterOf() {
      if (relativeFormatter === undefined) {
        try {
          relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
        } catch {
          relativeFormatter = null;
        }
      }
      return relativeFormatter;
    }

    function formatAge(value, t) {
      const at = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      if (at <= 0) return t('statusNever');
      const formatter = relativeFormatterOf();
      if (!formatter) {
        try {
          return new Date(at).toLocaleString();
        } catch {
          return t('statusNever');
        }
      }
      const diff = at - Date.now();
      const magnitude = Math.abs(diff);
      if (magnitude < 3600000) return formatter.format(Math.round(diff / 60000), 'minute');
      if (magnitude < DAY_MS) return formatter.format(Math.round(diff / 3600000), 'hour');
      if (magnitude < 7 * DAY_MS) return formatter.format(Math.round(diff / DAY_MS), 'day');
      if (magnitude < 30 * DAY_MS) return formatter.format(Math.round(diff / (7 * DAY_MS)), 'week');
      if (magnitude < 365 * DAY_MS) return formatter.format(Math.round(diff / (30 * DAY_MS)), 'month');
      return formatter.format(Math.round(diff / (365 * DAY_MS)), 'year');
    }

    function formatWhen(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '';
      try {
        return new Date(value).toLocaleString();
      } catch {
        return '';
      }
    }

    // API.md does not pin the `/status.lastSweep` shape; the Host currently
    // sends epoch ms or null. Tolerate a date string or an object carrying a
    // timestamp instead of assuming one shape.
    function sweepLabel(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'number') return value > 0 ? formatWhen(value) : '';
      if (typeof value === 'string') {
        const text = value.trim();
        if (text === '') return '';
        const parsed = Date.parse(text);
        return Number.isFinite(parsed) ? formatWhen(parsed) : text;
      }
      if (typeof value === 'object') {
        const record = asObject(value);
        const at = record.at !== undefined
          ? record.at
          : record.finishedAt !== undefined
            ? record.finishedAt
            : record.lastSweep !== undefined
              ? record.lastSweep
              : record.startedAt;
        if (at !== undefined) return sweepLabel(at);
      }
      return '';
    }

    /**
     * Normalize a staged batch from either source: `POST /sweep` returns the
     * full batch (`totals`), `/status.batch` returns only a summary
     * (`{ id, createdAt, count, bytes }`).
     */
    function batchSummary(value) {
      const record = asObject(value);
      const totals = asObject(record.totals);
      return {
        id: asText(record.id),
        createdAt: toFiniteNumber(record.createdAt, 0),
        count: toFiniteNumber(totals.count, toFiniteNumber(record.count, 0)),
        bytes: toFiniteNumber(totals.bytes, toFiniteNumber(record.bytes, 0)),
      };
    }

    /**
     * Shape commit skips for display, resolving a title from the staged batch
     * when one is still known. `/commit` returns `{ id, reason }` only.
     */
    function commitSkipEntries(skipped, known) {
      const source = asArray(known);
      return asArray(skipped).map((entry) => {
        const record = asObject(entry);
        const id = asText(record.id);
        const match = source.find((item) => asText(asObject(item).id) === id);
        return {
          id,
          title: asText(asObject(match).title),
          reason: record.reason,
        };
      });
    }

    /**
     * Pick the staged batch to show from a `/status` payload. A summary with an
     * id seeds or replaces the bar (page refresh, newer staging); the same id
     * keeps the richer local copy; no batch means the Host no longer stages one.
     */
    function nextBatchFromStatus(currentBatch, statusValue) {
      const incoming = asObject(asObject(statusValue).batch);
      const incomingId = asText(incoming.id);
      if (incomingId === '') return null;
      return asText(asObject(currentBatch).id) === incomingId ? currentBatch : incoming;
    }

    function dayStartMs(value) {      const text = asText(value).trim();
      if (text === '') return undefined;
      const parsed = Date.parse(text.length === 10 ? text + 'T00:00:00' : text);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    function dayEndMs(value) {
      const start = dayStartMs(value);
      return start === undefined ? undefined : start + DAY_MS - 1;
    }

    // `/search` `from`/`to` are epoch ms on the Host side (Number(query)); the
    // UI date inputs are converted here. API.md leaves the unit unspecified.
    function buildSearchPath(options) {
      const params = new URLSearchParams();
      params.set('q', asText(options.q));
      params.set('limit', String(options.limit));
      params.set('offset', String(options.offset));
      const from = dayStartMs(options.from);
      const to = dayEndMs(options.to);
      if (from !== undefined) params.set('from', String(from));
      if (to !== undefined) params.set('to', String(to));
      if (options.starred === true) params.set('starred', 'true');
      return '/search?' + params.toString();
    }

    function buildPlanPath(retainDays) {
      if (typeof retainDays === 'number' && Number.isFinite(retainDays)) {
        return '/plan?days=' + encodeURIComponent(String(retainDays));
      }
      return '/plan';
    }

    // ── transport ─────────────────────────────────────────────────────────

    function api(path, options) {
      const init = { headers: { 'Content-Type': 'application/json' } };
      if (options && typeof options === 'object') {
        init.method = options.method;
        if (options.body !== undefined) init.body = options.body;
      }
      return fetch(API_BASE + path, init).then(async (response) => {
        let body = {};
        try {
          body = await response.json();
        } catch {
          body = {};
        }
        return { ok: response.ok, status: response.status, body: asObject(body) };
      });
    }

    function apiMessage(t, response) {
      const message = asText(asObject(response.body).error) || 'HTTP ' + String(response.status);
      return t('error', { message });
    }

    function errorMessage(t, caught) {
      const message = caught && typeof caught.message === 'string' && caught.message !== ''
        ? caught.message
        : String(caught);
      return t('error', { message });
    }

    const REASON_KEYS = {
      pinned: 'keepPinned',
      starred: 'keepStarred',
      unread: 'keepUnread',
      live: 'keepLive',
      goal: 'reason.goal',
      todo: 'reason.todo',
      subagent: 'reason.subagent',
      'too-new': 'reason.too-new',
      'already-cold': 'reason.already-cold',
      'no-longer-eligible': 'reason.no-longer-eligible',
      missing: 'reason.missing',
    };

    // An unknown reason is Host-supplied data (a commit skip or freeze error),
    // so show it verbatim instead of inventing a dictionary key for it.
    function reasonLabel(t, reason) {
      const code = asText(reason);
      const known = REASON_KEYS[code];
      return known ? t(known) : code;
    }

    // ── presentational pieces ─────────────────────────────────────────────

    function Stat({ label, value }) {
      return h('div', { className: 'cs_stat' },
        h('span', { className: 'cs_statLabel' }, label),
        h('span', { className: 'cs_statValue' }, value));
    }

    function SwitchControl({ label, on, busy, onChange }) {
      return h('span', { className: 'cs_switchRow' },
        h('button', {
          className: 'cs_switch',
          type: 'button',
          role: 'switch',
          'data-on': on ? 'true' : undefined,
          'aria-checked': on,
          'aria-label': label,
          disabled: busy,
          onClick: onChange,
        }, h('span', { className: 'cs_switchThumb' })),
        h('span', { className: 'cs_switchText' }, label));
    }

    function SessionRow({ t, item, index, busy, onPreview, onToggleStar, onRestore, onDelete }) {
      const record = asObject(item);
      const id = asText(record.id);
      const title = asText(record.title) || id || String(index);
      const workspace = asText(record.cwd) || asText(record.projectDir);
      const snippet = asText(record.snippet);
      const starred = record.starred === true;
      const key = id || 'row-' + String(index);
      return h('div', { className: 'cs_row', key },
        h('div', { className: 'cs_rowHead' },
          h('span', { className: 'cs_name', title }, title),
          starred ? h('span', { className: 'cs_badge starred' }, t('actionStar')) : null,
          h('span', { className: 'cs_actions' },
            h('button', {
              className: 'cs_btn',
              type: 'button',
              disabled: busy,
              onClick: () => onPreview(record),
            }, t('actionPreview')),
            h('button', {
              className: 'cs_btn',
              type: 'button',
              disabled: busy,
              'aria-pressed': starred,
              onClick: () => onToggleStar(record),
            }, starred ? t('actionUnstar') : t('actionStar')),
            h('button', {
              className: 'cs_btn',
              type: 'button',
              disabled: busy,
              onClick: () => onRestore(record),
            }, busy ? '…' : t('actionRestore')),
            h('button', {
              className: 'cs_btn danger',
              type: 'button',
              disabled: busy,
              onClick: () => onDelete(record),
            }, t('actionDelete')))),
        h('div', { className: 'cs_path' },
          h('span', { className: 'cs_metaKey' }, t('colWorkspace')),
          ' ',
          workspace || '—'),
        h('div', { className: 'cs_meta' },
          h('span', null, h('span', { className: 'cs_metaKey' }, t('colAge')), ' ', formatAge(record.lastPromptAt, t)),
          h('span', null, h('span', { className: 'cs_metaKey' }, t('colSize')), ' ', formatBytes(record.bytes))),
        snippet ? h('div', { className: 'cs_snippet' }, snippet) : null);
    }

    function PlanRow({ t, item, index, reason, starred, starBusy, onStar }) {
      const record = asObject(item);
      const id = asText(record.id);
      const title = asText(record.title) || id || String(index);
      const workspace = asText(record.cwd) || asText(record.projectDir);
      return h('div', { className: 'cs_planRow', key: id || 'plan-' + String(index) },
        h('span', { className: 'cs_name', title }, title),
        h('span', { className: 'cs_meta' },
          h('span', { className: 'cs_metaKey' }, t('colAge')),
          ' ',
          formatAge(record.lastPromptAt, t)),
        h('span', { className: 'cs_meta' }, formatBytes(record.bytes)),
        reason ? h('span', { className: 'cs_badge' }, reasonLabel(t, reason)) : null,
        workspace ? h('span', { className: 'cs_path', title: workspace }, workspace) : null,
        onStar
          ? h('span', { className: 'cs_actions' },
            h('button', {
              className: 'cs_btn',
              type: 'button',
              disabled: starBusy,
              'aria-pressed': starred === true,
              onClick: () => onStar(record),
            }, starred === true ? t('actionUnstar') : t('actionStar')))
          : null);
    }

    function Dialog({ title, onClose, body, actions }) {
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [onClose]);
      return h('div', { className: 'cs_overlay', onClick: onClose },
        h('div', {
          className: 'cs_dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
          onClick: (event) => event.stopPropagation(),
        },
        h('div', { className: 'cs_dialogTitle' }, title),
        body,
        h('div', { className: 'cs_dialogActions' }, actions)));
    }

    // ── page ──────────────────────────────────────────────────────────────

    function ColdstorePage({ t }) {
      const [status, setStatus] = useState(null);
      const [statusError, setStatusError] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');

      const [query, setQuery] = useState('');
      const [fromDate, setFromDate] = useState('');
      const [toDate, setToDate] = useState('');
      const [starredOnly, setStarredOnly] = useState(false);

      const [items, setItems] = useState([]);
      const [total, setTotal] = useState(0);
      const [offset, setOffset] = useState(0);
      const [listBusy, setListBusy] = useState(false);
      const [listError, setListError] = useState('');
      const [rowBusy, setRowBusy] = useState('');

      const [preview, setPreview] = useState(null);
      const [plan, setPlan] = useState(null);
      const [planBusy, setPlanBusy] = useState(false);
      const [planStarBusy, setPlanStarBusy] = useState('');
      const [batch, setBatch] = useState(null);
      const [batchBusy, setBatchBusy] = useState('');
      const [commitOpen, setCommitOpen] = useState(false);
      const [commitResult, setCommitResult] = useState(null);
      const [deleteTarget, setDeleteTarget] = useState(null);

      const [retainDraft, setRetainDraft] = useState('');
      const [dryRunDraft, setDryRunDraft] = useState(false);
      const [keepPinnedDraft, setKeepPinnedDraft] = useState(true);
      const [keepStarredDraft, setKeepStarredDraft] = useState(true);
      const [keepUnreadDraft, setKeepUnreadDraft] = useState(true);
    const [notifyDraft, setNotifyDraft] = useState(true);
      const [minIdleDraft, setMinIdleDraft] = useState('');
      const [configBusy, setConfigBusy] = useState(false);
      const [configSynced, setConfigSynced] = useState(false);

      const searchSeq = useRef(0);
      const configDirty = useRef(false);
      const clearedBatchId = useRef('');

      const loadStatus = useCallback(async () => {
        try {
          const response = await api('/status');
          if (!response.ok) {
            setStatusError(apiMessage(t, response));
            return;
          }
          setStatus(asObject(response.body));
          setStatusError('');
        } catch (caught) {
          setStatusError(errorMessage(t, caught));
        }
      }, [t]);

      const searchPath = useCallback((nextOffset) => buildSearchPath({
        q: query,
        limit: PAGE_SIZE,
        offset: nextOffset,
        from: fromDate,
        to: toDate,
        starred: starredOnly,
      }), [query, fromDate, toDate, starredOnly]);

      const loadPage = useCallback(async (nextOffset) => {
        const seq = searchSeq.current + 1;
        searchSeq.current = seq;
        setListBusy(true);
        setListError('');
        try {
          const response = await api(searchPath(nextOffset));
          if (searchSeq.current !== seq) return;
          if (!response.ok) {
            setListError(apiMessage(t, response));
            return;
          }
          const body = asObject(response.body);
          const page = asArray(body.items);
          setItems((previous) => (nextOffset === 0 ? page : previous.concat(page)));
          setTotal(typeof body.total === 'number' && Number.isFinite(body.total) ? body.total : nextOffset + page.length);
          setOffset(nextOffset + page.length);
        } catch (caught) {
          if (searchSeq.current === seq) setListError(errorMessage(t, caught));
        } finally {
          if (searchSeq.current === seq) setListBusy(false);
        }
      }, [searchPath, t]);

      const refresh = useCallback(() => {
        void loadStatus();
        void loadPage(0);
      }, [loadStatus, loadPage]);

      useEffect(() => {
        void loadStatus();
        const timer = setInterval(() => { void loadStatus(); }, STATUS_INTERVAL_MS);
        return () => clearInterval(timer);
      }, [loadStatus]);

      useEffect(() => {
        const timer = setTimeout(() => { void loadPage(0); }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
      }, [loadPage]);

      useEffect(() => {
        if (configDirty.current) return;
        const current = asObject(status);
        setRetainDraft(typeof current.retainDays === 'number' && Number.isFinite(current.retainDays) ? String(current.retainDays) : '');
        setDryRunDraft(current.dryRun === true);
        setKeepPinnedDraft(policyFlag(current.keepPinned));
        setKeepStarredDraft(policyFlag(current.keepStarred));
        setKeepUnreadDraft(policyFlag(current.keepUnread));
        setNotifyDraft(policyFlag(current.notifyOnSweep));
        setMinIdleDraft(msToMinutesText(current.minIdleMs));
        setConfigSynced(true);
      }, [status]);

      // A staged batch survives a page refresh: `/status` carries its summary,
      // so the bar appears on the first load without a new sweep. A newer id
      // supersedes the displayed one (the Host keeps exactly one batch), and a
      // null report drops a bar the Host no longer stages.
      useEffect(() => {
        const incoming = asObject(asObject(status).batch);
        const incomingId = asText(incoming.id);
        // A poll that started before a commit/discard can still report the
        // batch we just cleared; ignore that id until the Host reports anything
        // else, so a committed bar cannot flash back.
        if (incomingId !== '' && incomingId === clearedBatchId.current) return;
        clearedBatchId.current = '';
        setBatch((previous) => nextBatchFromStatus(previous, status));
      }, [status]);

      const restoreItem = async (item) => {
        const id = asText(asObject(item).id);
        if (id === '') return;
        setRowBusy(id);
        setError('');
        setNotice('');
        try {
          const response = await api('/restore', {
            method: 'POST',
            body: JSON.stringify({ ids: [id] }),
          });
          if (!response.ok) {
            setError(apiMessage(t, response));
            return;
          }
          const body = asObject(response.body);
          const restored = asArray(body.restored);
          const failed = asArray(body.failed);
          const failure = asText(asObject(failed[0]).error);
          if (failure !== '') setError(t('error', { message: failure }));
          if (restored.length > 0) setNotice(t('restored', { n: restored.length }));
          refresh();
        } catch (caught) {
          setError(errorMessage(t, caught));
        } finally {
          setRowBusy('');
        }
      };

      const toggleStar = async (item) => {
        const record = asObject(item);
        const id = asText(record.id);
        if (id === '') return;
        const nextStarred = record.starred !== true;
        setRowBusy(id);
        setError('');
        setNotice('');
        try {
          const response = await api('/star', {
            method: 'POST',
            body: JSON.stringify({ id, starred: nextStarred }),
          });
          if (!response.ok) {
            setError(apiMessage(t, response));
            return;
          }
          setItems((previous) => previous.map((entry) => (
            asObject(entry).id === id ? Object.assign({}, asObject(entry), { starred: nextStarred }) : entry
          )));
          if (nextStarred) setNotice(t('starred'));
          if (starredOnly && !nextStarred) refresh();
        } catch (caught) {
          setError(errorMessage(t, caught));
        } finally {
          setRowBusy('');
        }
      };

      const openPreview = async (item) => {
        const record = asObject(item);
        const id = asText(record.id);
        if (id === '') return;
        setPreview({ item: record, busy: true, error: '', entry: {}, text: '' });
        try {
          const response = await api('/session?id=' + encodeURIComponent(id));
          if (!response.ok) {
            setPreview({ item: record, busy: false, error: apiMessage(t, response), entry: {}, text: '' });
            return;
          }
          const body = asObject(response.body);
          setPreview({
            item: record,
            busy: false,
            error: '',
            entry: asObject(body.entry),
            text: asText(body.preview),
          });
        } catch (caught) {
          setPreview({ item: record, busy: false, error: errorMessage(t, caught), entry: {}, text: '' });
        }
      };

      const planParams = useCallback(() => buildPlanPath(asObject(status).retainDays), [status]);

      const fetchPlan = async () => {
        const response = await api(planParams());
        if (!response.ok) {
          // The caller wraps this message through `error` exactly once.
          throw new Error(asText(asObject(response.body).error) || 'HTTP ' + String(response.status));
        }
        const body = asObject(response.body);
        return {
          candidates: asArray(body.candidates),
          exempt: asArray(body.exempt),
          totals: asObject(body.totals),
        };
      };

      const openPlan = async () => {
        setError('');
        setNotice('');
        setPlan({ busy: true, error: '', candidates: [], exempt: [], totals: {} });
        try {
          const data = await fetchPlan();
          setPlan({ busy: false, error: '', candidates: data.candidates, exempt: data.exempt, totals: data.totals });
        } catch (caught) {
          setPlan({ busy: false, error: errorMessage(t, caught), candidates: [], exempt: [], totals: {} });
        }
      };

      /**
       * Star a live plan candidate before it freezes. `/star` accepts any
       * session id, so no Host change is needed. Only the open plan mutates:
       * the search box, filters, status strip and dry-run banner keep their
       * state, and the next `/plan` fetch sees the row as exempt server-side.
       */
      const starCandidate = async (item) => {
        const record = asObject(item);
        const id = asText(record.id);
        if (id === '') return;
        setPlanStarBusy(id);
        setError('');
        setNotice('');
        try {
          const response = await api('/star', {
            method: 'POST',
            body: JSON.stringify({ id, starred: true }),
          });
          if (!response.ok) {
            setError(apiMessage(t, response));
            return;
          }
          setPlan((previous) => starCandidateInPlan(previous, id));
          setNotice(t('starred'));
        } catch (caught) {
          setError(errorMessage(t, caught));
        } finally {
          setPlanStarBusy('');
        }
      };

      /**
       * Maker step: stage the current plan as a pending batch. Nothing moves
       * here, so the only result is the staged bar (no `frozen` notice).
       */
      const stageSweep = async () => {
        setError('');
        setNotice('');
        setPlanBusy(true);
        try {
          const response = await api('/sweep', {
            method: 'POST',
            body: JSON.stringify({}),
          });
          if (!response.ok) {
            setError(apiMessage(t, response));
            return;
          }
          setBatch(asObject(response.body));
          setCommitOpen(false);
          setPlan(null);
        } catch (caught) {
          setError(errorMessage(t, caught));
        } finally {
          setPlanBusy(false);
        }
      };

      const closeCommit = () => {
        if (batchBusy === 'commit') return;
        setCommitOpen(false);
      };

      const openCommit = () => {
        setError('');
        setNotice('');
        // Client-side refusal: the Host refuses a dry-run commit too, but the
        // page must never present Commit as available while dryRun is on.
        if (asObject(status).dryRun === true) {
          setError(t('dryRunOn'));
          return;
        }
        if (asText(asObject(batch).id) === '') return;
        setCommitOpen(true);
      };

      /** Checker step: move exactly the reviewed batch, then report skips. */
      const commitBatchNow = async () => {
        const staged = asObject(batch);
        const id = asText(staged.id);
        if (id === '') {
          setCommitOpen(false);
          return;
        }
        setBatchBusy('commit');
        setError('');
        try {
          const response = await api('/commit', {
            method: 'POST',
            body: JSON.stringify({ batchId: id }),
          });
          if (!response.ok) {
            setCommitOpen(false);
            setError(apiMessage(t, response));
            return;
          }
          const body = asObject(response.body);
          const moved = asArray(body.moved);
          const skipped = asArray(body.skipped);
          const known = asArray(staged.candidates).concat(asArray(staged.exempt));
          setCommitOpen(false);
          clearedBatchId.current = id;
          setBatch(null);
          setNotice(t('frozen', { n: moved.length, bytes: formatBytes(body.bytes) }));
          if (skipped.length > 0) {
            setCommitResult({
              movedCount: moved.length,
              bytes: toFiniteNumber(body.bytes, 0),
              skipped: commitSkipEntries(skipped, known),
            });
          }
          refresh();
        } catch (caught) {
          setCommitOpen(false);
          setError(errorMessage(t, caught));
        } finally {
          setBatchBusy('');
        }
      };

      const discardBatch = async () => {
        const id = asText(asObject(batch).id);
        setBatchBusy('discard');
        setError('');
        try {
          const response = await api('/discard', {
            method: 'POST',
            body: JSON.stringify({}),
          });
          if (!response.ok) {
            setError(apiMessage(t, response));
            return;
          }
          clearedBatchId.current = id;
          setBatch(null);
          refresh();
        } catch (caught) {
          setError(errorMessage(t, caught));
        } finally {
          setBatchBusy('');
        }
      };

      const deleteItem = async () => {
        const current = deleteTarget;
        if (!current) return;
        const id = asText(asObject(current.item).id);
        if (id === '') {
          setDeleteTarget(null);
          return;
        }
        setDeleteTarget({ item: current.item, busy: true });
        setError('');
        setNotice('');
        try {
          const response = await api('/delete', {
            method: 'POST',
            body: JSON.stringify({ ids: [id] }),
          });
          if (!response.ok) {
            setDeleteTarget(null);
            setError(apiMessage(t, response));
            return;
          }
          setDeleteTarget(null);
          refresh();
        } catch (caught) {
          setDeleteTarget(null);
          setError(errorMessage(t, caught));
        }
      };

      // Apply a policy change immediately. The switches used to only move a
      // draft, so toggling "live mode" left the Host on dry run and Commit
      // stayed disabled with no explanation — the patch is posted on the spot.
      const applyConfig = async (patch) => {
        setConfigBusy(true);
        setError('');
        setNotice('');
        try {
          const payload = buildConfigPayload(status, Object.assign({
            retainDays: retainDraft,
            dryRun: dryRunDraft,
            keepPinned: keepPinnedDraft,
            keepStarred: keepStarredDraft,
            keepUnread: keepUnreadDraft,
            notifyOnSweep: notifyDraft,
            minIdleMs: minIdleDraft,
          }, asObject(patch)));
          const response = await api('/config', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            setError(apiMessage(t, response));
            return false;
          }
          configDirty.current = false;
          setNotice(t('saved'));
          await loadStatus();
          return true;
        } catch (caught) {
          setError(errorMessage(t, caught));
          return false;
        } finally {
          setConfigBusy(false);
        }
      };

      const saveConfig = async () => { await applyConfig({}); };

      const closePlan = () => {
        if (plan && plan.busy) return;
        setPlan(null);
      };
      const closePreview = () => setPreview(null);
      const closeDelete = () => {
        if (deleteTarget && deleteTarget.busy) return;
        setDeleteTarget(null);
      };

      // Display values derived from the last `/status` snapshot. These were
      // lost once to a careless edit; the render harness in test/ now catches
      // an unbound identifier instead of blanking the slot at runtime.
      const statusView = asObject(status);
      const ready = status !== null && status !== undefined;
      const live = asObject(statusView.live);
      const cold = asObject(statusView.cold);
      const dryRun = statusView.dryRun === true;
      const lastSweep = typeof statusView.lastSweep === 'number' && statusView.lastSweep > 0
        ? new Date(statusView.lastSweep).toLocaleString()
        : '';

      // Drafts are seeded from `/status`; keep the controls inert until that
      // first sync so an early click cannot post default zeros.
      const configDisabled = configSynced !== true || configBusy === true;
      const hasMore = items.length < total;
      const batchInfo = batchSummary(batch);
      const batchStagedWhen = batchInfo.createdAt > 0 ? formatAge(batchInfo.createdAt, t) : '';
      const canCommit = batchInfo.id !== '' && dryRun !== true && batchBusy === '' && batchInfo.count > 0;

      return h('div', { className: 'cs_section' },
        h('div', { className: 'cs_header' },
          h('h2', { className: 'cs_title' }, t('title')),
          h('div', { className: 'cs_subtitle' }, t('subtitle'))),

        statusError ? h('div', { className: 'cs_err' }, statusError) : null,
        error ? h('div', { className: 'cs_err' }, error) : null,
        notice ? h('div', { className: 'cs_notice' }, notice) : null,

        h('div', { className: 'cs_strip' },
          h(Stat, { label: t('statusLive'), value: ready ? String(asCount(live.count)) : '…' }),
          h(Stat, { label: t('statusCold'), value: ready ? String(asCount(cold.count)) : '…' }),
          h(Stat, { label: t('statusBytes'), value: ready ? formatBytes(cold.bytes) : '…' }),
          h(Stat, { label: t('statusSince'), value: ready ? (lastSweep || t('statusNever')) : '…' })),

        dryRun ? h('div', { className: 'cs_banner' }, t('dryRunOn')) : null,

        h('label', { className: 'cs_search' },
          h('svg', { width: '14', height: '14', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
            h('circle', { cx: '7', cy: '7', r: '5', stroke: 'currentColor', strokeWidth: '1.5' }),
            h('path', { d: 'M11 11l3 3', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' })),
          h('input', {
            type: 'search',
            value: query,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchPlaceholder'),
            onChange: (event) => setQuery(event.target.value),
          })),

        h('div', { className: 'cs_filters' },
          h('label', { className: 'cs_field' }, t('filterFrom'),
            h('input', {
              type: 'date',
              value: fromDate,
              onChange: (event) => setFromDate(event.target.value),
            })),
          h('label', { className: 'cs_field' }, t('filterTo'),
            h('input', {
              type: 'date',
              value: toDate,
              onChange: (event) => setToDate(event.target.value),
            })),
          h('label', { className: 'cs_check' },
            h('input', {
              type: 'checkbox',
              checked: starredOnly,
              onChange: (event) => setStarredOnly(event.target.checked),
            }),
            h('span', null, t('filterStarred')))),

        h('div', { className: 'cs_hint' }, t('searchHint')),

        h('div', { className: 'cs_sectionHead' },
          h('span', { className: 'cs_sectionHeadTitle' }, t('colTitle')),
          h('span', { className: 'cs_sectionHeadCount' }, String(total))),

        listError ? h('div', { className: 'cs_err' }, listError) : null,

        items.length === 0
          ? h('div', { className: 'cs_empty' }, listBusy ? '…' : (query.trim() !== '' ? t('searchEmpty') : t('empty')))
          : h('div', { className: 'cs_list' },
            items.map((item, index) => h(SessionRow, {
              t,
              item,
              index,
              key: asText(asObject(item).id) || 'row-' + String(index),
              busy: rowBusy === asText(asObject(item).id),
              onPreview: openPreview,
              onToggleStar: toggleStar,
              onRestore: restoreItem,
              onDelete: (record) => setDeleteTarget({ item: record, busy: false }),
            }))),

        hasMore
          ? h('div', { className: 'cs_actionsBar' },
            h('button', {
              className: 'cs_btn',
              type: 'button',
              disabled: listBusy,
              onClick: () => { void loadPage(offset); },
            }, listBusy ? '…' : t('loadMore')))
          : null,

        h('div', { className: 'cs_actionsBar' },
          h('button', {
            className: 'cs_btn',
            type: 'button',
            disabled: planBusy,
            onClick: openPlan,
          }, planBusy ? '…' : t('actionPreviewPlan')),
          h('button', {
            className: 'cs_btn',
            type: 'button',
            disabled: planBusy,
            onClick: stageSweep,
          }, planBusy ? '…' : t('actionStageSweep'))),

        batch ? h('div', { className: 'cs_batch' },
          h('div', { className: 'cs_batchText' },
            h('span', { className: 'cs_batchTitle' }, t('staged')),
            h('span', { className: 'cs_batchMeta' },
              t('planCandidates'),
              ' ',
              String(batchInfo.count),
              ' · ',
              formatBytes(batchInfo.bytes),
              batchStagedWhen ? ' · ' + batchStagedWhen : ''),
            dryRun ? h('span', { className: 'cs_batchHint' }, t('dryRunOn')) : null),
          h('span', { className: 'cs_actions' },
            h('button', {
              className: 'cs_btn primary',
              type: 'button',
              disabled: !canCommit,
              title: dryRun ? t('dryRunOn') : undefined,
              onClick: openCommit,
            }, batchBusy === 'commit' ? '…' : t('actionCommit')),
            h('button', {
              className: 'cs_btn',
              type: 'button',
              disabled: batchBusy !== '',
              onClick: discardBatch,
            }, batchBusy === 'discard' ? '…' : t('actionDiscard'))))
          : null,

        h('div', { className: 'cs_config' },
          h('div', { className: 'cs_configRow' },
            h('label', { className: 'cs_field' }, t('retainDays'),
              h('input', {
                type: 'number',
                min: 0,
                step: 1,
                value: retainDraft,
                disabled: configDisabled,
                onChange: (event) => {
                  configDirty.current = true;
                  setRetainDraft(event.target.value);
                },
              })),
            h('label', { className: 'cs_field' }, t('minIdleMinutes'),
              h('input', {
                type: 'number',
                min: 0,
                step: 1,
                value: minIdleDraft,
                disabled: configDisabled,
                onChange: (event) => {
                  configDirty.current = true;
                  setMinIdleDraft(event.target.value);
                },
              })),
            h('button', {
              className: 'cs_btn primary',
              type: 'button',
              disabled: configDisabled,
              onClick: saveConfig,
            }, configBusy ? '…' : t('save'))),
          h('div', { className: 'cs_configRow' },
            h(SwitchControl, {
              label: dryRunDraft ? t('dryRunOn') : t('dryRunOff'),
              on: dryRunDraft === true,
              busy: configDisabled,
              onChange: () => {
                const next = !(dryRunDraft === true);
                configDirty.current = true;
                setDryRunDraft(next);
                void applyConfig({ dryRun: next });
              },
            })),
          h('div', { className: 'cs_configRow' },
            h(SwitchControl, {
              label: t('keepPinned'),
              on: keepPinnedDraft === true,
              busy: configDisabled,
              onChange: () => {
                const next = !(keepPinnedDraft === true);
                configDirty.current = true;
                setKeepPinnedDraft(next);
                void applyConfig({ keepPinned: next });
              },
            })),
          h('div', { className: 'cs_configRow' },
            h(SwitchControl, {
              label: t('keepStarred'),
              on: keepStarredDraft === true,
              busy: configDisabled,
              onChange: () => {
                const next = !(keepStarredDraft === true);
                configDirty.current = true;
                setKeepStarredDraft(next);
                void applyConfig({ keepStarred: next });
              },
            })),
          h('div', { className: 'cs_configRow' },
            h(SwitchControl, {
              label: t('keepUnread'),
              on: keepUnreadDraft === true,
              busy: configDisabled,
              onChange: () => {
                const next = !(keepUnreadDraft === true);
                configDirty.current = true;
                setKeepUnreadDraft(next);
                void applyConfig({ keepUnread: next });
              },
            })),
          h('div', { className: 'cs_configRow' },
            h(SwitchControl, {
              label: t('notifyOnSweep'),
              on: notifyDraft === true,
              busy: configDisabled,
              onChange: () => {
                const next = !(notifyDraft === true);
                configDirty.current = true;
                setNotifyDraft(next);
                void applyConfig({ notifyOnSweep: next });
              },
            }))),

        plan ? h(Dialog, {
          title: t('actionPreviewPlan'),
          onClose: closePlan,
          body: plan.busy
            ? h('div', { className: 'cs_meta' }, '…')
            : plan.error
              ? h('div', { className: 'cs_err' }, plan.error)
              : h('div', null,
                h('div', { className: 'cs_meta' },
                  h('span', null, t('statusCold'), ' ', String(asCount(asObject(plan.totals).count))),
                  h('span', null, t('statusBytes'), ' ', formatBytes(asObject(plan.totals).bytes))),
                h('div', { className: 'cs_groupTitle' }, t('planCandidates')),
                plan.candidates.length === 0
                  ? h('div', { className: 'cs_empty' }, t('empty'))
                  : h('div', { className: 'cs_list' },
                    plan.candidates.map((item, index) => h(PlanRow, {
                      t,
                      item,
                      index,
                      key: asText(asObject(item).id) || 'candidate-' + String(index),
                      starred: false,
                      starBusy: planStarBusy === asText(asObject(item).id),
                      onStar: starCandidate,
                    }))),
                plan.exempt.length === 0 ? null : h('div', { className: 'cs_groupTitle' }, t('planExempt')),
                plan.exempt.length === 0
                  ? null
                  : h('div', { className: 'cs_list' },
                    plan.exempt.map((item, index) => h(PlanRow, {
                      t,
                      item,
                      index,
                      key: asText(asObject(item).id) || 'exempt-' + String(index),
                      reason: asObject(item).reason,
                    })))),
          actions: h(React.Fragment, null,
            h('button', { className: 'cs_btn', type: 'button', onClick: closePlan, disabled: plan.busy }, t('cancel')),
            h('button', { className: 'cs_btn', type: 'button', onClick: stageSweep, disabled: plan.busy || plan.error !== '' }, t('actionStageSweep'))),
        }) : null,

        preview ? h(Dialog, {
          title: t('actionPreview'),
          onClose: closePreview,
          body: preview.busy
            ? h('div', { className: 'cs_meta' }, '…')
            : preview.error
              ? h('div', { className: 'cs_err' }, preview.error)
              : h('div', null,
                h('div', { className: 'cs_dialogBody' }, asText(asObject(preview.entry).title) || asText(asObject(preview.item).title) || asText(asObject(preview.item).id)),
                h('div', { className: 'cs_path' }, asText(asObject(preview.entry).cwd) || asText(asObject(preview.item).cwd)),
                h('div', { className: 'cs_meta' },
                  h('span', null, h('span', { className: 'cs_metaKey' }, t('colAge')), ' ', formatAge(asObject(preview.entry).lastPromptAt, t)),
                  h('span', null, h('span', { className: 'cs_metaKey' }, t('colSize')), ' ', formatBytes(asObject(preview.entry).bytes))),
                h('pre', { className: 'cs_pre' }, preview.text !== '' ? preview.text : t('previewEmpty'))),
          actions: h('button', { className: 'cs_btn', type: 'button', onClick: closePreview, autoFocus: true }, t('close')),
        }) : null,

        commitOpen && batchInfo.id !== '' ? h(Dialog, {
          title: t('actionCommit'),
          onClose: closeCommit,
          body: h('div', null,
            h('div', { className: 'cs_dialogBody' }, t('confirmFreeze', { n: batchInfo.count })),
            h('div', { className: 'cs_meta' },
              h('span', null, t('statusBytes'), ' ', formatBytes(batchInfo.bytes)))),
          actions: h(React.Fragment, null,
            h('button', { className: 'cs_btn', type: 'button', onClick: closeCommit, disabled: batchBusy === 'commit', autoFocus: true }, t('cancel')),
            h('button', { className: 'cs_btn danger', type: 'button', onClick: commitBatchNow, disabled: batchBusy === 'commit' }, batchBusy === 'commit' ? '…' : t('actionCommit'))),
        }) : null,

        commitResult ? h(Dialog, {
          title: t('skipped'),
          onClose: () => setCommitResult(null),
          body: h('div', null,
            h('div', { className: 'cs_dialogBody' }, t('frozen', { n: commitResult.movedCount, bytes: formatBytes(commitResult.bytes) })),
            h('div', { className: 'cs_list' },
              commitResult.skipped.map((entry, index) => h('div', {
                className: 'cs_planRow',
                key: entry.id || 'skipped-' + String(index),
              },
              h('span', { className: 'cs_name', title: entry.title || entry.id }, entry.title || entry.id),
              h('span', { className: 'cs_badge' }, reasonLabel(t, entry.reason)))))),
          actions: h('button', { className: 'cs_btn', type: 'button', onClick: () => setCommitResult(null), autoFocus: true }, t('close')),
        }) : null,

        deleteTarget ? h(Dialog, {
          title: t('actionDelete'),
          onClose: closeDelete,
          body: h('div', null,
            h('div', { className: 'cs_dialogBody' }, t('confirmDelete', { n: 1 })),
            h('div', { className: 'cs_path' }, asText(asObject(deleteTarget.item).title) || asText(asObject(deleteTarget.item).id))),
          actions: h(React.Fragment, null,
            h('button', { className: 'cs_btn', type: 'button', onClick: closeDelete, disabled: deleteTarget.busy, autoFocus: true }, t('cancel')),
            h('button', { className: 'cs_btn danger', type: 'button', onClick: deleteItem, disabled: deleteTarget.busy }, deleteTarget.busy ? '…' : t('actionDelete'))),
        }) : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind('coldstore');

        ctx.effect(
          () => ctx.locale.register('coldstore', { en }),
          'session-coldstore: dictionaries',
        );

        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          const selector = 'style[data-coldstore-css="session-coldstore"]';
          const previous = document.querySelector(selector);
          if (previous) previous.remove();
          const tag = document.createElement('style');
          tag.dataset.coldstoreCss = 'session-coldstore';
          tag.textContent = css;
          document.head.appendChild(tag);
          return () => {
            tag.remove();
          };
        }, 'session-coldstore: styles');

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'session-coldstore',
          order: 55,
          label: () => t('sectionLabel'),
          locale: 'coldstore',
        }, ColdstorePage));
      },
    };
  },
});
