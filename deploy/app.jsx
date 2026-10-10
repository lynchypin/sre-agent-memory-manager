const { useState, useEffect, useCallback, useRef } = React;

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  bg:         "#0D1B2A",
  bgCard:     "#112233",
  bgElevated: "#162840",
  bgInput:    "#0A1520",
  border:     "#1E3450",
  borderHover:"#2A4A6E",
  green:      "#06AC38",
  greenDim:   "#047A28",
  greenGlow:  "rgba(6,172,56,0.18)",
  amber:      "#F5A623",
  amberDim:   "rgba(245,166,35,0.15)",
  red:        "#E5534B",
  redDim:     "rgba(229,83,75,0.15)",
  textPrimary:"#E8EFF8",
  textSecondary:"#8B9BB4",
  textDim:    "#4A6080",
  purple:     "#7C5CBF",
  purpleDim:  "rgba(124,92,191,0.15)",
  cyan:       "#38BDF8",
  cyanDim:    "rgba(56,189,248,0.12)",
  orange:     "#F2784B",
  orangeDim:  "rgba(242,120,75,0.15)",
};

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function Tooltip({ text, children }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = useRef(null);

  const show = () => {
    if (ref.current) {
      const r = ref.current.getBoundingClientRect();
      setPos({ top: r.bottom + 8, left: r.left + r.width / 2 });
    }
    setVisible(true);
  };

  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={() => setVisible(false)}
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
    >
      {children}
      {visible && (
        <span style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          transform: "translateX(-50%)",
          background: "#1E3450",
          color: T.textPrimary,
          fontSize: 12,
          lineHeight: 1.5,
          padding: "6px 10px",
          borderRadius: 6,
          border: `1px solid ${T.border}`,
          maxWidth: 280,
          zIndex: 9999,
          pointerEvents: "none",
          boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
          whiteSpace: "normal",
          textAlign: "center",
        }}>
          {text}
        </span>
      )}
    </span>
  );
}

function InfoIcon({ tip }) {
  return (
    <Tooltip text={tip}>
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 15, height: 15, borderRadius: "50%",
        border: `1px solid ${T.textDim}`,
        color: T.textDim, fontSize: 9, fontWeight: 700,
        marginLeft: 5, cursor: "help", flexShrink: 0,
        userSelect: "none",
      }}>i</span>
    </Tooltip>
  );
}

// ─── Memory type metadata (CONFIRMED against real API: attributes.type) ──────
const MEMORY_META = {
  service_profile: {
    label: "Service Knowledge",
    color: T.cyan,
    dimColor: T.cyanDim,
    icon: "◈",
    tip: "Stable facts the SRE Agent has learned about this service over time — its tech stack, deployment patterns, common dependencies, and where its logs live. Used to give the agent immediate context when a new incident opens.",
  },
  incident_summary: {
    label: "Past Incident Memory",
    color: T.purple,
    dimColor: T.purpleDim,
    icon: "◎",
    tip: "A narrative summary of a specific past incident on this service — what happened, what the agent suggested, and how it was resolved. The agent pulls these when a new incident resembles a past one.",
  },
  playbook: {
    label: "Playbook",
    color: T.green,
    dimColor: T.greenGlow,
    icon: "◉",
    tip: "A confirmed root cause and step-by-step resolution procedure built from a past incident. The agent automatically recalls a matching playbook when a new incident fits the same pattern.",
  },
  runbook: {
    label: "Runbook",
    color: T.orange,
    dimColor: T.orangeDim,
    icon: "▣",
    tip: "A lightweight, reusable reference — typically log queries, dashboard links, or label selectors — that helps investigate this service quickly without the full detail of a playbook.",
  },
};

// Fallback for any type value not in the table above. Never hide unknown types.
function metaFor(type) {
  if (MEMORY_META[type]) return MEMORY_META[type];
  const label = (type || "unknown")
    .split("_")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return {
    label, color: T.textSecondary, dimColor: T.bgElevated, icon: "○",
    tip: "A memory type not yet recognized by this tool. Shown as-is using PagerDuty's raw label so nothing is hidden.",
  };
}

// ─── Content-shape sniffing fallback ──────────────────────────────────────────
// Only used if attributes.type is ever completely missing from the API response.
// Real API confirmed to always include attributes.type, but this keeps the tool
// resilient instead of silently dropping a memory into an "unknown" bucket.
function sniffType(content) {
  if (!content) return null;
  const head = content.slice(0, 60);
  if (/^####?\s*Service Profile/i.test(head)) return "service_profile";
  if (/^##\s*Incident Summary/i.test(head)) return "playbook_or_incident"; // ambiguous, refined below
  if (/^####?\s*Playbook/i.test(head)) return "playbook";
  if (/Root Cause:/i.test(content.slice(0, 200)) && /Investigation Steps/i.test(content)) return "playbook";
  if (/^##\s*Incident Summary/i.test(head)) return "incident_summary";
  if (/Log Queries|Label Selectors/i.test(content) && content.length < 600) return "runbook";
  return null;
}

// ─── Metadata footer parsing ───────────────────────────────────────────────────
// Real content strings end with one or more stacked footer blocks like:
//   ---
//   _Metadata: Updated <iso> | Version <x> | Based on <n> incident(s) and service runbook_
//   ---
//   _Metadata: Updated <iso> | Considered <iso> | Version <n> | Based on <n> incidents_
// These are part of the content string itself, not separate API fields.
// We strip them from the rendered body and parse the LAST (most recent) one
// into structured fields shown separately in the UI.
const FOOTER_BLOCK_RE = /\n?---\n_Metadata:\s*([^_]+)_\s*/g;

function extractFooters(rawContent) {
  if (!rawContent) return { body: "", footers: [] };
  const footers = [];
  let match;
  const re = new RegExp(FOOTER_BLOCK_RE);
  while ((match = re.exec(rawContent)) !== null) {
    footers.push(match[1].trim());
  }
  const body = rawContent.replace(FOOTER_BLOCK_RE, "").trim();
  return { body, footers };
}

function parseFooterFields(footerStr) {
  // Footer is a " | " separated list of "Label <value>" or "Label: <value>" fragments
  if (!footerStr) return {};
  const out = {};
  footerStr.split("|").map(s => s.trim()).forEach(part => {
    const updatedMatch = part.match(/^Updated\s+(.+)$/i);
    const consideredMatch = part.match(/^Considered\s+(.+)$/i);
    const versionMatch = part.match(/^Version\s+(.+)$/i);
    const basedOnMatch = part.match(/^Based on\s+(.+)$/i);
    if (updatedMatch) out.updated = updatedMatch[1];
    else if (consideredMatch) out.considered = consideredMatch[1];
    else if (versionMatch) out.version = versionMatch[1];
    else if (basedOnMatch) out.basedOn = basedOnMatch[1];
  });
  return out;
}

// ─── Normalize a raw API memory object into the shape the UI uses ────────────
function normalizeMemory(raw) {
  const attrs = raw.attributes || {};
  const rawType = attrs.type || sniffType(raw.content) || "unknown";
  const { body, footers } = extractFooters(raw.content || "");
  const lastFooter = footers.length ? parseFooterFields(footers[footers.length - 1]) : {};

  return {
    id: raw.id,
    type: rawType,
    serviceId: attrs.service_id ?? null,
    accountId: attrs.account_id ?? null,
    incidentId: attrs.incident_id ?? null,
    rawContent: raw.content ?? "",
    body,
    footerMeta: lastFooter,
    footerCount: footers.length,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
  };
}

// ─── Badge ────────────────────────────────────────────────────────────────────
function TypeBadge({ type }) {
  const m = metaFor(type);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 99,
      background: m.dimColor, color: m.color,
      fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
      border: `1px solid ${m.color}33`,
      whiteSpace: "nowrap",
    }}>
      <span style={{ fontSize: 9 }}>{m.icon}</span>
      {m.label}
      <InfoIcon tip={m.tip} />
    </span>
  );
}

// ─── Button ───────────────────────────────────────────────────────────────────
function Btn({ onClick, variant = "primary", children, disabled, small, danger }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 5,
    padding: small ? "5px 12px" : "8px 16px",
    borderRadius: 7, border: "none", cursor: disabled ? "not-allowed" : "pointer",
    fontSize: small ? 12 : 13, fontWeight: 600,
    transition: "all 0.15s", opacity: disabled ? 0.45 : 1,
    outline: "none", letterSpacing: 0.2,
  };
  const styles = {
    primary: { background: T.green,       color: "#fff" },
    ghost:   { background: "transparent", color: T.textSecondary, border: `1px solid ${T.border}` },
    danger:  { background: T.redDim,      color: T.red,           border: `1px solid ${T.red}44` },
  };
  return (
    <button
      onClick={disabled ? undefined : onClick}
      style={{ ...base, ...(danger ? styles.danger : styles[variant]) }}
    >
      {children}
    </button>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, width = 520 }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, padding: 20,
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: T.bgCard, border: `1px solid ${T.border}`,
        borderRadius: 12, width: "100%", maxWidth: width,
        boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
        animation: "fadeIn 0.15s ease",
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "16px 20px", borderBottom: `1px solid ${T.border}`,
        }}>
          <span style={{ color: T.textPrimary, fontWeight: 700, fontSize: 15 }}>{title}</span>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: T.textDim,
            cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 2,
          }}>✕</button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function Toast({ message, type, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [onDone]);
  const bg = type === "error" ? T.red : type === "warning" ? T.amber : T.green;
  return (
    <div style={{
      position: "fixed", bottom: 24, right: 24, zIndex: 9000,
      background: T.bgElevated, border: `1px solid ${bg}55`,
      borderLeft: `3px solid ${bg}`,
      borderRadius: 8, padding: "12px 16px",
      color: T.textPrimary, fontSize: 13, maxWidth: 340,
      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      animation: "slideUp 0.2s ease",
    }}>
      {message}
    </div>
  );
}

// ─── Markdown renderer (using bundled marked.js, no CDN dependency) ──────────
function Markdown({ text }) {
  const html = window.marked ? window.marked.parse(text || "") : (text || "");
  return (
    <div
      className="md-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ─── Rate-limit tuning ────────────────────────────────────────────────────────
// The sre_agent/memories endpoint rate-limits far more aggressively than
// PagerDuty's normal REST limit — six requests ~1.1s apart were all rejected
// with 429. Retrying is not a nicety here: without it, ordinary sidebar
// clicking is enough to make the tool unusable.
const MAX_RETRIES = 3;      // 4 attempts total
const BACKOFF_BASE_MS = 1000;
const MAX_BACKOFF_MS = 30000; // never let a server-sent Retry-After hang the UI
const MIN_BACKOFF_MS = 500;

// Retry-After may be a number of seconds or an HTTP-date. Returns null when
// absent, unparseable, or non-positive (e.g. "0", blank, or a stale date), so
// the caller falls back to its own growing backoff rather than to a flat
// minimum wait that would never back off at all.
function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const ms = Number.isFinite(Number(trimmed))
    ? Number(trimmed) * 1000
    : new Date(trimmed).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}

// ─── PagerDuty API client ─────────────────────────────────────────────────────
// Dependencies are accepted, not created, so the client is testable without a
// live token: pass fetchImpl/sleep to drive it, onRetry to surface retries.
function makePD(apiKey, { fetchImpl, sleep, onRetry } = {}) {
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));
  const doSleep = sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));

  const headers = {
    "Authorization": `Token token=${apiKey}`,
    "Accept": "application/vnd.pagerduty+json;version=2",
    "Content-Type": "application/json",
  };

  const BASE = "https://api.pagerduty.com";

  async function request(method, path, body) {
    const payload = body ? JSON.stringify(body) : undefined;

    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(`${BASE}${path}`, { method, headers, body: payload });

      // 429: wait and retry rather than failing outright. Honour Retry-After
      // when the server sends one, otherwise back off exponentially.
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const advised = parseRetryAfter(res.headers?.get?.("Retry-After"));
        const fallback = BACKOFF_BASE_MS * Math.pow(2, attempt);
        const delayMs = Math.min(
          Math.max(advised ?? fallback, MIN_BACKOFF_MS),
          MAX_BACKOFF_MS,
        );
        if (onRetry) {
          onRetry({ attempt: attempt + 1, of: MAX_RETRIES, delayMs, method, path });
        }
        await doSleep(delayMs);
        continue;
      }

      if (!res.ok) {
        if (res.status === 429) {
          throw new Error(
            "Rate limited by PagerDuty — the memories API allows very few " +
            "requests in a row. Wait about a minute and try again.",
          );
        }
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
      }
      if (res.status === 204) return {};
      return res.json();
    }
  }

  return {
    getMe: () => request("GET", "/users/me"),

    listServices: (offset = 0) =>
      request("GET", `/services?limit=25&offset=${offset}&sort_by=name`),

    // SRE Agent Memory API ─────────────────────────────────────────────────
    // Confirmed real shape: { limit, memories: [ { attributes: { type, service_id,
    // account_id, incident_id? }, id, content, updated_at, created_at } ] }
    // No cursor/offset pagination field has been observed in real responses,
    // but we defensively check for one anyway in case larger result sets paginate.
    listServiceMemories: (serviceId, offset) =>
      request("GET", `/sre_agent/memories?service_id=${serviceId}${offset ? `&offset=${offset}` : ""}`),

    listIncidentMemories: (incidentId, offset) =>
      request("GET", `/sre_agent/memories?incident_id=${incidentId}${offset ? `&offset=${offset}` : ""}`),

    getMemory: (memoryId) =>
      request("GET", `/sre_agent/memories/${memoryId}`),

    updateMemory: (memoryId, content) =>
      request("PUT", `/sre_agent/memories/${memoryId}`, {
        memory: { content },
      }),

    // Permanent deletion. There is no redact endpoint — the published API
    // exposes only DELETE, which returns 204 and removes the memory outright.
    // A deleted memory simply stops appearing in list responses; there is no
    // redacted state and no way to restore it.
    deleteMemory: (memoryId) =>
      request("DELETE", `/sre_agent/memories/${memoryId}`),
  };
}

// ─── Relative time ────────────────────────────────────────────────────────────
function relTime(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ─── CONNECT SCREEN ───────────────────────────────────────────────────────────
function ConnectScreen({ onConnect }) {
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    if (!key.trim()) return;
    setLoading(true);
    setError("");
    try {
      const pd = makePD(key.trim());
      const me = await pd.getMe();
      onConnect(key.trim(), me.user);
    } catch (e) {
      setError("Could not connect. Double-check your API key and try again.");
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e) { if (e.key === "Enter") connect(); }

  return (
    <div style={{
      minHeight: "100vh", background: T.bg,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24,
    }}>
      <div style={{
        width: "100%", maxWidth: 440,
        background: T.bgCard, border: `1px solid ${T.border}`,
        borderRadius: 16, padding: 36,
        boxShadow: "0 32px 80px rgba(0,0,0,0.5)",
        animation: "fadeIn 0.25s ease",
      }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14,
            background: `linear-gradient(135deg, ${T.greenDim}, ${T.green})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 24, marginBottom: 14, margin: "0 auto 14px",
            boxShadow: `0 0 28px ${T.greenGlow}`,
          }}>◈</div>
          <div style={{ color: T.textPrimary, fontSize: 20, fontWeight: 700, letterSpacing: -0.5 }}>
            SRE Agent Memory Manager
          </div>
          <div style={{ color: T.textSecondary, fontSize: 13, marginTop: 6 }}>
            Browse, edit, and delete what your SRE Agent has learned
          </div>
        </div>

        <label style={{ display: "block", color: T.textSecondary, fontSize: 12, fontWeight: 600, marginBottom: 7, letterSpacing: 0.5, textTransform: "uppercase" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            PagerDuty API Key
            <InfoIcon tip="Create a User API Token in PagerDuty under My Profile → User Settings → Create API User Token. The token needs read access to Services and the SRE Agent Memory API." />
          </span>
        </label>
        <input
          type="password"
          value={key}
          onChange={e => setKey(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="u+xxxxxxxxxxxxxxxxxx"
          style={{
            background: T.bgInput, border: `1px solid ${T.border}`,
            borderRadius: 7, color: T.textPrimary, fontSize: 13,
            padding: "8px 12px", outline: "none", width: "100%",
            boxSizing: "border-box",
          }}
        />

        {error && (
          <div style={{
            marginTop: 10, padding: "8px 12px",
            background: T.redDim, border: `1px solid ${T.red}44`,
            borderRadius: 7, color: T.red, fontSize: 12,
          }}>{error}</div>
        )}

        <button onClick={connect} disabled={loading || !key.trim()} style={{
          display: "block", width: "100%", marginTop: 14, padding: "10px 16px",
          borderRadius: 7, border: "none", cursor: loading || !key.trim() ? "not-allowed" : "pointer",
          fontSize: 14, fontWeight: 600, background: T.green, color: "#fff",
          opacity: loading || !key.trim() ? 0.5 : 1, transition: "opacity 0.15s",
        }}>
          {loading ? "Connecting…" : "Connect to PagerDuty →"}
        </button>

        <div style={{
          marginTop: 20, padding: "12px 14px",
          background: T.bgInput, borderRadius: 8,
          border: `1px solid ${T.border}`,
          color: T.textDim, fontSize: 11, lineHeight: 1.6,
        }}>
          <span style={{ color: T.amber, fontWeight: 600 }}>Requires PagerDuty Advance</span> — the SRE Agent Memory API is only available on accounts with the Advance add-on enabled. Your API key is stored in memory only and cleared when you close this tab.
        </div>
      </div>
    </div>
  );
}

// ─── Field ────────────────────────────────────────────────────────────────────
function Field({ label, tip, children }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 5 }}>
        <span style={{ color: T.textDim, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {label}
        </span>
        {tip && <InfoIcon tip={tip} />}
      </div>
      {children}
    </div>
  );
}

// ─── MEMORY DETAIL PANEL ──────────────────────────────────────────────────────
function MemoryDetail({ memory, pd, onUpdate, onDelete, onClose }) {
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState(memory.body ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const meta = metaFor(memory.type);

  async function saveEdit() {
    setSaving(true);
    try {
      // Re-append the most recent footer (if any) so PagerDuty's own metadata
      // tracking isn't silently dropped by an edit made through this tool.
      const lastFooterRaw = memory.footerCount > 0
        ? `\n\n---\n_Metadata: ${Object.entries(memory.footerMeta)
            .map(([k, v]) => {
              const labelMap = { updated: "Updated", considered: "Considered", version: "Version", basedOn: "Based on" };
              return `${labelMap[k] ?? k} ${v}`;
            })
            .join(" | ")}_`
        : "";
      const fullContent = editContent + lastFooterRaw;
      await pd.updateMemory(memory.id, fullContent);
      onUpdate({ ...memory, body: editContent, rawContent: fullContent });
      setEditMode(false);
    } catch (e) {
      alert("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmAndDelete() {
    setDeleting(true);
    try {
      await pd.deleteMemory(memory.id);
      // The memory is gone server-side, so drop it from the list rather than
      // marking it — there is no state PagerDuty can report it back in.
      onDelete(memory.id);
      setConfirmDelete(false);
      onClose();
    } catch (e) {
      alert("Delete failed: " + e.message);
      setDeleting(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)",
      display: "flex", alignItems: "flex-start", justifyContent: "flex-end",
      zIndex: 800,
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        width: "100%", maxWidth: 640, height: "100vh",
        background: T.bgCard, borderLeft: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column",
        animation: "fadeIn 0.2s ease",
        overflowY: "auto",
      }}>
        <div style={{
          padding: "16px 20px", borderBottom: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          position: "sticky", top: 0, background: T.bgCard, zIndex: 1,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: meta.color, fontSize: 18 }}>{meta.icon}</span>
            <div>
              <div style={{ color: T.textPrimary, fontWeight: 700, fontSize: 14 }}>
                Memory Detail
              </div>
              <div style={{ color: T.textDim, fontSize: 11 }}>{memory.id}</div>
            </div>
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: T.textDim,
            cursor: "pointer", fontSize: 18, padding: 4,
          }}>✕</button>
        </div>

        <div style={{ padding: 20, flex: 1 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
            <TypeBadge type={memory.type} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              {memory.serviceId && (
                <Field label="Service ID" tip="The PagerDuty service this memory is scoped to.">
                  <code style={{ color: T.cyan, fontSize: 12 }}>{memory.serviceId}</code>
                </Field>
              )}
              {memory.incidentId && (
                <Field label="Incident ID" tip="The specific incident that generated this memory.">
                  <code style={{ color: T.purple, fontSize: 12 }}>{memory.incidentId}</code>
                </Field>
              )}
            </div>

            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              {memory.createdAt && (
                <Field label="Created" tip="When the SRE Agent created this memory entry.">
                  <span style={{ color: T.textSecondary, fontSize: 12 }}>
                    {new Date(memory.createdAt).toLocaleString()} ({relTime(memory.createdAt)})
                  </span>
                </Field>
              )}
              {memory.updatedAt && memory.updatedAt !== memory.createdAt && (
                <Field label="Last Updated" tip="The last time this memory was edited or updated.">
                  <span style={{ color: T.textSecondary, fontSize: 12 }}>
                    {new Date(memory.updatedAt).toLocaleString()} ({relTime(memory.updatedAt)})
                  </span>
                </Field>
              )}
            </div>

            {/* Parsed footer metadata, if present in the original content */}
            {memory.footerCount > 0 && (
              <Field label="Agent Confidence Metadata" tip="Information the SRE Agent embeds directly in the memory content describing how many incidents informed it and when it was last reconsidered. Parsed out of the raw text for clarity.">
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  {memory.footerMeta.version && (
                    <span style={{ color: T.textSecondary, fontSize: 12 }}>
                      Version <strong style={{ color: T.textPrimary }}>{memory.footerMeta.version}</strong>
                    </span>
                  )}
                  {memory.footerMeta.basedOn && (
                    <span style={{ color: T.textSecondary, fontSize: 12 }}>
                      Based on <strong style={{ color: T.textPrimary }}>{memory.footerMeta.basedOn}</strong>
                    </span>
                  )}
                  {memory.footerMeta.considered && (
                    <span style={{ color: T.textSecondary, fontSize: 12 }}>
                      Last considered <strong style={{ color: T.textPrimary }}>{relTime(memory.footerMeta.considered)}</strong>
                    </span>
                  )}
                </div>
              </Field>
            )}
          </div>

          {/* Content */}
          <div>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 8,
            }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <span style={{ color: T.textDim, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Content
                </span>
                <InfoIcon tip="The actual knowledge stored in this memory, rendered from the agent's markdown." />
              </div>
              {!editMode && (
                <Btn small variant="ghost" onClick={() => { setEditContent(memory.body ?? ""); setEditMode(true); }}>
                  Edit
                </Btn>
              )}
            </div>

            {editMode ? (
              <div>
                <textarea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  rows={16}
                  style={{
                    width: "100%", background: T.bgInput,
                    border: `1px solid ${T.border}`, borderRadius: 7,
                    color: T.textPrimary, fontSize: 13, padding: "10px 12px",
                    outline: "none", lineHeight: 1.6, fontFamily: "ui-monospace, monospace",
                  }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <Btn onClick={saveEdit} disabled={saving}>
                    {saving ? "Saving…" : "Save changes"}
                  </Btn>
                  <Btn variant="ghost" onClick={() => setEditMode(false)}>
                    Cancel
                  </Btn>
                </div>
              </div>
            ) : (
              <div style={{
                background: T.bgInput, border: `1px solid ${T.border}`,
                borderRadius: 7, padding: "14px 16px",
                color: T.textPrimary,
              }}>
                <Markdown text={memory.body} />
              </div>
            )}
          </div>

          {!editMode && (
            <div style={{
              marginTop: 28, padding: "14px 16px",
              border: `1px solid ${T.red}33`, borderRadius: 8,
              background: T.redDim,
            }}>
              <div style={{ color: T.red, fontWeight: 700, fontSize: 13, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                ⚠ Delete this memory
                <InfoIcon tip="Deleting removes this memory from the SRE Agent's knowledge base permanently. The agent will no longer use this information when investigating incidents. This cannot be undone, and the memory cannot be restored." />
              </div>
              <div style={{ color: T.textSecondary, fontSize: 12, marginBottom: 12 }}>
                Permanently removes this entry from the agent's knowledge. The agent will stop using it for future incidents. This cannot be undone.
              </div>
              <Btn danger onClick={() => setConfirmDelete(true)}>
                Delete memory
              </Btn>
            </div>
          )}
        </div>
      </div>

      {confirmDelete && (
        <Modal title="Confirm Deletion" onClose={() => setConfirmDelete(false)} width={420}>
          <div style={{ color: T.textSecondary, fontSize: 13, lineHeight: 1.7, marginBottom: 20 }}>
            You are about to permanently remove this memory from the SRE Agent's knowledge base.
            <br /><br />
            <strong style={{ color: T.textPrimary }}>The agent will stop using this information for future incidents.</strong> This action cannot be undone.
          </div>
          <div style={{
            background: T.bgInput, borderRadius: 7, padding: "10px 12px",
            color: T.textDim, fontSize: 12, marginBottom: 20,
            fontStyle: "italic", border: `1px solid ${T.border}`,
          }}>
            "{(memory.body ?? "").slice(0, 140)}{(memory.body ?? "").length > 140 ? "…" : ""}"
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn danger onClick={confirmAndDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Yes, delete permanently"}
            </Btn>
            <Btn variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── MEMORY ROW ───────────────────────────────────────────────────────────────
function MemoryRow({ memory, onClick }) {
  const [hovered, setHovered] = useState(false);

  // Strip markdown syntax roughly for the preview line so '#### Service Profile: X'
  // doesn't show literal hashes in a single-line preview.
  const previewText = (memory.body || "")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\n+/g, " ")
    .trim();

  return (
    <div
      onClick={() => onClick(memory)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "170px 1fr 120px",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        borderBottom: `1px solid ${T.border}`,
        cursor: "pointer",
        background: hovered ? T.bgElevated : "transparent",
        transition: "background 0.12s",
      }}
    >
      <TypeBadge type={memory.type} />

      <div style={{
        color: T.textPrimary,
        fontSize: 13, lineHeight: 1.5,
        overflow: "hidden", textOverflow: "ellipsis",
        display: "-webkit-box", WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
      }}>
        {previewText.slice(0, 220) || <em style={{ color: T.textDim }}>No content</em>}
      </div>

      <div style={{ color: T.textDim, fontSize: 11, textAlign: "right" }}>
        {relTime(memory.updatedAt ?? memory.createdAt)}
      </div>
    </div>
  );
}

// ─── SERVICE CARD ─────────────────────────────────────────────────────────────
function ServiceCard({ service, selected, onClick, memoryCounts }) {
  const total = memoryCounts ? Object.values(memoryCounts).reduce((a, b) => a + b, 0) : null;
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "12px 14px", cursor: "pointer", borderRadius: 9,
        border: selected ? `1px solid ${T.green}66` : `1px solid ${hovered ? T.borderHover : "transparent"}`,
        background: selected ? T.greenGlow : hovered ? T.bgElevated : "transparent",
        transition: "all 0.15s", position: "relative",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ position: "relative", flexShrink: 0 }}>
          <div style={{
            width: 10, height: 10, borderRadius: "50%",
            background: selected ? T.green : total ? T.cyan : T.textDim,
            boxShadow: selected ? `0 0 0 3px ${T.greenGlow}` : "none",
          }} />
          {selected && (
            <div style={{
              position: "absolute", inset: -4,
              borderRadius: "50%",
              border: `1.5px solid ${T.green}`,
              animation: "ring 2s ease-in-out infinite",
            }} />
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            color: selected ? T.textPrimary : T.textSecondary,
            fontWeight: selected ? 700 : 500, fontSize: 13,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {service.name}
          </div>
          {total !== null && (
            <div style={{ color: T.textDim, fontSize: 11, marginTop: 1 }}>
              {total} {total === 1 ? "memory" : "memories"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
function App() {
  const [user, setUser] = useState(null);
  const [pd, setPd] = useState(null);

  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesMore, setServicesMore] = useState(false);
  const [servicesOffset, setServicesOffset] = useState(0);
  const [serviceSearch, setServiceSearch] = useState("");
  const [selectedService, setSelectedService] = useState(null);

  const [memories, setMemories] = useState([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [memoryCounts, setMemoryCounts] = useState({});

  const [typeFilter, setTypeFilter] = useState("all");
  const [memSearch, setMemSearch] = useState("");

  const [selectedMemory, setSelectedMemory] = useState(null);
  const [toast, setToast] = useState(null);

  const [incidentId, setIncidentId] = useState("");
  const [incidentMode, setIncidentMode] = useState(false);

  function showToast(message, type = "success") {
    setToast({ message, type, key: Date.now() });
  }

  function handleConnect(key, u) {
    // Surface retries instead of leaving the user staring at a spinner while we
    // wait out a 429.
    const client = makePD(key, {
      onRetry: ({ attempt, of, delayMs }) => showToast(
        `Rate limited — retrying in ${Math.ceil(delayMs / 1000)}s (${attempt}/${of})`,
        "warning",
      ),
    });
    setUser(u);
    setPd(client);
  }

  const loadServices = useCallback(async (offset = 0, append = false) => {
    if (!pd) return;
    setServicesLoading(true);
    try {
      const res = await pd.listServices(offset);
      const list = res.services ?? [];
      setServices(prev => append ? [...prev, ...list] : list);
      setServicesMore(res.more ?? false);
      setServicesOffset(offset + list.length);
    } catch (e) {
      showToast("Failed to load services: " + e.message, "error");
    } finally {
      setServicesLoading(false);
    }
  }, [pd]);

  useEffect(() => {
    if (pd) loadServices(0);
  }, [pd, loadServices]);

  const computeCounts = (mems) => {
    const counts = {};
    mems.forEach(m => {
      counts[m.type] = (counts[m.type] ?? 0) + 1;
    });
    return counts;
  };

  const loadMemories = useCallback(async (service) => {
    if (!pd || !service) return;
    setMemoriesLoading(true);
    try {
      const res = await pd.listServiceMemories(service.id);
      const rawList = res.memories ?? [];
      const list = rawList.map(normalizeMemory);
      setMemories(list);
      setMemoryCounts(prev => ({ ...prev, [service.id]: computeCounts(list) }));
    } catch (e) {
      showToast("Failed to load memories: " + e.message, "error");
    } finally {
      setMemoriesLoading(false);
    }
  }, [pd]);

  const loadIncidentMemories = useCallback(async (incId) => {
    if (!pd) return;
    setMemoriesLoading(true);
    try {
      const res = await pd.listIncidentMemories(incId);
      const rawList = res.memories ?? [];
      const list = rawList.map(normalizeMemory);
      setMemories(list);
    } catch (e) {
      showToast("Failed to load incident memories: " + e.message, "error");
    } finally {
      setMemoriesLoading(false);
    }
  }, [pd]);

  function handleSelectService(service) {
    setSelectedService(service);
    setIncidentMode(false);
    setIncidentId("");
    setMemories([]);
    setTypeFilter("all");
    setMemSearch("");
    setSelectedMemory(null);
    loadMemories(service);
  }

  function handleIncidentLookup() {
    if (!incidentId.trim()) return;
    setSelectedService(null);
    setIncidentMode(true);
    setMemories([]);
    setSelectedMemory(null);
    loadIncidentMemories(incidentId.trim());
  }

  function handleMemoryUpdate(updated) {
    setMemories(prev => prev.map(m => m.id === updated.id ? updated : m));
    setSelectedMemory(updated);
    showToast("Memory updated");
  }

  function handleMemoryDelete(deletedId) {
    const remaining = memories.filter(m => m.id !== deletedId);
    setMemories(remaining);
    // Keep the sidebar's per-service counts honest after a deletion.
    if (selectedService) {
      setMemoryCounts(prev => ({ ...prev, [selectedService.id]: computeCounts(remaining) }));
    }
    setSelectedMemory(null);
    showToast("Memory deleted");
  }

  const availableTypes = Array.from(new Set(memories.map(m => m.type)));

  const filtered = memories.filter(m => {
    if (typeFilter !== "all" && m.type !== typeFilter) return false;
    if (memSearch) {
      const q = memSearch.toLowerCase();
      if (!(m.body ?? "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const filteredServices = services.filter(s =>
    s.name.toLowerCase().includes(serviceSearch.toLowerCase())
  );

  const activeCounts = computeCounts(memories);

  if (!pd) {
    return <ConnectScreen onConnect={handleConnect} />;
  }

  return (
    <div style={{
      height: "100vh", background: T.bg,
      color: T.textPrimary, display: "flex", flexDirection: "column",
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 20px", height: 52,
        borderBottom: `1px solid ${T.border}`,
        background: T.bgCard,
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18, color: T.green }}>◈</span>
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.3 }}>
            SRE Agent Memory Manager
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ color: T.textDim, fontSize: 12 }}>
            Signed in as <span style={{ color: T.textSecondary }}>{user?.name}</span>
          </div>
          <Btn small variant="ghost" onClick={() => { setPd(null); setUser(null); setServices([]); setMemories([]); setSelectedService(null); }}>
            Disconnect
          </Btn>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        <div style={{
          width: 240, flexShrink: 0, borderRight: `1px solid ${T.border}`,
          background: T.bgCard, display: "flex", flexDirection: "column",
          overflowY: "auto",
        }}>
          <div style={{ padding: "14px 12px 8px" }}>
            <div style={{ color: T.textDim, fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 8, display: "flex", alignItems: "center" }}>
              Services
              <InfoIcon tip="Your PagerDuty services. Select one to browse what the SRE Agent has learned about it." />
            </div>
            <input
              value={serviceSearch}
              onChange={e => setServiceSearch(e.target.value)}
              placeholder="Filter services…"
              style={{
                background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7,
                color: T.textPrimary, fontSize: 12, padding: "6px 10px",
                outline: "none", width: "100%", boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ padding: "8px 12px", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ color: T.textDim, fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 6, display: "flex", alignItems: "center" }}>
              By Incident ID
              <InfoIcon tip="Look up memories tied to a specific incident rather than a service. Enter the incident ID (e.g. Q3P2WDQHC9HWBG)." />
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={incidentId}
                onChange={e => setIncidentId(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleIncidentLookup()}
                placeholder="Q3P2WDQHC9HWBG"
                style={{
                  background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7,
                  color: T.textPrimary, fontSize: 12, padding: "6px 10px",
                  outline: "none", flex: 1, minWidth: 0,
                }}
              />
              <Btn small onClick={handleIncidentLookup} disabled={!incidentId.trim()}>→</Btn>
            </div>
          </div>

          <div style={{ flex: 1, padding: "6px 8px", overflowY: "auto" }}>
            {servicesLoading && services.length === 0 ? (
              <div style={{ color: T.textDim, fontSize: 12, padding: "12px 8px", textAlign: "center" }}>
                Loading services…
              </div>
            ) : filteredServices.length === 0 ? (
              <div style={{ color: T.textDim, fontSize: 12, padding: "12px 8px", textAlign: "center" }}>
                No services found
              </div>
            ) : (
              filteredServices.map(s => (
                <ServiceCard
                  key={s.id}
                  service={s}
                  selected={selectedService?.id === s.id}
                  onClick={() => handleSelectService(s)}
                  memoryCounts={memoryCounts[s.id]}
                />
              ))
            )}
            {servicesMore && (
              <div style={{ padding: "8px 6px" }}>
                <Btn small variant="ghost" onClick={() => loadServices(servicesOffset, true)}>
                  Load more
                </Btn>
              </div>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {!selectedService && !incidentMode ? (
            <div style={{
              flex: 1, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              color: T.textDim, textAlign: "center", padding: 40,
            }}>
              <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>◈</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: T.textSecondary, marginBottom: 8 }}>
                Select a service to browse its memories
              </div>
              <div style={{ fontSize: 13, maxWidth: 380, lineHeight: 1.7 }}>
                The SRE Agent builds a knowledge base for each service as it handles incidents.
                Choose a service from the sidebar to see what it has learned.
              </div>
            </div>
          ) : (
            <>
              <div style={{
                padding: "16px 20px", borderBottom: `1px solid ${T.border}`,
                background: T.bgCard, position: "sticky", top: 0, zIndex: 10, flexShrink: 0,
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: -0.3 }}>
                      {incidentMode ? `Incident: ${incidentId}` : selectedService?.name}
                    </div>
                    <div style={{ color: T.textDim, fontSize: 12, marginTop: 3 }}>
                      {incidentMode
                        ? "Memories associated with this incident"
                        : "Memories the SRE Agent has built for this service"}
                    </div>
                  </div>

                  {memories.length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {Object.entries(activeCounts).map(([type, count]) => {
                        const m = metaFor(type);
                        return (
                          <span key={type} style={{
                            padding: "3px 9px", borderRadius: 99, fontSize: 11, fontWeight: 600,
                            background: `${m.color}18`, color: m.color, border: `1px solid ${m.color}33`,
                          }}>
                            {count} {m.label}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    <button
                      onClick={() => setTypeFilter("all")}
                      style={{
                        padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer",
                        fontSize: 12, fontWeight: 600,
                        background: typeFilter === "all" ? T.green + "22" : "transparent",
                        color: typeFilter === "all" ? T.green : T.textDim,
                        borderBottom: typeFilter === "all" ? `2px solid ${T.green}` : "2px solid transparent",
                        transition: "all 0.1s",
                      }}
                    >
                      All types
                    </button>
                    {["service_profile", "incident_summary", "playbook", "runbook"].map(t => {
                      const active = typeFilter === t;
                      const m = MEMORY_META[t];
                      const present = availableTypes.includes(t);
                      return (
                        <button
                          key={t}
                          onClick={() => setTypeFilter(t)}
                          style={{
                            padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer",
                            fontSize: 12, fontWeight: 600,
                            background: active ? m.color + "22" : "transparent",
                            color: active ? m.color : present ? T.textDim : T.border,
                            borderBottom: active ? `2px solid ${m.color}` : "2px solid transparent",
                            transition: "all 0.1s",
                          }}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                    {/* Render any unexpected/unknown type tabs too, so nothing is hidden */}
                    {availableTypes
                      .filter(t => !MEMORY_META[t])
                      .map(t => {
                        const active = typeFilter === t;
                        const m = metaFor(t);
                        return (
                          <button
                            key={t}
                            onClick={() => setTypeFilter(t)}
                            style={{
                              padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer",
                              fontSize: 12, fontWeight: 600,
                              background: active ? T.bgElevated : "transparent",
                              color: active ? T.textPrimary : T.textDim,
                              borderBottom: active ? `2px solid ${T.textSecondary}` : "2px solid transparent",
                              transition: "all 0.1s",
                            }}
                          >
                            {m.label}
                          </button>
                        );
                      })}
                  </div>

                  <div style={{ marginLeft: "auto", width: 220 }}>
                    <input
                      value={memSearch}
                      onChange={e => setMemSearch(e.target.value)}
                      placeholder="Search memory content…"
                      style={{
                        background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7,
                        color: T.textPrimary, fontSize: 12, padding: "5px 10px",
                        outline: "none", width: "100%", boxSizing: "border-box",
                      }}
                    />
                  </div>
                </div>
              </div>

              <div style={{
                display: "grid",
                gridTemplateColumns: "170px 1fr 120px",
                gap: 12, padding: "8px 16px",
                background: T.bgInput,
                borderBottom: `1px solid ${T.border}`,
                flexShrink: 0,
              }}>
                {[
                  ["Type", "The category of knowledge stored in this memory."],
                  ["Content preview", "A preview of the memory's content. Click a row to read the full entry."],
                  ["Last updated", "When this memory was last modified or created."],
                ].map(([label, tip]) => (
                  <div key={label} style={{ display: "flex", alignItems: "center" }}>
                    <span style={{ color: T.textDim, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                      {label}
                    </span>
                    <InfoIcon tip={tip} />
                  </div>
                ))}
              </div>

              <div style={{ flex: 1 }}>
                {memoriesLoading && memories.length === 0 ? (
                  <div style={{ padding: "40px 20px", textAlign: "center", color: T.textDim }}>
                    <div style={{ fontSize: 13, animation: "pulse 1.5s ease-in-out infinite" }}>
                      Loading memories…
                    </div>
                  </div>
                ) : filtered.length === 0 ? (
                  <div style={{ padding: "40px 20px", textAlign: "center" }}>
                    <div style={{ color: T.textDim, fontSize: 13 }}>
                      {memories.length === 0
                        ? "No memories found for this service. The SRE Agent builds memories as it handles incidents."
                        : "No memories match your current filters."}
                    </div>
                  </div>
                ) : (
                  filtered.map(m => (
                    <MemoryRow key={m.id} memory={m} onClick={setSelectedMemory} />
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {selectedMemory && (
        <MemoryDetail
          memory={selectedMemory}
          pd={pd}
          onUpdate={handleMemoryUpdate}
          onDelete={handleMemoryDelete}
          onClose={() => setSelectedMemory(null)}
        />
      )}

      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          type={toast.type}
          onDone={() => setToast(null)}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
