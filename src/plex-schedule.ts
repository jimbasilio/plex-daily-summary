#!/usr/bin/env node
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

type Args = { date?: string; baseUrl: string; credentialFile: string; timezone: string };
type XmlNode = Record<string, unknown>;
type Recording = { start: Date; end: Date; label: string; channel: string; status: string };

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
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], argument = argv[index + 1];
    if (!argument || !["--date", "--base-url", "--credential-file", "--timezone"].includes(flag)) throw new Error("Usage: plex-schedule [--date YYYY-MM-DD] [--base-url URL] [--credential-file PATH] [--timezone IANA]");
    if (flag === "--date") args.date = argument;
    if (flag === "--base-url") args.baseUrl = argument;
    if (flag === "--credential-file") args.credentialFile = argument;
    if (flag === "--timezone") args.timezone = argument;
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
function recordingLabel(video: XmlNode): string {
  const show = value(video, "grandparentTitle").trim(), title = value(video, "title").trim(), season = value(video, "parentIndex"), episode = value(video, "index");
  if (!show) return title || "Untitled recording";
  const details: string[] = [];
  if (/^\d+$/.test(season) && /^\d+$/.test(episode)) details.push(`S${season.padStart(2, "0")}E${episode.padStart(2, "0")}`);
  if (title && title.toLowerCase() !== show.toLowerCase()) details.push(title);
  return details.length ? `${show} — ${details.join(" · ")}` : show;
}
async function recordings(args: Args): Promise<Recording[]> {
  const token = (await readFile(args.credentialFile, "utf8")).trim();
  if (!token) throw new Error("Plex credential file is empty");
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
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2)); if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error("--date must use YYYY-MM-DD");
  const scheduled = await recordings(args), date = args.date ? new Date(`${args.date}T12:00:00Z`) : new Date();
  console.log(`📺 Plex recordings for ${displayDate(date, args.timezone)}`);
  if (!scheduled.length) { console.log("No recordings scheduled today."); return; }
  for (const recording of scheduled) console.log(`• ${displayTime(recording.start, args.timezone)}–${displayTime(recording.end, args.timezone)} — ${recording.label}${recording.channel ? ` · Ch. ${recording.channel}` : ""}${recording.status === "recording" ? " · Recording now" : ""}`);
}
main().catch((error: unknown) => { console.error(`Plex schedule unavailable: ${error instanceof Error ? error.message : "unknown error"}`); process.exitCode = 1; });
