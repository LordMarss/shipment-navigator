/**
 * Phase 1 AIS ingestion worker — standalone, long-running Node process.
 *
 * NOT part of the app bundle: nothing under src/ imports this file, and it
 * is never built by Vite, so AISSTREAM_API_KEY can never reach the browser.
 *
 * Vercel serverless functions cannot hold a persistent outbound WebSocket
 * open (they run per-request and are torn down), so this worker is designed
 * to run as its own always-on process, independent of the Vercel deployment:
 *   node --env-file=.env scripts/ais-listener.ts
 *
 * It connects to AISStream.io's WebSocket API, subscribes only to the MMSIs
 * of shipments we still care about (anything not in a legacy/retired
 * status), and upserts the latest known position per vessel into
 * `vessel_positions` — one row per MMSI, never an unbounded message log.
 */
import { createClient } from "@supabase/supabase-js";

const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";

// Mirrors LEGACY_STATUSES in src/lib/api.ts. Duplicated (not imported) so
// this script has zero dependency on the app's path-aliased module graph —
// it only needs to run with plain Node, not the Vite/TanStack toolchain.
const LEGACY_STATUSES = ["At Port", "Cleared Customs", "Delivered"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const AISSTREAM_API_KEY = requireEnv("AISSTREAM_API_KEY");

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** MMSIs belonging to shipments we still actively track (excludes legacy/retired statuses). */
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

async function handleMessage(raw: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[ais] failed to parse message:", raw.slice(0, 200));
    return;
  }

  if (parsed.error) {
    console.error("[ais] server reported an error:", parsed.error);
    return;
  }

  console.log(`[ais] received message type: ${String(parsed.MessageType)}`);
  if (parsed.MessageType !== "PositionReport") return;

  const metaData = parsed.MetaData as Record<string, unknown> | undefined;
  const message = parsed.Message as Record<string, unknown> | undefined;
  const report = message?.PositionReport as PositionReport | undefined;
  const mmsi = String(metaData?.MMSI ?? (report as unknown as { UserID?: number })?.UserID ?? "");
  const positionTimestamp = parseAisTimestamp(metaData?.time_utc as string | undefined);
  const vesselName = (metaData?.ShipName as string | undefined)?.trim() || null;

  if (!mmsi || !report) {
    console.error("[ais] PositionReport missing MMSI or report body:", JSON.stringify(parsed).slice(0, 300));
    return;
  }

  console.log(
    `[ais] position for MMSI ${mmsi}${vesselName ? ` (${vesselName})` : ""}: lat=${report.Latitude} lon=${report.Longitude} sog=${report.Sog}`,
  );

  try {
    await upsertPosition(mmsi, vesselName, report, positionTimestamp);
    console.log(`[ais] persisted position for MMSI ${mmsi} in vessel_positions`);
  } catch (err) {
    console.error(`[ais] failed to persist position for MMSI ${mmsi}:`, err);
  }
}

async function main() {
  const mmsis = await monitoredMmsis();
  if (mmsis.length === 0) {
    console.error("[ais] no monitored MMSIs found in shipments — nothing to subscribe to. Exiting.");
    return;
  }
  console.log(`[ais] subscribing to ${mmsis.length} MMSI(s): ${mmsis.join(", ")}`);

  const socket = new WebSocket(AISSTREAM_URL);

  socket.addEventListener("open", () => {
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
    socket.send(JSON.stringify(subscription));
    console.log("[ais] subscription request sent, waiting for messages...");
  });

  socket.addEventListener("message", (event) => {
    void decodeMessageData(event.data).then(handleMessage);
  });

  socket.addEventListener("error", (event) => {
    console.error("[ais] socket error:", event);
  });

  socket.addEventListener("close", (event) => {
    console.log(`[ais] socket closed: code=${event.code} reason=${event.reason || "(none)"}`);
  });
}

main().catch((err) => {
  console.error("[ais] fatal error:", err);
  process.exitCode = 1;
});
