#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

type Args = { date?: string; baseUrl: string; credentialFile: string; timezone: string; tautulliUrl: string; tautulliConfigFile: string };
type XmlNode = Record<string, unknown>;
type Recording = { start: Date; end: Date; label: string; channel: string; status: string };
type TautulliHistoryItem = { full_title?: string; friendly_name?: string; user?: string; duration?: number | string };
type PlexItem = { title: string; show: string; addedAt: number };

function value(node: XmlNode, key: string): string {
  const candidate = node[`@_${key}`];
  return typeof candidate === "string" ? candidate : "";
}
function list(value: unknown): XmlNode[] { return Array.isArray(value) ? value.filter((item): item is XmlNode => typeof item === "object" && item !== null) : typeof value === "object" && value !== null ? [value as XmlNode] : []; }
function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseUrl: process.env.PLEX_BASE_URL?.trim() || "http://127.0.0.1:32400",
    credentialFile: process.env.PLEX_CREDENTIAL_FILE?.trim() || "",
    timezone: process.env.PLEX_TIMEZONE?.trim() || "America/New_York",
    tautulliUrl: process.env.TAUTULLI_BASE_URL?.trim() || "http://127.0.0.1:8181",
    tautulliConfigFile: process.env.TAUTULLI_CONFIG_FILE?.trim() || "/home/jim/.openclaw/workspace/tautulli/config/config.ini",
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], argument = argv[index + 1];
    if (!argument || !["--date", "--base-url", "--credential-file", "--timezone", "--tautulli-url", "--tautulli-config-file"].includes(flag)) throw new Error("Usage: plex-schedule [--date YYYY-MM-DD] [--base-url URL] [--credential-file PATH] [--timezone IANA]");
    if (flag === "--date") args.date = argument;
    if (flag === "--base-url") args.baseUrl = argument;
    if (flag === "--credential-file") args.credentialFile = argument;
    if (flag === "--timezone") args.timezone = argument;
    if (flag === "--tautulli-url") args.tautulliUrl = argument;
    if (flag === "--tautulli-config-file") args.tautulliConfigFile = argument;
  }
  if (!args.credentialFile) throw new Error("PLEX_CREDENTIAL_FILE must be set in .env or the environment");
  return args;
}
function localDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (name: string) => parts.find((item) => item.type === name)?.value;
  const year = part("year"), month = part("month"), day = part("day");
  if (!year || !month || !day) throw new Error("Unable to derive local Plex schedule date");
  return `${year}-${month}-${day}`;
}
function displayDate(date: Date, timezone: string): string { return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" }).format(date); }
function displayTime(date: Date, timezone: string): string { return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(date); }
function shiftDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function formatDuration(value: number | string | undefined): string {
  const seconds = typeof value === "number" ? value : Number.parseInt(value || "", 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function recordingLabel(video: XmlNode): string {
  const show = value(video, "grandparentTitle").trim(), title = value(video, "title").trim(), season = value(video, "parentIndex"), episode = value(video, "index");
  if (!show) return title || "Untitled recording";
  const details: string[] = [];
  if (/^\d+$/.test(season) && /^\d+$/.test(episode)) details.push(`S${season.padStart(2, "0")}E${episode.padStart(2, "0")}`);
  if (title && title.toLowerCase() !== show.toLowerCase()) details.push(title);
  return details.length ? `${show} — ${details.join(" · ")}` : show;
}
async function recordings(args: Args): Promise<Recording[]> {
  const token = await plexToken(args);
  const response = await fetch(`${args.baseUrl.replace(/\/$/, "")}/media/subscriptions/scheduled`, { headers: { "X-Plex-Token": token, Accept: "application/xml" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Plex schedule request failed (${response.status})`);
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(await response.text()) as { MediaContainer?: XmlNode };
  const targetDate = args.date ?? localDate(new Date(), args.timezone), output: Recording[] = [], seen = new Set<string>();
  for (const operation of list(xml.MediaContainer?.MediaGrabOperation)) {
    const status = value(operation, "status"); if (!["scheduled", "recording"].includes(status)) continue;
    const video = list(operation.Video)[0]; if (!video) continue;
    const media = list(video.Media); if (!media.length) continue;
    const mediaIndex = Number.parseInt(value(operation, "mediaIndex"), 10); const selected = Number.isInteger(mediaIndex) && media[mediaIndex] ? media[mediaIndex] : media[0];
    const beginsAt = Number.parseInt(value(selected, "beginsAt"), 10), endsAt = Number.parseInt(value(selected, "endsAt"), 10); if (!Number.isFinite(beginsAt) || !Number.isFinite(endsAt)) continue;
    const start = new Date(beginsAt * 1000), end = new Date(endsAt * 1000); if (localDate(start, args.timezone) !== targetDate) continue;
    const label = recordingLabel(video), channel = value(selected, "channelVcn") || value(selected, "channelCallSign"), key = `${beginsAt}|${label}|${channel}`; if (seen.has(key)) continue;
    seen.add(key); output.push({ start, end, label, channel, status });
  }
  return output.sort((a, b) => a.start.getTime() - b.start.getTime() || a.label.localeCompare(b.label));
}
async function plexToken(args: Args): Promise<string> {
  const token = (await readFile(args.credentialFile, "utf8")).trim();
  if (!token) throw new Error("Plex credential file is empty");
  return token;
}
async function plexXml(args: Args, path: string): Promise<XmlNode> {
  const token = await plexToken(args);
  const response = await fetch(`${args.baseUrl.replace(/\/$/, "")}${path}`, { headers: { "X-Plex-Token": token, Accept: "application/xml" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Plex request failed (${response.status})`);
  return (new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(await response.text()) as { MediaContainer?: XmlNode }).MediaContainer || {};
}
async function recentlyAdded(args: Args, targetDate: string): Promise<PlexItem[]> {
  const xml = await plexXml(args, "/library/recentlyAdded?limit=100");
  return list(xml.Metadata).map((item) => {
    const addedAt = Number.parseInt(value(item, "addedAt"), 10);
    return { title: value(item, "title") || "Untitled", show: value(item, "grandparentTitle"), addedAt };
  }).filter((item) => Number.isFinite(item.addedAt) && localDate(new Date(item.addedAt * 1000), args.timezone) === targetDate);
}
async function activeStreams(args: Args): Promise<PlexItem[]> {
  const xml = await plexXml(args, "/status/sessions");
  return list(xml.Video).map((item) => ({ title: value(item, "title") || "Untitled", show: value(item, "grandparentTitle"), addedAt: 0 }));
}
async function tautulliHistory(args: Args, targetDate: string): Promise<TautulliHistoryItem[]> {
  const config = await readFile(args.tautulliConfigFile, "utf8");
  const enabled = /^api_enabled\s*=\s*1\s*$/m.test(config);
  const apiKey = config.match(/^api_key\s*=\s*(\S+)\s*$/m)?.[1] || "";
  if (!enabled || !apiKey) throw new Error("Tautulli API is not configured");
  const query = new URLSearchParams({ apikey: apiKey, cmd: "get_history", start_date: targetDate, length: "100", order_column: "date", order_dir: "asc" });
  const response = await fetch(`${args.tautulliUrl.replace(/\/$/, "")}/api/v2?${query}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Tautulli history request failed (${response.status})`);
  const payload = await response.json() as { response?: { result?: string; data?: { data?: TautulliHistoryItem[] } } };
  if (payload.response?.result !== "success") throw new Error("Tautulli history request failed");
  return payload.response.data?.data || [];
}
function historyLabel(item: TautulliHistoryItem): string {
  const title = item.full_title || item.friendly_name || "Untitled playback";
  const details = [item.user, formatDuration(item.duration)].filter(Boolean);
  return details.length ? `${title} — ${details.join(" · ")}` : title;
}
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2)); if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("--date must use YYYY-MM-DD");
  const targetDate = args.date ?? localDate(new Date(), args.timezone), scheduled = await recordings(args), date = new Date(`${targetDate}T12:00:00Z`);
  console.log(`📺 Plex Daily Brief — ${displayDate(date, args.timezone)}`);
  console.log("");
  const previousDate = shiftDate(targetDate, -1);
  try {
    const history = await tautulliHistory(args, previousDate);
    console.log(`▶ Watched on ${displayDate(new Date(`${previousDate}T12:00:00Z`), args.timezone)}`);
    if (history.length) for (const item of history) console.log(`• ${historyLabel(item)}`);
    else console.log("No playback history recorded.");
  } catch (error: unknown) {
    console.log(`▶ Watched yesterday unavailable: ${error instanceof Error ? error.message : "Tautulli unavailable"}`);
  }
  console.log("");
  console.log("🧹 Cleanup");
  console.log("• No deleted/cleaned-up items detected");
  console.log("• Deletion history is not being tracked yet");
  console.log("");
  try {
    const added = await recentlyAdded(args, targetDate);
    console.log("➕ Newly added");
    if (added.length) for (const item of added) console.log(`• ${item.show ? `${item.show} — ` : ""}${item.title}`);
    else console.log("• Nothing added today");
  } catch (error: unknown) {
    console.log(`➕ Newly added unavailable: ${error instanceof Error ? error.message : "Plex unavailable"}`);
  }
  console.log("");
  try {
    const streams = await activeStreams(args);
    console.log("📡 Plex status");
    console.log(`• ${streams.length} active stream${streams.length === 1 ? "" : "s"}`);
    for (const stream of streams) console.log(`• ${stream.show ? `${stream.show} — ` : ""}${stream.title}`);
  } catch (error: unknown) {
    console.log(`📡 Plex status unavailable: ${error instanceof Error ? error.message : "Plex unavailable"}`);
  }
  console.log("");
  console.log("⏺️ DVR today");
  if (!scheduled.length) { console.log("• No recordings scheduled today."); return; }
  for (const recording of scheduled) console.log(`• ${displayTime(recording.start, args.timezone)}–${displayTime(recording.end, args.timezone)} — ${recording.label}${recording.channel ? ` · Ch. ${recording.channel}` : ""}${recording.status === "recording" ? " · Recording now" : ""}`);
}
main().catch((error: unknown) => { console.error(`Plex schedule unavailable: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; });
