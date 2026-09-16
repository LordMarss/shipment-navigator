/**
 * AIS ingestion worker — standalone, long-running Node process.
 *
 * NOT part of the app bundle: nothing under src/ imports this file, and it
 * is never built by Vite, so AISSTREAM_API_KEY can never reach the browser.
 *
 * Vercel serverless functions cannot hold a persistent outbound WebSocket
 * open (they run per-request and are torn down), so this worker is designed
 * to run as its own always-on process, independent of the Vercel deployment:
 *   node --env-file=.env scripts/ais-listener.ts
 *   npm run ais:listen
 *
 * Responsibility is deliberately narrow: receive AIS messages, decode them,
 * validate them, and upsert the latest known position per vessel into
 * `vessel_positions` — one row per MMSI, never an unbounded message log.
 * It subscribes only to the MMSIs of shipments still worth tracking
 * (anything not in a legacy/retired status, deduplicated), and periodically
 * re-reads the shipments table to keep that subscription current as
 * shipments are added, removed, or reassigned — no restart or code change
 * needed to pick up normal shipment-list changes.
 *
 * This worker contains NO shipment status/business logic. It only persists
 * AIS facts; deciding what a shipment's status should become from those
 * facts is `src/lib/aisAutomation.ts`'s job, triggered by a separate
 * process (see that module's docs for the intended integration point).
 */
import { createClient } from "@supabase/supabase-js";

const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const AISSTREAM_API_KEY = requireEnv("AISSTREAM_API_KEY");

/** How often to re-read the shipments table for MMSI changes. */
const RESYNC_INTERVAL_MS = intEnv("AIS_RESYNC_INTERVAL_MS", 5 * 60_000);
/** Base delay before the first reconnect attempt after an unexpected drop. */
const RECONNECT_BASE_DELAY_MS = intEnv("AIS_RECONNECT_DELAY_MS", 5_000);
/** How long to wait for a connection to open before giving up and retrying. */
const CONNECT_TIMEOUT_MS = intEnv("AIS_CONNECT_TIMEOUT_MS", 10_000);
/** Upper bound for reconnect backoff, regardless of how many attempts have failed. */
const RECONNECT_MAX_DELAY_MS = 5 * 60_000;

// Mirrors LEGACY_STATUSES in src/lib/api.ts. Duplicated (not imported) so
// this script has zero dependency on the app's path-aliased module graph —
// it only needs to run with plain Node, not the Vite/TanStack toolchain.
const LEGACY_STATUSES = ["At Port", "Cleared Customs", "Delivered"];

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** MMSIs belonging to shipments we still actively track (excludes legacy/retired statuses), deduplicated. */
async function monitoredMmsis(): Promise<string[]> {
  const { data, error } = await db.from("shipments").select("vessel_mmsi, status");
  if (error) throw error;
  const mmsis = (data ?? [])
    .filter((s) => s.vessel_mmsi && !LEGACY_STATUSES.includes(s.status))
    .map((s) => String(s.vessel_mmsi));
  return Array.from(new Set(mmsis));
}

type PositionReport = {
  Latitude: number;
  Longitude: number;
  Sog?: number;
  Cog?: number;
  TrueHeading?: number;
  NavigationalStatus?: number;
};

function isValidPositionReport(report: unknown): report is PositionReport {
  if (!report || typeof report !== "object") return false;
  const r = report as Record<string, unknown>;
  return (
    typeof r.Latitude === "number" &&
    Number.isFinite(r.Latitude) &&
    Math.abs(r.Latitude) <= 90 &&
    typeof r.Longitude === "number" &&
    Number.isFinite(r.Longitude) &&
    Math.abs(r.Longitude) <= 180
  );
}

async function upsertPosition(mmsi: string, vesselName: string | null, report: PositionReport, positionTimestamp: string) {
  const { error } = await db.from("vessel_positions").upsert(
    {
      mmsi,
      vessel_name: vesselName,
      latitude: report.Latitude,
      longitude: report.Longitude,
      sog: report.Sog ?? null,
      cog: report.Cog ?? null,
      true_heading: report.TrueHeading ?? null,
      nav_status: report.NavigationalStatus != null ? String(report.NavigationalStatus) : null,
      position_timestamp: positionTimestamp,
      received_at: new Date().toISOString(),
      source: "aisstream",
    },
    { onConflict: "mmsi" },
  );
  if (error) throw error;
}

// AISStream sends its JSON payload as binary WebSocket frames, which
// Node's WebSocket implementation (per spec — binary frames use
// binaryType, defaulted to "blob") hands to us as a Blob rather than
// a string.
async function decodeMessageData(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return String(data);
}

// AISStream's MetaData.time_utc is a Go-formatted string, e.g.
// "2026-09-15 23:33:19.064769432 +0000 UTC" — not ISO 8601, so Postgres
// rejects it verbatim. JS Date parses it correctly; we just re-render it.
function parseAisTimestamp(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

async function handlePositionReport(parsed: Record<string, unknown>): Promise<void> {
  const metaData = parsed.MetaData as Record<string, unknown> | undefined;
  const message = parsed.Message as Record<string, unknown> | undefined;
  const report = message?.PositionReport;
  const mmsi = String(metaData?.MMSI ?? (report as { UserID?: number } | undefined)?.UserID ?? "");
  const vesselName = (metaData?.ShipName as string | undefined)?.trim() || null;

  if (!mmsi || !isValidPositionReport(report)) {
    console.warn("[ais] malformed message ignored: missing MMSI or invalid position fields");
    return;
  }

  const positionTimestamp = parseAisTimestamp(metaData?.time_utc as string | undefined);

  try {
    await upsertPosition(mmsi, vesselName, report, positionTimestamp);
    console.log(
      `[ais] vessel position persisted — MMSI ${mmsi}${vesselName ? ` (${vesselName})` : ""}: lat=${report.Latitude} lon=${report.Longitude} sog=${report.Sog ?? "?"}`,
    );
  } catch (err) {
    // A single failed write must never take the worker down — log and move on.
    console.error(`[ais] database persistence error for MMSI ${mmsi}:`, err);
  }
}

async function handleMessage(raw: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[ais] malformed message ignored: invalid JSON");
    return;
  }

  if (parsed && typeof parsed === "object" && "error" in parsed) {
    console.error("[ais] AISStream reported a subscription error:", (parsed as { error: unknown }).error);
    return;
  }

  switch (parsed.MessageType) {
    case "SubscriptionConfirmation":
      console.log("[ais] AIS subscription confirmed");
      return;
    case "PositionReport":
      await handlePositionReport(parsed);
      return;
    default:
      // FilterMessageTypes already restricts the feed to PositionReport, so
      // anything else here is unexpected but harmless — skip quietly rather
      // than treating it as an error.
      return;
  }
}

/** True when both lists contain exactly the same MMSIs, order ignored. */
function sameMmsis(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// --- Connection state -------------------------------------------------
// Tracked at module scope so the resync loop, the reconnect path, and
// shutdown can all coordinate through a single source of truth and never
// end up with two live sockets or two pending reconnect timers at once.
let socket: WebSocket | null = null;
let subscribedMmsis: string[] = [];
let connectTimeoutTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let resyncTimer: NodeJS.Timeout | null = null;
let resyncInFlight = false;
let shuttingDown = false;

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  const backoff = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt, RECONNECT_MAX_DELAY_MS);
  // +/-20% jitter so a fleet of workers (or repeated failures) don't all
  // retry in lockstep against AISStream.
  const delay = Math.round(backoff * (0.8 + Math.random() * 0.4));
  reconnectAttempt += 1;
  console.log(`[ais] reconnect scheduled in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void monitoredMmsis()
      .then((mmsis) => openConnection(mmsis))
      .catch((err) => {
        console.error("[ais] failed to read shipments before reconnecting:", err);
        scheduleReconnect();
      });
  }, delay);
}

function openConnection(mmsis: string[]) {
  if (shuttingDown) return;
  clearReconnectTimer();

  subscribedMmsis = mmsis;
  console.log(`[ais] WebSocket connecting — ${mmsis.length} MMSI(s): ${mmsis.join(", ") || "(none)"}`);

  const ws = new WebSocket(AISSTREAM_URL);
  socket = ws;

  connectTimeoutTimer = setTimeout(() => {
    if (socket !== ws) return;
    console.error(`[ais] connection attempt timed out after ${CONNECT_TIMEOUT_MS / 1000}s`);
    ws.close();
  }, CONNECT_TIMEOUT_MS);

  ws.addEventListener("open", () => {
    if (connectTimeoutTimer) {
      clearTimeout(connectTimeoutTimer);
      connectTimeoutTimer = null;
    }
    reconnectAttempt = 0; // a successful connection proves the network path is healthy again
    console.log("[ais] WebSocket connected");

    const subscription = {
      APIKey: AISSTREAM_API_KEY,
      // Worldwide box — narrowing happens via FiltersShipMMSI, not geography.
      BoundingBoxes: [
        [
          [-90, -180],
          [90, 180],
        ],
      ],
      FiltersShipMMSI: mmsis,
      FilterMessageTypes: ["PositionReport"],
    };
    ws.send(JSON.stringify(subscription));
    console.log("[ais] subscription request sent, awaiting confirmation...");
  });

  ws.addEventListener("message", (event) => {
    decodeMessageData(event.data)
      .then(handleMessage)
      .catch((err) => {
        // Defense in depth: handleMessage already catches what it expects
        // to fail, but nothing here may ever become an unhandled rejection
        // — that would crash the whole worker over one bad message.
        console.error("[ais] unexpected error while processing a message:", err);
      });
  });

  ws.addEventListener("error", (event) => {
    console.error("[ais] WebSocket error:", (event as { message?: string }).message ?? event);
  });

  ws.addEventListener("close", (event) => {
    if (connectTimeoutTimer) {
      clearTimeout(connectTimeoutTimer);
      connectTimeoutTimer = null;
    }
    console.log(`[ais] socket closed: code=${event.code} reason=${event.reason || "(none)"}`);
    // `socket` already points elsewhere if this close is the tail end of a
    // resync- or reconnect-triggered replacement (openConnection reassigns
    // it synchronously before the old socket's close event fires) — that
    // case is already handled, nothing more to do here.
    if (socket !== ws) return;
    socket = null;
    if (shuttingDown) return;
    scheduleReconnect();
  });
}

/** Periodically re-reads the shipments table and reconnects if the monitored MMSI set changed. */
function startResyncLoop() {
  resyncTimer = setInterval(() => {
    if (resyncInFlight) {
      // A previous tick is still running (e.g. a slow query) — skip this
      // one rather than risk two overlapping reconnects racing each other.
      return;
    }
    resyncInFlight = true;
    void (async () => {
      try {
        const latest = await monitoredMmsis();
        if (sameMmsis(latest, subscribedMmsis)) return;

        console.log(
          `[ais] subscription set changed (was: [${subscribedMmsis.join(", ") || "none"}], now: [${latest.join(", ") || "none"}]) — reconnecting`,
        );
        clearReconnectTimer();
        socket?.close();
        socket = null;
        if (latest.length === 0) {
          console.log("[ais] no monitored MMSIs remain — waiting for a shipment to appear");
          subscribedMmsis = [];
          return;
        }
        openConnection(latest);
      } catch (err) {
        console.error("[ais] failed to refresh monitored MMSIs:", err);
      } finally {
        resyncInFlight = false;
      }
    })();
  }, RESYNC_INTERVAL_MS);
}

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ais] received ${signal} — shutting down gracefully`);

  if (resyncTimer) clearInterval(resyncTimer);
  clearReconnectTimer();
  if (connectTimeoutTimer) clearTimeout(connectTimeoutTimer);

  if (socket) {
    socket.close(1000, "worker shutting down");
    socket = null;
  }

  console.log("[ais] shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Defense in depth: an unexpected rejection or exception anywhere in this
// worker must be logged, never silently crash a process that's supposed to
// run indefinitely. Never include the raw error's message when it might
// echo back request internals — Node's own error objects here don't carry
// secrets (env vars are read once into module-scope constants, never
// logged), so logging the error as-is is safe.
process.on("unhandledRejection", (err) => {
  console.error("[ais] unhandled rejection (worker continues running):", err);
});
process.on("uncaughtException", (err) => {
  console.error("[ais] uncaught exception (worker continues running):", err);
});

async function main() {
  console.log(
    `[ais] worker starting — resync every ${RESYNC_INTERVAL_MS / 1000}s, reconnect base delay ${RECONNECT_BASE_DELAY_MS / 1000}s, connect timeout ${CONNECT_TIMEOUT_MS / 1000}s`,
  );
  const mmsis = await monitoredMmsis();
  console.log(`[ais] ${mmsis.length} active shipment MMSI(s) discovered`);
  if (mmsis.length === 0) {
    console.log(`[ais] nothing to subscribe to yet — checking again every ${RESYNC_INTERVAL_MS / 1000}s`);
  } else {
    openConnection(mmsis);
  }
  startResyncLoop();
}

main().catch((err) => {
  console.error("[ais] fatal error during startup:", err);
  process.exitCode = 1;
});
