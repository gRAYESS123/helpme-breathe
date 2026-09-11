/**
 * js/pro/streaks.js — "Your practice": streaks, a 12-week heatmap, totals,
 * a per-technique breakdown and a CSV export.
 *
 * Everything is computed in the browser from `storage.getHistory()`. Nothing is
 * uploaded, there is no account, and the CSV is built with a Blob so no server
 * is involved.
 *
 * Free tier sees the last seven days plus a dimmed heatmap teaser and a Pro
 * badge — dimmed, never blurred: the identity carries no blur. Pro sees the
 * whole picture.
 *
 * Dates are handled in the visitor's own timezone, using local Y/M/D parts, so
 * a streak does not break at a month boundary or across a DST change.
 */

import { getHistory } from '../storage.js';
import { getTechnique } from '../techniques.js';
import { requirePro, isPro, onChange } from '../entitlements.js';

const WEEKS = 12;
const DAYS = WEEKS * 7;
const DAY_MS = 24 * 60 * 60 * 1000;

let uid = 0;

/* ------------------------------------------------------------------ dates */

function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, n) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + n);
  return next;
}

/* ------------------------------------------------------------ computation */

/**
 * Summarise a history array.
 * @param {Array<{date:string, technique:string, seconds:number, breaths:number, completed:boolean}>} history
 */
export function summarise(history) {
  const byDay = new Map();
  const byTechnique = new Map();
  let totalSeconds = 0;
  let sessions = 0;

  for (const record of history) {
    const when = new Date(record.date);
    if (Number.isNaN(when.getTime())) continue;
    const key = dayKey(when);
    const day = byDay.get(key) || { sessions: 0, seconds: 0 };
    day.sessions += 1;
    day.seconds += Number(record.seconds) || 0;
    byDay.set(key, day);

    const techniqueKey = record.technique || 'unknown';
    const stat = byTechnique.get(techniqueKey) || { sessions: 0, seconds: 0 };
    stat.sessions += 1;
    stat.seconds += Number(record.seconds) || 0;
    byTechnique.set(techniqueKey, stat);

    totalSeconds += Number(record.seconds) || 0;
    sessions += 1;
  }

  // Current streak: today, or yesterday if today has not happened yet.
  const today = startOfDay(new Date());
  let cursor = byDay.has(dayKey(today)) ? today : addDays(today, -1);
  let current = 0;
  while (byDay.has(dayKey(cursor))) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  if (!byDay.has(dayKey(today)) && !byDay.has(dayKey(addDays(today, -1)))) current = 0;

  // Longest streak: walk the sorted distinct days.
  const keys = Array.from(byDay.keys()).sort();
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const key of keys) {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    if (previous && Math.round((date - previous) / DAY_MS) === 1) run += 1;
    else run = 1;
    previous = date;
    if (run > longest) longest = run;
  }

  // Last seven days, including today.
  let weekSessions = 0;
  let weekSeconds = 0;
  for (let i = 0; i < 7; i++) {
    const day = byDay.get(dayKey(addDays(today, -i)));
    if (!day) continue;
    weekSessions += day.sessions;
    weekSeconds += day.seconds;
  }

  return {
    byDay,
    byTechnique,
    sessions,
    totalSeconds,
    totalMinutes: Math.round(totalSeconds / 60),
    currentStreak: current,
    longestStreak: longest,
    weekSessions,
    weekMinutes: Math.round(weekSeconds / 60),
    activeDays: byDay.size,
  };
}

function techniqueName(key) {
  if (key === 'custom') return 'Custom patterns';
  const technique = getTechnique(key);
  return technique ? technique.title || technique.shortName || key : key;
}

function intensity(seconds) {
  if (seconds <= 0) return 0;
  if (seconds < 180) return 1;
  if (seconds < 420) return 2;
  if (seconds < 900) return 3;
  return 4;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function humanDate(date) {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/* -------------------------------------------------------------------- CSV */

function csvCell(value) {
  const text = String(value === null || value === undefined ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Build the CSV text for a history array. Exported so it can be checked. */
export function historyToCsv(history) {
  const lines = ['date,technique,seconds,breaths,completed'];
  for (const record of history) {
    lines.push(
      [record.date, record.technique, record.seconds, record.breaths, record.completed === true]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n');
}

function downloadCsv(history) {
  const blob = new Blob([historyToCsv(history)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `help-me-breathe-history-${dayKey(new Date())}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* --------------------------------------------------------------------- UI */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statTile(value, label) {
  const tile = el('div', 'practice-stat');
  tile.append(el('span', 'practice-stat-value', String(value)), el('span', 'practice-stat-label', label));
  return tile;
}

function buildHeatmap(summary, { teaser }) {
  const grid = el('div', 'heatmap');
  if (teaser) {
    grid.classList.add('is-teaser');
    grid.setAttribute('aria-hidden', 'true');
  } else {
    // A list of labelled days reads correctly in a screen reader; role="grid"
    // would need real rows and buys nothing here.
    grid.setAttribute('role', 'list');
    grid.setAttribute('aria-label', 'Your last 12 weeks of practice, one item per day');
  }

  const today = startOfDay(new Date());
  // Columns are weeks, oldest first; rows are days within the week.
  const first = addDays(today, -(DAYS - 1));
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(first, i);
    const day = summary.byDay.get(dayKey(date));
    const seconds = day ? day.seconds : 0;
    const cell = el('span', `heatmap-cell level-${intensity(seconds)}`);
    if (!teaser) {
      cell.setAttribute('role', 'listitem');
      const minutes = Math.round(seconds / 60);
      cell.setAttribute(
        'aria-label',
        day
          ? `${humanDate(date)}: ${day.sessions} session${day.sessions === 1 ? '' : 's'}, ${minutes} minute${minutes === 1 ? '' : 's'}`
          : `${humanDate(date)}: no practice`,
      );
    }
    grid.appendChild(cell);
  }
  return grid;
}

/**
 * Wire the practice panel onto one timer instance.
 * @param {Element} rootEl the `[data-breathing-app]` element
 * @param {{quiet?:boolean}} [options] `quiet` on a `data-no-asks` page: a free
 *        visitor sees their own numbers and no upgrade prompt of any kind.
 */
export function initStreaks(rootEl, options = {}) {
  const quiet = options.quiet === true;
  if (!rootEl) return;
  if (rootEl.dataset.proStreaks === 'on') return;
  rootEl.dataset.proStreaks = 'on';

  const tools = rootEl.querySelector('[data-slot="tools"]');
  if (!tools) return;

  const id = `practice-${++uid}`;

  const toggle = el('button', 'tool-btn', 'Your practice');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', id);
  tools.appendChild(toggle);

  const panel = el('div', 'pro-panel');
  panel.id = id;
  panel.hidden = true;
  panel.setAttribute('data-pro-panel', 'practice');
  tools.parentNode.insertBefore(panel, tools.nextSibling);

  function render() {
    const history = getHistory();
    const summary = summarise(history);
    const unlocked = isPro();

    panel.innerHTML = '';
    panel.appendChild(el('h3', 'pro-panel-title', 'Your practice'));

    if (!history.length) {
      panel.appendChild(
        el(
          'p',
          'pro-panel-help',
          'Nothing recorded yet. Finish a session and it will show up here. Sessions shorter than 30 seconds are not counted.',
        ),
      );
      const slot = el('div', '');
      slot.setAttribute('data-paywall-slot', '');
      panel.appendChild(slot);
      return;
    }

    const stats = el('div', 'practice-stats');
    if (unlocked) {
      stats.append(
        statTile(summary.currentStreak, summary.currentStreak === 1 ? 'day streak' : 'days in a row'),
        statTile(summary.longestStreak, 'longest streak'),
        statTile(summary.totalMinutes, 'minutes total'),
        statTile(summary.weekSessions, 'sessions this week'),
      );
    } else {
      stats.append(
        statTile(summary.weekSessions, 'sessions, last 7 days'),
        statTile(summary.weekMinutes, 'minutes, last 7 days'),
      );
    }
    panel.appendChild(stats);

    if (unlocked) {
      panel.appendChild(el('h4', 'preset-heading', 'The last 12 weeks'));
      panel.appendChild(buildHeatmap(summary, { teaser: false }));
      panel.appendChild(
        el('p', 'pro-panel-help', 'Each square is a day. Darker means more minutes practised that day.'),
      );

      panel.appendChild(el('h4', 'preset-heading', 'By technique'));
      const list = el('ul', 'technique-breakdown');
      const rows = Array.from(summary.byTechnique.entries()).sort((a, b) => b[1].seconds - a[1].seconds);
      for (const [key, stat] of rows) {
        const minutes = Math.round(stat.seconds / 60);
        list.appendChild(
          el(
            'li',
            '',
            `${techniqueName(key)} — ${stat.sessions} session${stat.sessions === 1 ? '' : 's'}, ${minutes} minute${minutes === 1 ? '' : 's'}`,
          ),
        );
      }
      panel.appendChild(list);

      const actions = el('div', 'pro-panel-actions');
      const csv = el('button', 'pro-btn', 'Export CSV');
      csv.type = 'button';
      csv.addEventListener('click', () => downloadCsv(getHistory()));
      actions.appendChild(csv);
      panel.appendChild(actions);
    } else if (quiet) {
      panel.appendChild(
        el(
          'p',
          'pro-panel-help',
          'Your sessions are counted in this browser and nothing is uploaded. Clearing your browser data clears them.',
        ),
      );
    } else {
      panel.appendChild(el('h4', 'preset-heading', 'The last 12 weeks'));
      const teaserWrap = el('div', 'heatmap-teaser');
      teaserWrap.appendChild(buildHeatmap(summary, { teaser: true }));

      const badge = el('button', 'pro-btn pro-badge', 'See the full picture');
      badge.type = 'button';
      badge.appendChild(
        (() => {
          const pill = el('span', 'pro-pill', 'Pro');
          pill.setAttribute('aria-hidden', 'true');
          return pill;
        })(),
      );
      badge.addEventListener('click', () => requirePro('streaks'));
      teaserWrap.appendChild(badge);
      panel.appendChild(teaserWrap);
      panel.appendChild(
        el(
          'p',
          'pro-panel-help',
          'Streaks, the 12-week heatmap, the per-technique breakdown and the CSV export are part of Pro. Your history is stored in this browser either way, and nothing is uploaded.',
        ),
      );
    }

    const slot = el('div', '');
    slot.setAttribute('data-paywall-slot', '');
    panel.appendChild(slot);
  }

  toggle.addEventListener('click', () => {
    const open = panel.hidden;
    if (open) render();
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('hmb:session-complete', () => {
    if (!panel.hidden) render();
  });

  onChange(() => {
    if (!panel.hidden) render();
  });
}
