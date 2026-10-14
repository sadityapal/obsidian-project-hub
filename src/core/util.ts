// Pure helpers with no Obsidian dependency, so they can be unit tested under node.

const DAY_MS = 86_400_000;

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d: Date = new Date()): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function today(): string {
	return isoDate(new Date());
}

/** Parses YYYY-MM-DD (or an ISO datetime) into a local-midnight Date. Returns null for anything else. */
export function parseDate(value: unknown): Date | null {
	if (value instanceof Date) return isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate());
	if (typeof value !== "string") return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
	if (!m) return null;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return isNaN(d.getTime()) ? null : d;
}

/** Normalises any date-ish input to YYYY-MM-DD, or null. */
export function normDate(value: unknown): string | null {
	const d = parseDate(value);
	return d ? isoDate(d) : null;
}

/** ADO returns UTC datetimes; a date-only field is midnight UTC, so read the UTC calendar date. */
export function adoDateToLocal(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	const d = new Date(value);
	if (isNaN(d.getTime())) return normDate(value);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function localDateToAdo(value: string | null): string | null {
	return value ? `${value}T00:00:00Z` : null;
}

export function addDays(date: string, days: number): string {
	const d = parseDate(date);
	if (!d) throw new Error(`Invalid date: ${date}`);
	d.setDate(d.getDate() + days);
	return isoDate(d);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
	const da = parseDate(a);
	const db = parseDate(b);
	if (!da || !db) return NaN;
	return Math.round((db.getTime() - da.getTime()) / DAY_MS);
}

export function dateRange(start: string, end: string): string[] {
	const out: string[] = [];
	const n = daysBetween(start, end);
	for (let i = 0; i <= n; i++) out.push(addDays(start, i));
	return out;
}

export function isWeekend(date: string): boolean {
	const d = parseDate(date);
	if (!d) return false;
	const day = d.getDay();
	return day === 0 || day === 6;
}

/** Monday-based start of the week containing date. */
export function startOfWeek(date: string): string {
	const d = parseDate(date)!;
	const shift = (d.getDay() + 6) % 7;
	return addDays(date, -shift);
}

export function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

/** Characters Obsidian rejects in file names, plus link-breaking ones. */
const BAD_FILENAME = /[\\/:*?"<>|#^[\]]/g;

export function sanitizeFilename(name: string, maxLength = 120): string {
	let out = name.replace(BAD_FILENAME, " ").replace(/\s+/g, " ").trim();
	out = out.replace(/^\.+/, "").replace(/[. ]+$/, "");
	if (out.length > maxLength) out = out.slice(0, maxLength).replace(/[. ]+$/, "");
	return out || "Untitled";
}

/** Builds "<id> <title>" and keeps it file-system safe. */
export function itemFileBase(id: string, title: string): string {
	return sanitizeFilename(`${id} ${title}`.trim());
}

/** Splits a basename like "PH-12 Fix login" into id and title when it starts with the id. */
export function splitItemBase(basename: string, id: string): string | null {
	if (!id) return null;
	if (basename === id) return "";
	if (basename.startsWith(id + " ")) return basename.slice(id.length + 1).trim();
	return null;
}

const LINK_RE = /^\s*!?\[\[([^\]|#^]*)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]\s*$/;

/** Extracts the link path (and alias) from a wikilink string. Plain strings return null. */
export function parseWikilink(value: unknown): { path: string; alias: string | null } | null {
	if (typeof value !== "string") return null;
	const m = LINK_RE.exec(value);
	if (!m) return null;
	return { path: m[1].trim(), alias: m[2]?.trim() || null };
}

export function asString(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value.trim() === "" ? null : value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.length ? asString(value[0]) : null;
	return null;
}

export function asNumber(value: unknown): number | null {
	if (typeof value === "number") return isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value.trim().replace(/^P/i, ""));
		return isFinite(n) ? n : null;
	}
	return null;
}

export function asList(value: unknown): string[] {
	if (value === null || value === undefined || value === "") return [];
	if (Array.isArray(value)) return value.map((v) => asString(v)).filter((v): v is string => !!v);
	const s = asString(value);
	return s ? [s] : [];
}

export function asBool(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return /^(true|yes|1)$/i.test(value.trim());
	if (typeof value === "number") return value !== 0;
	return false;
}

/** FNV-1a, 32-bit. Used to remember large synced values (descriptions) without storing them. */
export function hash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export function sum(values: number[]): number {
	let s = 0;
	for (const v of values) s += v;
	return s;
}

export function median(values: number[]): number | null {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(values: number[], p: number): number | null {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const idx = clamp(Math.ceil((p / 100) * s.length) - 1, 0, s.length - 1);
	return s[idx];
}

export function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
	const out = new Map<K, T[]>();
	for (const it of items) {
		const k = key(it);
		const arr = out.get(k);
		if (arr) arr.push(it);
		else out.set(k, [it]);
	}
	return out;
}

export function shallowEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
	if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
	return false;
}

export function formatNumber(n: number | null | undefined, digits = 0): string {
	if (n === null || n === undefined || !isFinite(n)) return "–";
	return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function plural(n: number, word: string, pluralWord = word + "s"): string {
	return `${n} ${n === 1 ? word : pluralWord}`;
}
