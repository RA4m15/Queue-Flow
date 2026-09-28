import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, PieChart, Pie, Legend,
  LineChart, Line,
} from 'recharts';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useQueue } from '../hooks/useQueue';
import { useCounters } from '../hooks/useCounters';
import { useCrowd } from '../hooks/useCrowd';

// ─── Palette ─────────────────────────────────────────────────────────────────
const C = {
  bg:      '#070c09',
  surface: '#0d1510',
  raised:  '#141f18',
  border:  'rgba(0,255,135,0.09)',
  accent:  '#00ff87',
  accentD: '#00c96e',
  text:    '#e8f5ed',
  muted:   'rgba(232,245,237,0.38)',
  green:   '#00ff87',
  amber:   '#f5a623',
  red:     '#ff4444',
  cyan:    '#00e5ff',
};

// ─── Data ─────────────────────────────────────────────────────────────────────
const FOOTFALL_DATA = [
  { t: '08:00', actual: 28, cap: 400 },
  { t: '09:00', actual: 72, cap: 400 },
  { t: '10:00', actual: 138, cap: 400 },
  { t: '11:00', actual: 201, cap: 400 },
  { t: '12:00', actual: 162, cap: 400 },
  { t: '13:00', actual: 89, cap: 400 },
  { t: '14:00', actual: 124, cap: 400 },
  { t: '15:00', actual: 197, cap: 400 },
  { t: '16:00', actual: null, predicted: 214, cap: 400 },
  { t: '17:00', actual: null, predicted: 178, cap: 400 },
];

const AVG_WAIT_DATA = [
  { t: '08:00', wait: 6 },
  { t: '09:00', wait: 9 },
  { t: '10:00', wait: 14 },
  { t: '11:00', wait: 18 },
  { t: '12:00', wait: 11 },
  { t: '13:00', wait: 7 },
  { t: '14:00', wait: 12 },
  { t: '15:00', wait: 16 },
];

const SERVICE_DEMAND = [
  { name: 'License Renewal', value: 26, color: C.accent },
  { name: 'Tax Payment',     value: 21, color: C.cyan   },
  { name: 'Certificate',     value: 17, color: C.green  },
  { name: 'Property Rec.',   value: 14, color: C.amber  },
  { name: 'Other',           value: 22, color: C.muted  },
];

const COUNTERS_DATA = [
  { id: 'A', serving: 'A-246', name: 'Priya Sharma',    service: 'License Renewal', waiting: 8,  served: 31, util: 78,  status: 'active' },
  { id: 'B', serving: 'A-247', name: 'Rajan Mehta',     service: 'Tax Payment',     waiting: 12, served: 28, util: 92,  status: 'busy' },
  { id: 'C', serving: 'A-233', name: 'Tarun Joshi',     service: 'Certificate',     waiting: 3,  served: 41, util: 45,  status: 'active' },
  { id: 'D', serving: '—',     name: '—',               service: '—',               waiting: 0,  served: 19, util: 0,   status: 'break' },
  { id: 'E', serving: '—',     name: '—',               service: '—',               waiting: 0,  served: 0,  util: 0,   status: 'closed' },
  { id: 'F', serving: 'A-219', name: 'Anita Patel',     service: 'Property Rec.',   waiting: 6,  served: 24, util: 61,  status: 'active' },
];

const QUEUE_TABLE = [
  { token: 'A-247', name: 'Rajan Mehta',     service: 'Tax Payment',      wait: 18, counter: 'B', status: 'called',  time: '09:41' },
  { token: 'A-248', name: 'Sunita Rao',      service: 'License Renewal',  wait: 21, counter: 'A', status: 'waiting', time: '09:38' },
  { token: 'A-249', name: 'Dev Kapoor',      service: 'Certificate',      wait: 25, counter: 'C', status: 'waiting', time: '09:36' },
  { token: 'A-250', name: 'Meera Nair',      service: 'Tax Payment',      wait: 28, counter: 'B', status: 'waiting', time: '09:34' },
  { token: 'A-251', name: 'Arjun Singh',     service: 'Property Rec.',    wait: 31, counter: 'F', status: 'waiting', time: '09:31' },
  { token: 'A-252', name: 'Kavitha Reddy',   service: 'License Renewal',  wait: 34, counter: 'A', status: 'waiting', time: '09:28' },
  { token: 'A-253', name: 'Mohit Gupta',     service: 'Certificate',      wait: 36, counter: 'C', status: 'waiting', time: '09:25' },
  { token: 'A-219', name: 'Anita Patel',     service: 'Property Rec.',    wait: 4,  counter: 'F', status: 'serving', time: '09:18' },
];

const ALERTS = [
  { type: 'warn', title: 'Demand spike predicted — 3:00 PM', desc: 'ML model forecasts +42 visitors between 3–4 PM. Recommend opening Counter E now.', time: 'Just now' },
  { type: 'info', title: 'Counter B avg wait above threshold', desc: 'Avg 18 min at Counter B exceeds the 15 min SLA. Consider rerouting Tax Payment to Counter D.', time: '4 min ago' },
  { type: 'ok',   title: 'Counter C underutilised (45%)',      desc: 'Redirect some Counter A overflow to Counter C to balance load.', time: '12 min ago' },
  { type: 'skip', title: 'Token A-244 marked no-show',         desc: 'Visitor did not respond to 2 SMS + app alerts. Token has been auto-skipped.', time: '18 min ago' },
];

const ACTIVITY_LOG = [
  { time: '09:41', event: 'A-247 called to Counter B',          tag: 'called' },
  { time: '09:40', event: 'A-246 served — 6m 12s at Counter A', tag: 'done'   },
  { time: '09:38', event: 'SMS alert sent to A-248 (5 ahead)',  tag: 'sms'    },
  { time: '09:36', event: 'IoT footfall: 197 → 201 persons',   tag: 'iot'    },
  { time: '09:35', event: 'Counter D went on break',            tag: 'break'  },
  { time: '09:31', event: 'A-244 no-show — auto-skipped',       tag: 'skip'   },
  { time: '09:28', event: 'A-243 served — 4m 58s at Counter C', tag: 'done'   },
  { time: '09:25', event: 'New token A-253 issued (Certificate)', tag: 'new'  },
];

const TAG_META = {
  called: { bg: 'rgba(129,140,248,0.12)', color: C.accent, label: 'CALLED'  },
  done:   { bg: 'rgba(34,197,94,0.1)',    color: C.green,  label: 'SERVED'  },
  sms:    { bg: 'rgba(6,182,212,0.1)',    color: C.cyan,   label: 'SMS'     },
  iot:    { bg: 'rgba(99,102,241,0.1)',   color: '#a78bfa', label: 'IoT'    },
  break:  { bg: 'rgba(100,116,139,0.12)', color: C.muted,  label: 'BREAK'   },
  skip:   { bg: 'rgba(239,68,68,0.1)',    color: C.red,    label: 'SKIP'    },
  new:    { bg: 'rgba(34,197,94,0.08)',   color: C.green,  label: 'NEW'     },
};

const STATUS_META = {
  called:  { color: C.accent, label: 'Called'  },
  waiting: { color: C.muted,  label: 'Waiting' },
  serving: { color: C.green,  label: 'Serving' },
};

const COUNTER_STATUS_META = {
  active: { color: C.green, label: 'Active' },
  busy:   { color: C.amber, label: 'Busy'   },
  break:  { color: C.muted, label: 'Break'  },
  closed: { color: C.red,   label: 'Closed' },
};

// ─── Shared primitives ────────────────────────────────────────────────────────

function Dot({ color }) {
  return (
    <span className="relative flex h-2 w-2 flex-shrink-0">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-50" style={{ backgroundColor: color }} />
      <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: color }} />
    </span>
  );
}

function Tag({ tag }) {
  const m = TAG_META[tag] ?? TAG_META.done;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-600 tracking-wider"
      style={{ background: m.bg, color: m.color, fontFamily: 'DM Mono, monospace' }}
    >
      {m.label}
    </span>
  );
}

function Pill({ children, color }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-600"
      style={{ background: `${color}14`, color }}
    >
      {children}
    </span>
  );
}

// SVG utilisation ring
function UtilRing({ pct, color, size = 48 }) {
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`${color}18`} strokeWidth={4} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={4}
        strokeDasharray={`${(pct / 100) * circ} ${circ}`}
        strokeLinecap="round"
      />
    </svg>
  );
}

// Custom tooltip for recharts
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-xl px-3 py-2.5 text-xs"
      style={{ background: C.raised, border: `1px solid ${C.border}`, fontFamily: 'DM Mono, monospace', color: C.text }}
    >
      <p className="mb-1" style={{ color: C.muted }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }}>
          {p.name}: <strong>{p.value}</strong>
        </p>
      ))}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

const NAV = [
  { key: 'overview',  label: 'Dashboard',     icon: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  { key: 'queues',    label: 'Queue Monitor', icon: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' },
  { key: 'analytics', label: 'Analytics',     icon: 'M18 20V10M12 20V4M6 20v-6' },
  { key: 'alerts',    label: 'Alerts',        icon: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0', badge: 3 },
];

const NAV_EXTRA = [
  { label: 'Services',      path: '/services',     icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8' },
  { label: 'Operator Desk', path: '/operator',     icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' },
  { label: 'Resource Hub',  path: '/resource-hub', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83-2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' },
];

function Sidebar({ tab, setTab, user, onLogout }) {
  const navigate = useNavigate();

  return (
    <aside
      className="flex flex-col h-screen w-[220px] flex-shrink-0 sticky top-0"
      style={{ background: C.surface, borderRight: `1px solid ${C.border}` }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5" style={{ borderBottom: `1px solid ${C.border}` }}>
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: C.accentD }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#070c09" strokeWidth="2.5">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </div>
        <div>
          <p className="font-700 text-[13px] leading-none" style={{ color: C.text }}>QueueMaster</p>
          <p className="text-[10px] mt-0.5" style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}>v2.4.1 · ADMIN</p>
        </div>
      </div>

      {/* Branch selector */}
      <div className="px-4 py-3" style={{ borderBottom: `1px solid ${C.border}` }}>
        <div
          className="flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors hover:bg-white/5"
          style={{ background: C.raised }}
        >
          <div>
            <p className="text-[11px] font-600" style={{ color: C.text }}>City Hall — Branch 01</p>
            <p className="text-[10px]" style={{ color: C.muted }}>Ahmedabad · Zone A</p>
          </div>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      {/* Primary nav */}
      <nav className="flex-1 px-3 py-4 flex flex-col gap-0.5">
        <p className="px-3 mb-2 text-[10px] font-600 tracking-widest" style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}>
          MAIN
        </p>
        {NAV.map((n) => {
          const active = tab === n.key;
          return (
            <button
              key={n.key}
              onClick={() => setTab(n.key)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-500 w-full text-left transition-all"
              style={{ background: active ? `${C.accentD}18` : 'transparent', color: active ? C.accent : C.muted }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d={n.icon} />
              </svg>
              <span className="flex-1">{n.label}</span>
              {n.badge && (
                <span className="text-[10px] font-700 px-1.5 py-0.5 rounded-full" style={{ background: C.red, color: '#fff' }}>
                  {n.badge}
                </span>
              )}
            </button>
          );
        })}

        <p className="px-3 mt-4 mb-2 text-[10px] font-600 tracking-widest" style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}>
          OTHER
        </p>
        {NAV_EXTRA.map((n) => (
          <button
            key={n.label}
            onClick={() => navigate(n.path)}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-500 w-full text-left transition-all hover:bg-white/5"
            style={{ color: C.muted }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d={n.icon} />
            </svg>
            {n.label}
          </button>
        ))}
      </nav>

      {/* Operator Footer */}
      <div className="px-4 py-4" style={{ borderTop: `1px solid ${C.border}` }}>
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-700 flex-shrink-0"
            style={{ background: 'linear-gradient(135deg,#00c96e,#00ff87)', color: '#070c09' }}
          >
            {(user?.name || 'Sarah Mehta').substring(0, 2).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-600 leading-none truncate" style={{ color: C.text }}>
              {user?.name || 'Sarah Mehta'}
            </p>
            <p className="text-[10px] mt-0.5 truncate" style={{ color: C.muted }}>
              {user?.role || 'Senior Operator'}
            </p>
          </div>
          {onLogout && (
            <button
              onClick={onLogout}
              className="p-1 hover:bg-white/10 rounded-lg transition-colors"
              title="Sign Out"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.8">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({ tab, user, crowdCount = 247 }) {
  const titles = {
    overview:  'Dashboard',
    queues:    'Queue Monitor',
    analytics: 'Analytics',
    alerts:    'Alerts & Actions',
  };

  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const iv = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);

  const fmt = (n) => n.toString().padStart(2, '0');

  return (
    <header
      className="flex items-center gap-4 px-8 py-4 sticky top-0 z-30"
      style={{ background: `${C.bg}e8`, backdropFilter: 'blur(12px)', borderBottom: `1px solid ${C.border}` }}
    >
      <div className="flex-1">
        <h1 className="text-lg font-700 leading-none" style={{ color: C.text }}>{titles[tab]}</h1>
        <p className="text-[12px] mt-0.5" style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}>
          Thu 24 Sep 2026 · {fmt(time.getHours())}:{fmt(time.getMinutes())}:{fmt(time.getSeconds())}
        </p>
      </div>

      {/* Search */}
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-xl w-52"
        style={{ background: C.surface, border: `1px solid ${C.border}` }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          placeholder="Search tokens, visitors…"
          className="flex-1 bg-transparent text-[12px] outline-none"
          style={{ color: C.text }}
        />
        <kbd className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: C.raised, color: C.muted, fontFamily: 'DM Mono,monospace' }}>
          ⌘K
        </kbd>
      </div>

      {/* IoT live badge */}
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-xl"
        style={{ background: `${C.cyan}0d`, border: `1px solid ${C.cyan}25` }}
      >
        <Dot color={C.cyan} />
        <span className="text-[11px] font-600" style={{ color: C.cyan, fontFamily: 'DM Mono,monospace' }}>IoT LIVE</span>
        <span className="text-[12px] font-700" style={{ color: C.text }}>{crowdCount}</span>
        <span className="text-[11px]" style={{ color: C.muted }}>in premises</span>
      </div>

      {/* Notif */}
      <button
        className="relative w-9 h-9 rounded-xl flex items-center justify-center transition-colors hover:bg-white/5"
        style={{ background: C.surface, border: `1px solid ${C.border}` }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.8">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full" style={{ background: C.red }} />
      </button>

      {/* Avatar */}
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center text-[11px] font-700 cursor-pointer"
        style={{ background: 'linear-gradient(135deg,#00c96e,#00ff87)', color: '#070c09' }}
      >
        {(user?.name || 'Sarah Mehta').substring(0, 2).toUpperCase()}
      </div>
    </header>
  );
}

// ─── KPI strip ────────────────────────────────────────────────────────────────

const KPIS = [
  { label: 'Total Waiting',   value: '23',  sub: '+3 in last 10m', trend: 'up',   icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', color: C.accent },
  { label: 'Served Today',    value: '143', sub: '↑18% vs yesterday', trend: 'up', icon: 'M22 11.08V12a10 10 0 1 1-5.93-9.14', color: C.green  },
  { label: 'Avg Wait Time',   value: '14m', sub: '↑2m vs last hour',  trend: 'dn', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10', color: C.amber  },
  { label: 'Active Counters', value: '3/6', sub: '2 on break, 1 closed', trend: '', icon: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', color: C.cyan   },
  { label: 'Tokens Issued',   value: '166', sub: 'Since 8:00 AM', trend: '',     icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', color: '#a78bfa' },
  { label: 'No-Shows',        value: '4',   sub: '2.4% of issued',    trend: '', icon: 'M10 3H6a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h4M16 17l5-5-5-5M21 12H9', color: C.red },
];

function KpiStrip() {
  return (
    <div className="grid grid-cols-6 gap-4 px-8 py-6">
      {KPIS.map((k) => (
        <div
          key={k.label}
          className="rounded-2xl p-4 flex flex-col gap-3 transition-all hover:border-white/10"
          style={{ background: C.surface, border: `1px solid ${C.border}` }}
        >
          <div className="flex items-center justify-between">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: `${k.color}14` }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={k.color} strokeWidth="1.8" strokeLinecap="round">
                <path d={k.icon} />
              </svg>
            </div>
            {k.trend && (
              <span className="text-[10px] font-600" style={{ color: k.trend === 'up' ? C.green : C.red }}>
                {k.trend === 'up' ? '▲' : '▼'}
              </span>
            )}
          </div>
          <div>
            <p className="text-2xl font-700 leading-none" style={{ color: C.text, fontFamily: 'DM Mono,monospace' }}>
              {k.value}
            </p>
            <p className="text-[11px] font-500 mt-1" style={{ color: k.color }}>{k.label}</p>
            <p className="text-[10px] mt-0.5" style={{ color: C.muted }}>{k.sub}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({ onGoToQueues }) {
  return (
    <div className="px-8 pb-10 flex flex-col gap-6">
      {/* Charts row */}
      <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 340px' }}>
        {/* Footfall area chart */}
        <div className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
          <div className="flex items-start justify-between mb-5">
            <div>
              <h3 className="font-600 text-sm" style={{ color: C.text }}>Live Footfall</h3>
              <p className="text-[11px] mt-0.5" style={{ color: C.muted }}>Actual visitors + ML-predicted through 6 PM</p>
            </div>
            <div className="flex items-center gap-3 text-[10px]" style={{ fontFamily: 'DM Mono,monospace', color: C.muted }}>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-4 h-0.5" style={{ background: C.accent }} /> Actual
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-4 h-0.5 border-t border-dashed" style={{ borderColor: C.accent }} /> Predicted
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={FOOTFALL_DATA} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="fg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.accent} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={C.accent} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.accent} stopOpacity={0.08} />
                  <stop offset="95%" stopColor={C.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="t" tick={{ fontSize: 10, fill: C.muted, fontFamily: 'DM Mono,monospace' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: C.muted, fontFamily: 'DM Mono,monospace' }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="actual" name="Actual" stroke={C.accent} fill="url(#fg)" strokeWidth={2} dot={false} connectNulls={false} />
              <Area type="monotone" dataKey="predicted" name="Predicted" stroke={C.accent} fill="url(#pg)" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Service demand donut */}
        <div className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
          <h3 className="font-600 text-sm mb-1" style={{ color: C.text }}>Service Demand</h3>
          <p className="text-[11px] mb-4" style={{ color: C.muted }}>Token distribution today</p>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie data={SERVICE_DEMAND} dataKey="value" cx="50%" cy="50%" outerRadius={68} innerRadius={42} paddingAngle={3}>
                {SERVICE_DEMAND.map((d, i) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v) => `${v}%`}
                contentStyle={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 11, color: C.text }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-col gap-1.5 mt-2">
            {SERVICE_DEMAND.map((d) => (
              <div key={d.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: d.color }} />
                  <span className="text-[11px]" style={{ color: C.muted }}>{d.name}</span>
                </div>
                <span className="text-[11px] font-600" style={{ color: C.text, fontFamily: 'DM Mono,monospace' }}>{d.value}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Counter cards */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-600 text-sm" style={{ color: C.text }}>Counter Status</h3>
          <button
            onClick={onGoToQueues}
            className="text-[12px] font-600 transition-colors hover:opacity-80"
            style={{ color: C.accent }}
          >
            Manage Counters →
          </button>
        </div>
        <div className="grid grid-cols-6 gap-4">
          {COUNTERS_DATA.map((c) => {
            const sm = COUNTER_STATUS_META[c.status];
            return (
              <div
                key={c.id}
                className="rounded-2xl p-4 flex flex-col gap-3 transition-all hover:border-white/10"
                style={{ background: C.surface, border: `1px solid ${C.border}` }}
              >
                <div className="flex items-center justify-between">
                  <div
                    className="w-8 h-8 rounded-xl flex items-center justify-center font-800 text-sm"
                    style={{ background: `${sm.color}15`, color: sm.color, fontFamily: 'DM Mono,monospace' }}
                  >
                    {c.id}
                  </div>
                  <div style={{ position: 'relative' }}>
                    <UtilRing pct={c.util} color={c.util > 80 ? C.amber : c.util > 50 ? C.accent : C.green} size={36} />
                    <span
                      className="absolute inset-0 flex items-center justify-center text-[8px] font-700"
                      style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}
                    >
                      {c.util}%
                    </span>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] mb-0.5" style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}>SERVING</p>
                  <p className="font-700 text-base leading-none" style={{ color: C.text, fontFamily: 'DM Mono,monospace' }}>{c.serving}</p>
                </div>
                <div className="flex items-center justify-between">
                  <Pill color={sm.color}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', display: 'inline-block', background: sm.color }} />
                    {sm.label}
                  </Pill>
                  <span className="text-[11px] font-600" style={{ color: C.muted }}>{c.waiting}▸</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom row */}
      <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 320px' }}>
        {/* Avg wait line chart */}
        <div className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
          <h3 className="font-600 text-sm mb-1" style={{ color: C.text }}>Avg Wait Time Trend</h3>
          <p className="text-[11px] mb-4" style={{ color: C.muted }}>Minutes per hour — all counters combined</p>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={AVG_WAIT_DATA} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <XAxis dataKey="t" tick={{ fontSize: 10, fill: C.muted, fontFamily: 'DM Mono,monospace' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: C.muted, fontFamily: 'DM Mono,monospace' }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Line type="monotone" dataKey="wait" name="Avg Wait (min)" stroke={C.amber} strokeWidth={2} dot={{ fill: C.amber, r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Activity log */}
        <div className="rounded-2xl p-5 flex flex-col" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-600 text-sm" style={{ color: C.text }}>Live Activity</h3>
            <Dot color={C.green} />
          </div>
          <div className="flex-1 flex flex-col gap-2.5 overflow-y-auto" style={{ maxHeight: '150px' }}>
            {ACTIVITY_LOG.map((a, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className="text-[10px] flex-shrink-0 mt-0.5" style={{ color: C.muted, fontFamily: 'DM Mono,monospace', width: 36 }}>{a.time}</span>
                <Tag tag={a.tag} />
                <span className="text-[12px] leading-snug" style={{ color: C.muted }}>{a.event}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Queue monitor tab ────────────────────────────────────────────────────────

function QueuesTab() {
  const [filter, setFilter] = useState('all');
  const [tableData, setTableData] = useState(QUEUE_TABLE);
  const [broadcastSent, setBroadcastSent] = useState(false);

  const filtered = filter === 'all' ? tableData : tableData.filter((q) => q.status === filter);

  const handleCall = (token) => {
    setTableData((prev) =>
      prev.map((item) => (item.token === token ? { ...item, status: 'called' } : item))
    );
  };

  const handleSkip = (token) => {
    setTableData((prev) => prev.filter((item) => item.token !== token));
  };

  const handleBroadcast = () => {
    setBroadcastSent(true);
    setTimeout(() => setBroadcastSent(false), 2500);
  };

  return (
    <div className="px-8 pb-10 flex flex-col gap-6">
      {/* Filter + actions */}
      <div className="flex items-center gap-3">
        {['all', 'waiting', 'called', 'serving'].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="px-3 py-1.5 rounded-lg text-[12px] font-600 capitalize transition-all"
            style={{
              background: filter === f ? `${C.accentD}20` : C.surface,
              color: filter === f ? C.accent : C.muted,
              border: `1px solid ${filter === f ? C.accentD + '40' : C.border}`,
            }}
          >
            {f === 'all' ? `All (${tableData.length})` : f}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={handleBroadcast}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-600 transition-all hover:opacity-80"
          style={{ background: broadcastSent ? C.green : C.accentD, color: '#070c09' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {broadcastSent ? '✓ Broadcast Dispatched!' : 'Broadcast SMS'}
        </button>
      </div>

      {/* Table */}
      <div className="rounded-2xl overflow-hidden" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {['Token', 'Visitor Name', 'Service', 'Issued', 'Wait (min)', 'Counter', 'Status', 'Actions'].map((h) => (
                <th
                  key={h}
                  className="px-5 py-3.5 text-left text-[10px] font-600 tracking-widest"
                  style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((q, i) => {
              const sm = STATUS_META[q.status] || STATUS_META.waiting;
              return (
                <tr
                  key={q.token}
                  className="transition-colors hover:bg-white/[0.02]"
                  style={{ borderBottom: i < filtered.length - 1 ? `1px solid ${C.border}` : 'none' }}
                >
                  <td className="px-5 py-3.5">
                    <span className="font-700 text-[13px]" style={{ color: C.text, fontFamily: 'DM Mono,monospace' }}>
                      {q.token}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-[13px]" style={{ color: C.text }}>{q.name}</td>
                  <td className="px-5 py-3.5 text-[12px]" style={{ color: C.muted }}>{q.service}</td>
                  <td className="px-5 py-3.5 text-[12px]" style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}>{q.time}</td>
                  <td className="px-5 py-3.5">
                    <span
                      className="font-700 text-[13px]"
                      style={{ color: q.wait > 25 ? C.red : q.wait > 15 ? C.amber : C.green, fontFamily: 'DM Mono,monospace' }}
                    >
                      {q.wait}m
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span
                      className="w-7 h-7 inline-flex items-center justify-center rounded-lg text-[11px] font-700"
                      style={{ background: `${C.accent}15`, color: C.accent, fontFamily: 'DM Mono,monospace' }}
                    >
                      {q.counter}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <Pill color={sm.color}>{sm.label}</Pill>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleCall(q.token)}
                        className="text-[11px] font-600 px-2.5 py-1 rounded-lg transition-colors hover:opacity-80"
                        style={{ background: `${C.accentD}18`, color: C.accent }}
                      >
                        Call
                      </button>
                      <button
                        onClick={() => handleSkip(q.token)}
                        className="text-[11px] font-600 px-2.5 py-1 rounded-lg transition-colors hover:opacity-80"
                        style={{ background: `${C.red}12`, color: C.red }}
                      >
                        Skip
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Counter utilisation bars */}
      <div className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
        <h3 className="font-600 text-sm mb-4" style={{ color: C.text }}>Counter Utilisation & Load</h3>
        <div className="grid grid-cols-6 gap-4">
          {COUNTERS_DATA.map((c) => {
            const barColor = c.util > 80 ? C.amber : c.util > 50 ? C.accent : C.green;
            return (
              <div key={c.id} className="flex flex-col gap-2">
                <div className="flex items-end justify-between">
                  <span className="font-700 text-[12px]" style={{ color: C.text, fontFamily: 'DM Mono,monospace' }}>
                    Ctr {c.id}
                  </span>
                  <span className="text-[10px]" style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}>{c.util}%</span>
                </div>
                <div className="w-full rounded-full overflow-hidden" style={{ height: 6, background: C.raised }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${c.util}%`, background: barColor }} />
                </div>
                <div className="flex items-center justify-between text-[10px]" style={{ color: C.muted }}>
                  <span>{c.waiting} ▸</span>
                  <span>{c.served} done</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Analytics tab ────────────────────────────────────────────────────────────

const DAILY_FOOTFALL = [
  { day: 'Mon', count: 312 },
  { day: 'Tue', count: 278 },
  { day: 'Wed', count: 401 },
  { day: 'Thu', count: 247, active: true },
  { day: 'Fri', count: null, predicted: 380 },
  { day: 'Sat', count: null, predicted: 290 },
  { day: 'Sun', count: null, predicted: 120 },
];

const HOURLY_AVG = [
  { h: '8A', wait: 5 },
  { h: '9A', wait: 9 },
  { h: '10A', wait: 16 },
  { h: '11A', wait: 19 },
  { h: '12P', wait: 12 },
  { h: '1P', wait: 7 },
  { h: '2P', wait: 11 },
  { h: '3P', wait: 17 },
  { h: '4P', wait: 21 },
  { h: '5P', wait: 14 },
];

function AnalyticsTab() {
  return (
    <div className="px-8 pb-10 flex flex-col gap-6">
      {/* Summary numbers */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Tokens issued this week', value: '1,024', delta: '+12%' },
          { label: 'Avg daily footfall',      value: '312',   delta: '+8%'  },
          { label: 'Overall avg wait',        value: '13m',   delta: '-4%'  },
          { label: 'No-show rate',            value: '2.4%',  delta: '-0.3%' },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
            <p className="text-[11px] mb-2" style={{ color: C.muted }}>{s.label}</p>
            <div className="flex items-end gap-2">
              <p className="text-3xl font-700" style={{ color: C.text, fontFamily: 'DM Mono,monospace' }}>{s.value}</p>
              <p
                className="text-[11px] font-600 mb-0.5"
                style={{ color: s.delta.startsWith('-') && s.label !== 'No-show rate' ? C.red : C.green }}
              >
                {s.delta}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Weekly footfall bar */}
      <div className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="font-600 text-sm" style={{ color: C.text }}>Weekly Footfall</h3>
            <p className="text-[11px] mt-0.5" style={{ color: C.muted }}>Mon–Sun this week · Fri–Sun predicted</p>
          </div>
          <div className="flex items-center gap-3 text-[10px]" style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm inline-block" style={{ background: C.accent }} /> Actual
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm inline-block" style={{ background: `${C.accent}40` }} /> Predicted
            </span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={DAILY_FOOTFALL} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
            <XAxis dataKey="day" tick={{ fontSize: 11, fill: C.muted, fontFamily: 'DM Mono,monospace' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: C.muted, fontFamily: 'DM Mono,monospace' }} axisLine={false} tickLine={false} />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="count" name="Visitors" radius={[6, 6, 0, 0]}>
              {DAILY_FOOTFALL.map((d, i) => (
                <Cell key={i} fill={d.active ? C.accent : `${C.accent}70`} />
              ))}
            </Bar>
            <Bar dataKey="predicted" name="Predicted" radius={[6, 6, 0, 0]}>
              {DAILY_FOOTFALL.map((_, i) => (
                <Cell key={i} fill={`${C.accent}35`} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {/* Hourly avg wait */}
        <div className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
          <h3 className="font-600 text-sm mb-1" style={{ color: C.text }}>Hourly Avg Wait (min)</h3>
          <p className="text-[11px] mb-4" style={{ color: C.muted }}>Historical pattern — all service types</p>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={HOURLY_AVG} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <XAxis dataKey="h" tick={{ fontSize: 10, fill: C.muted, fontFamily: 'DM Mono,monospace' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: C.muted, fontFamily: 'DM Mono,monospace' }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="wait" name="Avg Wait" radius={[4, 4, 0, 0]}>
                {HOURLY_AVG.map((d, i) => (
                  <Cell key={i} fill={d.wait > 18 ? C.red : d.wait > 13 ? C.amber : C.green} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Counter performance table */}
        <div className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
          <h3 className="font-600 text-sm mb-4" style={{ color: C.text }}>Counter Performance</h3>
          <div className="flex flex-col gap-0">
            <div className="grid grid-cols-4 pb-2 mb-1" style={{ borderBottom: `1px solid ${C.border}` }}>
              {['Counter', 'Served', 'Avg Wait', 'Util'].map((h) => (
                <span key={h} className="text-[10px] font-600 tracking-widest" style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}>
                  {h}
                </span>
              ))}
            </div>
            {COUNTERS_DATA.map((c) => {
              const avgW = c.status === 'break' || c.status === 'closed' ? '—' : `${7 + Math.round(c.util / 12)}m`;
              const utilC = c.util > 80 ? C.amber : c.util > 50 ? C.accent : C.green;
              return (
                <div key={c.id} className="grid grid-cols-4 py-2.5" style={{ borderBottom: `1px solid ${C.border}` }}>
                  <span className="font-700 text-[12px]" style={{ color: C.text, fontFamily: 'DM Mono,monospace' }}>Ctr {c.id}</span>
                  <span className="text-[12px]" style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}>{c.served}</span>
                  <span className="text-[12px]" style={{ color: C.muted, fontFamily: 'DM Mono,monospace' }}>{avgW}</span>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: C.raised }}>
                      <div className="h-full rounded-full" style={{ width: `${c.util}%`, background: utilC }} />
                    </div>
                    <span className="text-[10px] font-600" style={{ color: utilC, fontFamily: 'DM Mono,monospace' }}>{c.util}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Alerts tab ───────────────────────────────────────────────────────────────

const ALERT_META = {
  warn: { color: C.amber, bg: `${C.amber}12`, border: `${C.amber}30`, label: 'WARNING' },
  info: { color: C.cyan,  bg: `${C.cyan}10`,  border: `${C.cyan}28`,  label: 'INFO'    },
  ok:   { color: C.green, bg: `${C.green}10`, border: `${C.green}28`, label: 'SUGGEST' },
  skip: { color: C.red,   bg: `${C.red}10`,   border: `${C.red}28`,   label: 'ACTION'  },
};

const RESOURCE_PLAN = [
  { time: 'Now — 3 PM',  counters: 3, note: 'Current demand adequate',        status: 'ok' },
  { time: '3 PM — 4 PM', counters: 5, note: 'Spike expected — open Ctr E, F', status: 'warn' },
  { time: '4 PM — 5 PM', counters: 4, note: 'Demand normalising',             status: 'ok' },
  { time: '5 PM — 6 PM', counters: 2, note: 'Wind-down; release 2 operators', status: 'ok' },
];

function AlertsTab() {
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const [dismissedIndices, setDismissedIndices] = useState([]);

  function send() {
    if (!message.trim()) return;
    setSent(true);
    setTimeout(() => setSent(false), 3000);
  }

  const activeAlerts = ALERTS.filter((_, idx) => !dismissedIndices.includes(idx));

  return (
    <div className="px-8 pb-10 flex flex-col gap-6">
      {/* Alert summary bar */}
      <div
        className="flex items-center gap-4 px-5 py-4 rounded-2xl"
        style={{ background: `${C.amber}0c`, border: `1px solid ${C.amber}28` }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.amber} strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <p className="font-600 text-sm" style={{ color: C.amber }}>
          {activeAlerts.length} items require attention
        </p>
        <span className="text-[12px]" style={{ color: C.muted }}>Based on IoT sensor data + ML predictions as of 09:41 AM</span>
      </div>

      <div className="grid gap-6" style={{ gridTemplateColumns: '1fr 340px' }}>
        {/* Alert cards */}
        <div className="flex flex-col gap-4">
          <h3 className="font-600 text-sm" style={{ color: C.text }}>AI-Driven Recommendations</h3>
          {activeAlerts.length === 0 ? (
            <div
              className="rounded-2xl p-6 text-center"
              style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.muted }}
            >
              All active alerts have been addressed or dismissed.
            </div>
          ) : (
            activeAlerts.map((a, i) => {
              const m = ALERT_META[a.type] || ALERT_META.info;
              return (
                <div key={i} className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${m.border}` }}>
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="text-[9px] font-700 px-2 py-0.5 rounded tracking-widest"
                        style={{ background: m.bg, color: m.color, fontFamily: 'DM Mono,monospace' }}
                      >
                        {m.label}
                      </span>
                      <span className="text-[11px]" style={{ color: C.muted }}>{a.time}</span>
                    </div>
                    <Dot color={m.color} />
                  </div>
                  <h4 className="font-700 text-[13px] mb-1.5" style={{ color: C.text }}>{a.title}</h4>
                  <p className="text-[12px] leading-relaxed mb-4" style={{ color: C.muted }}>{a.desc}</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setDismissedIndices((prev) => [...prev, i])}
                      className="flex-1 py-2 rounded-xl text-[12px] font-600 transition-all hover:opacity-80 active:scale-[0.98]"
                      style={{ background: m.bg, color: m.color, border: `1px solid ${m.border}` }}
                    >
                      Take Action
                    </button>
                    <button
                      onClick={() => setDismissedIndices((prev) => [...prev, i])}
                      className="px-4 py-2 rounded-xl text-[12px] font-600 transition-all hover:bg-white/5"
                      style={{ color: C.muted, border: `1px solid ${C.border}` }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-4">
          {/* Resource allocation */}
          <div className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
            <h3 className="font-600 text-sm mb-4" style={{ color: C.text }}>Recommended Counter Config</h3>
            {RESOURCE_PLAN.map((r) => (
              <div key={r.time} className="flex items-start gap-3 py-3" style={{ borderBottom: `1px solid ${C.border}` }}>
                <div
                  className="w-2 h-2 rounded-full mt-1 flex-shrink-0"
                  style={{ background: r.status === 'warn' ? C.amber : C.green }}
                />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <p className="text-[12px] font-600" style={{ color: C.text }}>{r.time}</p>
                    <span className="font-700 text-[12px]" style={{ color: C.accent, fontFamily: 'DM Mono,monospace' }}>
                      {r.counters} ctr
                    </span>
                  </div>
                  <p className="text-[11px] mt-0.5" style={{ color: C.muted }}>{r.note}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Broadcast panel */}
          <div className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-600 text-sm" style={{ color: C.text }}>Broadcast Message</h3>
              <span
                className="text-[10px] font-600 px-2 py-0.5 rounded"
                style={{ background: `${C.green}12`, color: C.green, fontFamily: 'DM Mono,monospace' }}
              >
                SMS + APP
              </span>
            </div>
            <p className="text-[11px] mb-4" style={{ color: C.muted }}>Notify all currently queued visitors</p>
            <textarea
              rows={4}
              placeholder="e.g. Counter B is temporarily closed. Please move to Counter A. We apologise for the inconvenience."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full rounded-xl px-3.5 py-3 text-[12px] outline-none resize-none transition-all"
              style={{ background: C.raised, border: `1px solid ${C.border}`, color: C.text, caretColor: C.accent }}
            />
            <div className="flex items-center justify-between mt-3">
              <span className="text-[10px]" style={{ color: C.muted }}>{message.length}/160 chars</span>
              <button
                onClick={send}
                className="px-5 py-2 rounded-xl text-[12px] font-700 transition-all hover:opacity-90 active:scale-[0.98]"
                style={{ background: sent ? C.green : C.accentD, color: '#070c09' }}
              >
                {sent ? '✓ Sent!' : 'Send to 23 visitors'}
              </button>
            </div>
          </div>

          {/* SLA summary */}
          <div className="rounded-2xl p-5" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
            <h3 className="font-600 text-sm mb-4" style={{ color: C.text }}>SLA Compliance</h3>
            {[
              { label: 'Within 15m target', pct: 68, color: C.amber },
              { label: 'Within 20m target', pct: 84, color: C.accent },
              { label: 'Within 30m target', pct: 97, color: C.green  },
            ].map((s) => (
              <div key={s.label} className="flex flex-col gap-1.5 mb-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px]" style={{ color: C.muted }}>{s.label}</span>
                  <span className="text-[11px] font-700" style={{ color: s.color, fontFamily: 'DM Mono,monospace' }}>
                    {s.pct}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: C.raised }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${s.pct}%`, background: s.color }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function WebDashboard({ initialTab = 'overview' }) {
  const [tab, setTab] = useState(initialTab);
  const { user, logout } = useAuth();
  const { activeCenterId } = useSocket();
  const { crowdData } = useCrowd(activeCenterId);

  const crowdCount = crowdData?.currentCrowd ?? 247;

  return (
    <div
      className="flex w-full min-h-screen"
      style={{
        background: C.bg,
        fontFamily: 'DM Sans,Outfit,sans-serif',
        color: C.text,
      }}
    >
      <Sidebar
        tab={tab}
        setTab={setTab}
        user={user}
        onLogout={logout}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <Header
          tab={tab}
          user={user}
          crowdCount={crowdCount}
        />
        <KpiStrip />
        <div style={{ borderTop: `1px solid ${C.border}` }}>
          {tab === 'overview'   && <OverviewTab onGoToQueues={() => setTab('queues')} />}
          {tab === 'queues'     && <QueuesTab />}
          {tab === 'analytics'  && <AnalyticsTab />}
          {tab === 'alerts'     && <AlertsTab />}
        </div>
      </div>
    </div>
  );
}
