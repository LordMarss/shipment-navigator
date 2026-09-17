/**
 * Pure geographic math shared by anything that needs "how far apart are
 * these two points" — currently just the destination-geofence check in
 * aisAutomation.ts. No business logic here, no imports from the rest of
 * the app, deliberately trivial to unit test.
 */

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two lat/lon points, in kilometers. */
export function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}
