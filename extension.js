const vscode = require('vscode');

// ── State ──────────────────────────────────────────────────────────────────
let decorationTypeCache = new Map(); // "bgColor|fgColor" → TextEditorDecorationType
let editorTimeouts = new Map();      // editor URI → timeout id
let isEnabled = true;

const MAX_FILE_SIZE = 500000;        // 500 KB – skip very large files
const MAX_UNIQUE_COLORS = 500;       // max decoration types per update
const DEBOUNCE_MS = 200;

// ── Regex patterns ─────────────────────────────────────────────────────────
const HEX_RE    = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const RGB_RE    = /rgba?\(\s*(\d{1,3}%?)\s*[,\s]\s*(\d{1,3}%?)\s*[,\s]\s*(\d{1,3}%?)(?:\s*[,/]\s*(\d*\.?\d+%?))?\s*\)/gi;
const HSL_RE    = /hsla?\(\s*(\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(\d{1,3}(?:\.\d+)?)%\s*[,\s]\s*(\d{1,3}(?:\.\d+)?)%(?:\s*[,/]\s*(\d*\.?\d+%?))?\s*\)/gi;

// ── Activation ─────────────────────────────────────────────────────────────
function activate(context) {
    isEnabled = vscode.workspace
        .getConfiguration('polarBlack.colorHighlight')
        .get('enable', true);

    // Decorate all currently visible editors
    if (isEnabled) {
        vscode.window.visibleTextEditors.forEach(e => scheduleUpdate(e, false));
    }

    // Active editor changed
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && isEnabled) scheduleUpdate(editor, false);
        })
    );

    // Document content changed
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document && isEnabled) {
                scheduleUpdate(editor, true);
            }
        })
    );

    // Visible editors changed (split view)
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(editors => {
            if (isEnabled) editors.forEach(e => scheduleUpdate(e, false));
        })
    );

    // Settings changed
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('polarBlack.colorHighlight.enable')) {
                isEnabled = vscode.workspace
                    .getConfiguration('polarBlack.colorHighlight')
                    .get('enable', true);

                if (isEnabled) {
                    vscode.window.visibleTextEditors.forEach(e => scheduleUpdate(e, false));
                } else {
                    disposeAllDecorations();
                }
            }
        })
    );
}

// ── Deactivation ───────────────────────────────────────────────────────────
function deactivate() {
    disposeAllDecorations();
    for (const id of editorTimeouts.values()) clearTimeout(id);
    editorTimeouts.clear();
}

// ── Scheduling / debounce ──────────────────────────────────────────────────
function scheduleUpdate(editor, debounce) {
    const key = editor.document.uri.toString();

    if (editorTimeouts.has(key)) {
        clearTimeout(editorTimeouts.get(key));
        editorTimeouts.delete(key);
    }

    if (debounce) {
        editorTimeouts.set(key, setTimeout(() => {
            editorTimeouts.delete(key);
            updateDecorations(editor);
        }, DEBOUNCE_MS));
    } else {
        updateDecorations(editor);
    }
}

// ── Core decoration logic ──────────────────────────────────────────────────
function updateDecorations(editor) {
    if (!editor) return;

    const text = editor.document.getText();

    // Skip huge files
    if (text.length > MAX_FILE_SIZE) {
        disposeAllDecorations();
        return;
    }

    const matches = findColorMatches(text);

    // Group by resolved color key
    const groups = new Map(); // colorKey → { bg, fg, ranges[] }

    for (const m of matches) {
        if (!m.rgba) continue;
        const { r, g, b, a } = m.rgba;

        const bg = a < 1
            ? `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`
            : `#${hex2(r)}${hex2(g)}${hex2(b)}`;

        const eff = a < 1
            ? { r: Math.round(r * a), g: Math.round(g * a), b: Math.round(b * a) }
            : { r, g, b };
        const fg = contrastColor(eff.r, eff.g, eff.b);
        const key = `${bg}|${fg}`;

        const start = editor.document.positionAt(m.index);
        const end   = editor.document.positionAt(m.index + m.text.length);

        if (!groups.has(key)) groups.set(key, { bg, fg, ranges: [] });
        groups.get(key).ranges.push({ range: new vscode.Range(start, end) });
    }

    // Guard: too many unique colors
    if (groups.size > MAX_UNIQUE_COLORS) {
        disposeAllDecorations();
        return;
    }

    // Dispose old, apply new
    disposeAllDecorations();

    for (const [key, g] of groups) {
        const dt = getOrCreateDecorationType(g.bg, g.fg, key);
        editor.setDecorations(dt, g.ranges);
    }
}

// ── Decoration type cache ──────────────────────────────────────────────────
function getOrCreateDecorationType(bg, fg, key) {
    if (!decorationTypeCache.has(key)) {
        decorationTypeCache.set(key, vscode.window.createTextEditorDecorationType({
            backgroundColor: bg,
            color: fg,
            borderRadius: '3px',
            border: `1px solid ${bg}`
        }));
    }
    return decorationTypeCache.get(key);
}

function disposeAllDecorations() {
    for (const dt of decorationTypeCache.values()) dt.dispose();
    decorationTypeCache.clear();
}

// ── Color matching ─────────────────────────────────────────────────────────
function findColorMatches(text) {
    const results = [];
    const patterns = [
        { re: new RegExp(HEX_RE.source, 'gi'),  parse: parseHex },
        { re: new RegExp(RGB_RE.source, 'gi'),   parse: parseRgb },
        { re: new RegExp(HSL_RE.source, 'gi'),   parse: parseHsl },
    ];

    for (const { re, parse } of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) {
            const rgba = parse(m);
            if (rgba) results.push({ text: m[0], index: m.index, rgba });
        }
    }
    return results;
}

// ── Parsers ────────────────────────────────────────────────────────────────
function parseHex(m) {
    const h = m[0].slice(1);
    let r, g, b, a = 1;

    switch (h.length) {
        case 3:
            r = parseInt(h[0] + h[0], 16);
            g = parseInt(h[1] + h[1], 16);
            b = parseInt(h[2] + h[2], 16);
            break;
        case 4:
            r = parseInt(h[0] + h[0], 16);
            g = parseInt(h[1] + h[1], 16);
            b = parseInt(h[2] + h[2], 16);
            a = parseInt(h[3] + h[3], 16) / 255;
            break;
        case 6:
            r = parseInt(h.slice(0, 2), 16);
            g = parseInt(h.slice(2, 4), 16);
            b = parseInt(h.slice(4, 6), 16);
            break;
        case 8:
            r = parseInt(h.slice(0, 2), 16);
            g = parseInt(h.slice(2, 4), 16);
            b = parseInt(h.slice(4, 6), 16);
            a = parseInt(h.slice(6, 8), 16) / 255;
            break;
        default:
            return null;
    }

    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return { r, g, b, a };
}

function parseRgb(m) {
    let r = component(m[1], 255);
    let g = component(m[2], 255);
    let b = component(m[3], 255);
    let a = m[4] ? component(m[4], 1) : 1;

    if (r == null || g == null || b == null) return null;

    r = clamp(Math.round(r), 0, 255);
    g = clamp(Math.round(g), 0, 255);
    b = clamp(Math.round(b), 0, 255);
    a = clamp(a, 0, 1);
    return { r, g, b, a };
}

function parseHsl(m) {
    const h = parseFloat(m[1]) / 360;
    const s = parseFloat(m[2]) / 100;
    const l = parseFloat(m[3]) / 100;
    const a = m[4] ? component(m[4], 1) : 1;

    if (isNaN(h) || isNaN(s) || isNaN(l)) return null;

    const rgb = hslToRgb(h, s, l);
    return { ...rgb, a: clamp(a, 0, 1) };
}

// ── Color math helpers ─────────────────────────────────────────────────────
function component(val, max) {
    if (val == null) return null;
    val = String(val).trim();
    return val.endsWith('%') ? (parseFloat(val) / 100) * max : parseFloat(val);
}

function hslToRgb(h, s, l) {
    if (s === 0) {
        const v = Math.round(l * 255);
        return { r: v, g: v, b: v };
    }

    const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
        r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
        g: Math.round(hue2rgb(p, q, h) * 255),
        b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    };
}

function contrastColor(r, g, b) {
    const toLinear = c => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const lum = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    return lum > 0.179 ? '#000000' : '#ffffff';
}

function hex2(n) { return n.toString(16).padStart(2, '0'); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Exports ────────────────────────────────────────────────────────────────
module.exports = { activate, deactivate };
