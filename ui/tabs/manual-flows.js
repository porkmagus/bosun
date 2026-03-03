/* ─────────────────────────────────────────────────────────────
 *  Tab: Manual Flows — One-shot template-driven transformations
 *  Users pick a template, fill a form, and trigger a run.
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";

const html = htm.bind(h);

import { haptic } from "../modules/telegram.js";
import { apiFetch } from "../modules/api.js";
import { showToast } from "../modules/state.js";
import { ICONS } from "../modules/icons.js";
import { resolveIcon } from "../modules/icon-utils.js";
import { formatRelative } from "../modules/utils.js";
import {
  Typography, Box, Stack, Card, CardContent, Button, IconButton, Chip,
  TextField, Select, MenuItem, FormControl, InputLabel, Switch,
  FormControlLabel, Tooltip, Paper, Divider, CircularProgress, Alert,
  Dialog, DialogTitle, DialogContent, DialogActions,
  Tabs, Tab,
} from "@mui/material";

/* ═══════════════════════════════════════════════════════════════
 *  State
 * ═══════════════════════════════════════════════════════════════ */

const flowTemplates = signal([]);
const flowRuns = signal([]);
const selectedTemplate = signal(null);
const activeRun = signal(null);
const viewMode = signal("templates"); // "templates" | "form" | "runs"
const executing = signal(false);

/* ═══════════════════════════════════════════════════════════════
 *  API Helpers
 * ═══════════════════════════════════════════════════════════════ */

async function loadTemplates() {
  try {
    const data = await apiFetch("/api/manual-flows/templates");
    if (data?.templates) flowTemplates.value = data.templates;
  } catch (err) {
    console.error("[manual-flows] Failed to load templates:", err);
  }
}

async function loadRuns() {
  try {
    const data = await apiFetch("/api/manual-flows/runs");
    if (data?.runs) flowRuns.value = data.runs;
  } catch (err) {
    console.error("[manual-flows] Failed to load runs:", err);
  }
}

async function executeFlow(templateId, formValues) {
  executing.value = true;
  try {
    const data = await apiFetch("/api/manual-flows/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId, formValues }),
    });
    if (data?.run) {
      activeRun.value = data.run;
      showToast(
        data.run.status === "completed"
          ? "Flow completed successfully"
          : data.run.status === "failed"
          ? "Flow failed: " + (data.run.error || "unknown error")
          : "Flow dispatched",
        data.run.status === "failed" ? "error" : "success",
      );
      loadRuns().catch(() => {});
    }
    return data?.run;
  } catch (err) {
    showToast("Failed to execute flow: " + err.message, "error");
    return null;
  } finally {
    executing.value = false;
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  Category metadata
 * ═══════════════════════════════════════════════════════════════ */

const CATEGORY_META = {
  audit: { label: "Audit & Analysis", icon: "search", color: "#3b82f6", bg: "#3b82f615" },
  generate: { label: "Generate & Prepare", icon: "book", color: "#10b981", bg: "#10b98115" },
  transform: { label: "Transform & Refactor", icon: "refresh", color: "#f59e0b", bg: "#f59e0b15" },
  custom: { label: "Custom", icon: "settings", color: "#8b5cf6", bg: "#8b5cf615" },
};

function getCategoryMeta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META.custom;
}

/* ═══════════════════════════════════════════════════════════════
 *  Form Field Renderer
 * ═══════════════════════════════════════════════════════════════ */

function FormField({ field, value, onChange }) {
  const { id, label, type, placeholder, helpText, options, defaultValue } = field;
  const currentValue = value !== undefined ? value : (defaultValue ?? "");

  switch (type) {
    case "text":
      return html`
        <${TextField}
          fullWidth
          size="small"
          label=${label}
          placeholder=${placeholder || ""}
          value=${currentValue}
          onChange=${(e) => onChange(id, e.target.value)}
          helperText=${helpText || ""}
          sx=${{ mb: 2 }}
        />
      `;

    case "textarea":
      return html`
        <${TextField}
          fullWidth
          multiline
          rows=${4}
          size="small"
          label=${label}
          placeholder=${placeholder || ""}
          value=${currentValue}
          onChange=${(e) => onChange(id, e.target.value)}
          helperText=${helpText || ""}
          sx=${{ mb: 2, "& .MuiInputBase-input": { fontFamily: "monospace", fontSize: "0.85em" } }}
        />
      `;

    case "number":
      return html`
        <${TextField}
          fullWidth
          size="small"
          type="number"
          label=${label}
          placeholder=${placeholder || ""}
          value=${currentValue}
          onChange=${(e) => onChange(id, Number(e.target.value))}
          helperText=${helpText || ""}
          sx=${{ mb: 2 }}
        />
      `;

    case "select":
      return html`
        <${FormControl} fullWidth size="small" sx=${{ mb: 2 }}>
          <${InputLabel}>${label}</${InputLabel}>
          <${Select}
            label=${label}
            value=${currentValue}
            onChange=${(e) => onChange(id, e.target.value)}
          >
            ${(options || []).map(
              (opt) => html`<${MenuItem} key=${opt.value} value=${opt.value}>${opt.label}</${MenuItem}>`,
            )}
          </${Select}>
          ${helpText && html`<${Typography} variant="caption" color="text.secondary" sx=${{ mt: 0.5, ml: 1.5 }}>${helpText}</${Typography}>`}
        </${FormControl}>
      `;

    case "toggle":
      return html`
        <${Box} sx=${{ mb: 2 }}>
          <${FormControlLabel}
            control=${html`<${Switch}
              checked=${!!currentValue}
              onChange=${(e) => onChange(id, e.target.checked)}
              size="small"
            />`}
            label=${label}
          />
          ${helpText && html`<${Typography} variant="caption" display="block" color="text.secondary" sx=${{ ml: 4.5, mt: -0.5 }}>${helpText}</${Typography}>`}
        </${Box}>
      `;

    default:
      return html`
        <${TextField}
          fullWidth
          size="small"
          label=${label}
          value=${currentValue}
          onChange=${(e) => onChange(id, e.target.value)}
          helperText=${helpText || ""}
          sx=${{ mb: 2 }}
        />
      `;
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  Template Card
 * ═══════════════════════════════════════════════════════════════ */

function TemplateCard({ template, onClick }) {
  const catMeta = getCategoryMeta(template.category);

  return html`
    <${Card}
      variant="outlined"
      sx=${{
        cursor: "pointer",
        transition: "all 0.15s",
        "&:hover": { borderColor: catMeta.color, transform: "translateY(-1px)", boxShadow: "0 4px 12px rgba(0,0,0,0.3)" },
      }}
      onClick=${onClick}
    >
      <${CardContent} sx=${{ pb: "12px !important" }}>
        <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1 }}>
          <span class="icon-inline" style=${{ fontSize: "18px", color: catMeta.color }}>
            ${resolveIcon(template.icon || catMeta.icon)}
          </span>
          <${Typography} variant="subtitle1" fontWeight=${600} sx=${{ flex: 1 }}>
            ${template.name}
          </${Typography}>
          ${template.builtin && html`
            <${Chip} label="Built-in" size="small" variant="outlined" sx=${{ fontSize: "10px", height: "20px" }} />
          `}
        </${Stack}>

        <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 1.5, lineHeight: 1.5 }}>
          ${template.description}
        </${Typography}>

        <${Stack} direction="row" spacing=${0.5} flexWrap="wrap" useFlexGap>
          <${Chip}
            label=${catMeta.label}
            size="small"
            sx=${{ fontSize: "10px", height: "20px", background: catMeta.bg, color: catMeta.color, borderColor: catMeta.color + "40" }}
            variant="outlined"
          />
          <${Chip}
            label=${`${(template.fields || []).length} fields`}
            size="small"
            sx=${{ fontSize: "10px", height: "20px" }}
            variant="outlined"
          />
          ${(template.tags || []).slice(0, 3).map(
            (tag) => html`<${Chip} key=${tag} label=${tag} size="small" sx=${{ fontSize: "10px", height: "20px" }} variant="outlined" />`,
          )}
        </${Stack}>
      </${CardContent}>
    </${Card}>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Flow Form View
 * ═══════════════════════════════════════════════════════════════ */

function FlowFormView({ template, onBack }) {
  const [formValues, setFormValues] = useState(() => {
    const defaults = {};
    for (const field of template.fields || []) {
      if (field.defaultValue !== undefined) {
        defaults[field.id] = field.defaultValue;
      }
    }
    return defaults;
  });

  const handleFieldChange = useCallback((fieldId, value) => {
    setFormValues((prev) => ({ ...prev, [fieldId]: value }));
  }, []);

  const handleExecute = useCallback(async () => {
    haptic();
    const run = await executeFlow(template.id, formValues);
    if (run) {
      activeRun.value = run;
    }
  }, [template.id, formValues]);

  const catMeta = getCategoryMeta(template.category);

  return html`
    <div>
      <!-- Back button -->
      <${Button}
        variant="text"
        size="small"
        onClick=${() => { onBack(); activeRun.value = null; }}
        sx=${{ mb: 2, textTransform: "none" }}
        startIcon=${html`<span class="icon-inline">${resolveIcon("chevron-left")}</span>`}
      >
        Back to Templates
      </${Button}>

      <!-- Template header -->
      <${Paper} variant="outlined" sx=${{ p: 2.5, mb: 3 }}>
        <${Stack} direction="row" alignItems="center" spacing=${1.5} sx=${{ mb: 1.5 }}>
          <span class="icon-inline" style=${{ fontSize: "24px", color: catMeta.color }}>
            ${resolveIcon(template.icon || catMeta.icon)}
          </span>
          <div>
            <${Typography} variant="h6" fontWeight=${700}>${template.name}</${Typography}>
            <${Typography} variant="body2" color="text.secondary">${template.description}</${Typography}>
          </div>
        </${Stack}>
      </${Paper}>

      <!-- Form fields -->
      <${Paper} variant="outlined" sx=${{ p: 2.5, mb: 3 }}>
        <${Typography} variant="subtitle2" fontWeight=${600} sx=${{ mb: 2 }}>
          Configuration
        </${Typography}>

        ${(template.fields || []).map(
          (field) => html`
            <${FormField}
              key=${field.id}
              field=${field}
              value=${formValues[field.id]}
              onChange=${handleFieldChange}
            />
          `,
        )}

        <${Divider} sx=${{ my: 2 }} />

        <${Stack} direction="row" spacing=${1.5} justifyContent="flex-end">
          <${Button}
            variant="outlined"
            size="small"
            onClick=${() => { onBack(); activeRun.value = null; }}
            sx=${{ textTransform: "none" }}
          >
            Cancel
          </${Button}>
          <${Button}
            variant="contained"
            onClick=${handleExecute}
            disabled=${executing.value}
            startIcon=${executing.value
              ? html`<${CircularProgress} size=${16} color="inherit" />`
              : html`<span class="icon-inline">${resolveIcon("play")}</span>`}
            sx=${{ textTransform: "none" }}
          >
            ${executing.value ? "Executing…" : "Run Flow"}
          </${Button}>
        </${Stack}>
      </${Paper}>

      <!-- Run result (if available) -->
      ${activeRun.value && html`<${RunResultCard} run=${activeRun.value} />`}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Run Result Card
 * ═══════════════════════════════════════════════════════════════ */

function RunResultCard({ run }) {
  if (!run) return null;

  const statusColors = {
    pending: "#f59e0b",
    running: "#3b82f6",
    completed: "#10b981",
    failed: "#ef4444",
  };
  const statusColor = statusColors[run.status] || "#6b7280";

  return html`
    <${Paper} variant="outlined" sx=${{ p: 2.5, borderColor: statusColor + "40" }}>
      <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1.5 }}>
        <${Chip}
          label=${run.status}
          size="small"
          sx=${{
            background: statusColor + "20",
            color: statusColor,
            fontWeight: 600,
            fontSize: "11px",
            textTransform: "uppercase",
          }}
        />
        <${Typography} variant="body2" color="text.secondary">
          ${run.templateName}
        </${Typography}>
        <div style="flex: 1;" />
        <${Typography} variant="caption" color="text.secondary">
          ${formatRelative(run.startedAt)}
        </${Typography}>
      </${Stack}>

      ${run.error && html`
        <${Alert} severity="error" sx=${{ mb: 1.5 }}>
          ${run.error}
        </${Alert}>
      `}

      ${run.result && html`
        <div>
          ${run.result.mode && html`
            <${Typography} variant="body2" sx=${{ mb: 1 }}>
              <strong>Mode:</strong> ${run.result.mode}
            </${Typography}>
          `}
          ${run.result.filesScanned != null && html`
            <${Typography} variant="body2" sx=${{ mb: 0.5 }}>
              <strong>Files scanned:</strong> ${run.result.filesScanned}
            </${Typography}>
          `}
          ${run.result.filesNeedingSummary != null && html`
            <${Typography} variant="body2" sx=${{ mb: 0.5 }}>
              <strong>Files needing summary:</strong> ${run.result.filesNeedingSummary}
            </${Typography}>
          `}
          ${run.result.filesNeedingWarn != null && html`
            <${Typography} variant="body2" sx=${{ mb: 0.5 }}>
              <strong>Files needing warnings:</strong> ${run.result.filesNeedingWarn}
            </${Typography}>
          `}
          ${run.result.taskId && html`
            <${Alert} severity="info" sx=${{ mt: 1 }}>
              Task dispatched: ${run.result.taskId}
            </${Alert}>
          `}
          ${run.result.instructions && html`
            <${Alert} severity="info" sx=${{ mt: 1 }}>
              ${run.result.instructions}
            </${Alert}>
          `}
          ${run.result.inventoryPath && html`
            <${Typography} variant="caption" color="text.secondary" sx=${{ mt: 1, display: "block" }}>
              Inventory: ${run.result.inventoryPath}
            </${Typography}>
          `}
        </div>
      `}
    </${Paper}>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Run History List
 * ═══════════════════════════════════════════════════════════════ */

function RunHistoryList({ onBack }) {
  useEffect(() => { loadRuns(); }, []);

  const runs = flowRuns.value || [];

  return html`
    <div>
      <${Button}
        variant="text"
        size="small"
        onClick=${onBack}
        sx=${{ mb: 2, textTransform: "none" }}
        startIcon=${html`<span class="icon-inline">${resolveIcon("chevron-left")}</span>`}
      >
        Back to Templates
      </${Button}>

      <${Typography} variant="h6" fontWeight=${700} sx=${{ mb: 2 }}>
        Run History
      </${Typography}>

      ${runs.length === 0 && html`
        <${Paper} variant="outlined" sx=${{ p: 4, textAlign: "center" }}>
          <${Typography} color="text.secondary">No runs yet. Execute a template to see results here.</${Typography}>
        </${Paper}>
      `}

      <${Stack} spacing=${1.5}>
        ${runs.map(
          (run) => html`<${RunResultCard} key=${run.id} run=${run} />`,
        )}
      </${Stack}>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Template List View (main view)
 * ═══════════════════════════════════════════════════════════════ */

function TemplateListView() {
  const tmpls = flowTemplates.value || [];

  // Group by category
  const groups = useMemo(() => {
    const map = {};
    tmpls.forEach((t) => {
      const cat = t.category || "custom";
      if (!map[cat]) map[cat] = [];
      map[cat].push(t);
    });
    const order = ["audit", "generate", "transform", "custom"];
    return order
      .filter((k) => map[k]?.length > 0)
      .map((k) => ({ key: k, meta: getCategoryMeta(k), items: map[k] }));
  }, [tmpls]);

  return html`
    <div>
      <!-- Header -->
      <${Stack} direction="row" alignItems="center" spacing=${1.5} sx=${{ mb: 3 }}>
        <${Typography} variant="h5" fontWeight=${700}>Manual Flows</${Typography}>
        <div style="flex: 1;" />
        <${Button}
          variant="outlined"
          size="small"
          onClick=${() => {
            viewMode.value = "runs";
            haptic();
          }}
          startIcon=${html`<span class="icon-inline">${resolveIcon("chart")}</span>`}
          sx=${{ textTransform: "none" }}
        >
          Run History
        </${Button}>
      </${Stack}>

      <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 3, maxWidth: "600px" }}>
        One-shot transformations for your codebase. Pick a template, fill the form, and trigger.
        Each flow runs once — annotate, generate skills, prepare configs, and more.
      </${Typography}>

      <!-- Template grid grouped by category -->
      ${groups.map(
        ({ key, meta, items }) => html`
          <div key=${key} style="margin-bottom: 24px;">
            <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1.5, pb: 0.5, borderBottom: "1px solid", borderColor: "divider" }}>
              <span class="icon-inline" style=${{ fontSize: "16px", color: meta.color }}>
                ${resolveIcon(meta.icon)}
              </span>
              <${Typography} variant="subtitle2" fontWeight=${600} color="text.secondary">
                ${meta.label}
              </${Typography}>
              <${Chip} label=${items.length} size="small" sx=${{ fontSize: "10px", height: "18px" }} />
            </${Stack}>

            <div style="display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));">
              ${items.map(
                (t) => html`
                  <${TemplateCard}
                    key=${t.id}
                    template=${t}
                    onClick=${() => {
                      selectedTemplate.value = t;
                      viewMode.value = "form";
                      activeRun.value = null;
                      haptic();
                    }}
                  />
                `,
              )}
            </div>
          </div>
        `,
      )}

      ${tmpls.length === 0 && html`
        <${Paper} variant="outlined" sx=${{ p: 4, textAlign: "center" }}>
          <${Typography} variant="h6" sx=${{ mb: 1 }}>No Templates Available</${Typography}>
          <${Typography} color="text.secondary">
            Templates will appear here once the manual flows system is initialized.
          </${Typography}>
        </${Paper}>
      `}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Main Tab Export
 * ═══════════════════════════════════════════════════════════════ */

export function ManualFlowsTab() {
  useEffect(() => {
    loadTemplates();
    loadRuns();
  }, []);

  useEffect(() => {
    const onWorkspaceSwitched = () => {
      selectedTemplate.value = null;
      activeRun.value = null;
      viewMode.value = "templates";
      loadTemplates();
      loadRuns();
    };
    window.addEventListener("ve:workspace-switched", onWorkspaceSwitched);
    return () => window.removeEventListener("ve:workspace-switched", onWorkspaceSwitched);
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.key !== "Escape") return;
      const activeTag = document.activeElement?.tagName || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(activeTag)) return;
      if (viewMode.value !== "templates") {
        e.preventDefault();
        viewMode.value = "templates";
        selectedTemplate.value = null;
        activeRun.value = null;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const mode = viewMode.value;

  return html`
    <div style="padding: 12px; max-width: 1200px; margin: 0 auto;">
      ${mode === "form" && selectedTemplate.value
        ? html`<${FlowFormView}
            template=${selectedTemplate.value}
            onBack=${() => {
              viewMode.value = "templates";
              selectedTemplate.value = null;
            }}
          />`
        : mode === "runs"
        ? html`<${RunHistoryList}
            onBack=${() => { viewMode.value = "templates"; }}
          />`
        : html`<${TemplateListView} />`
      }
    </div>
  `;
}
