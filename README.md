# Shipment Navigator

StimTech Solutions — MVP Build Spec (Lovable)

Build a shipment-tracking web app for small importers/exporters. Skip authentication/login entirely for now — build this as a single-user app with no sign-up flow. Use Supabase for the database only (no auth setup).

Supabase Connection

[PASTE YOUR SUPABASE PROJECT URL AND ANON KEY HERE]

Visual Direction — inspired by Linear.app

Do not default to generic AI-app-builder styling (gradients, glassmorphism, bright saturated colors, heavy shadows, rounded pill buttons everywhere). Instead:

One typeface for everything: Inter, at multiple weights (400, 500, 600, 700) for hierarchy — not multiple font families. Small, dense text (13-15px body), not oversized.

Background: near-white / very light gray (#FAFAFA), not pure white.

Text: very dark charcoal (#1C1C1F), not pure black.

Borders: hairline, 1px, very light gray (#E4E4E7).

One accent color only: deep navy (#14213D) — primary buttons, active states, links. Nothing else competes with it.

Status colors (small, muted pills only, never large color blocks): green (#2F6F4E) positive, amber (#C08A2E) warning, red (#B33A3A) risk/urgent.

Small corner radius (4-6px). Minimal to no shadows — depth from borders and subtle background shifts only.

Tight, efficient spacing. This should feel like a tool professionals use daily — closer to Linear, Stripe's dashboard, or Ramp than a marketing page.

No decorative icons, illustrations, or gradients.

Data Model

shipments

id, client_name, origin, destination, vessel_name (nullable), vessel_mmsi (nullable, text), landed_cost (numeric, nullable), status (Booked / In Transit / At Port / Cleared Customs / Delivered), created_at

documents

id, shipment_id, name, done (boolean)

Screens

1. Dashboard Table of all shipments: ID, client, route, status, landed cost. Click a row to open detail. "New Shipment" button opens a creation form. Status shown as a small muted pill.

2. Shipment Detail

Editable shipment info

Status pipeline: 5 stages in sequence, button to advance one stage at a time

Document checklist, toggleable checkboxes (auto-create the 4 standard documents on shipment creation: Bill of Lading, Commercial Invoice, Certificate of Origin, Packing List)

Delete button

3. Fleet Map

Default state (nothing selected): show MarineTraffic's public live map embed (their embeddable iframe — no API key or account needed), normal global ship traffic visible, centered on the Pacific Coast / North America shipping lanes.

Sidebar: list of active shipments (not yet Delivered). If a shipment has no vessel MMSI saved, show an inline field + save button to add one. If it has one, show a "Track this shipment" button.

Selected state: clicking "Track this shipment" reloads the MarineTraffic embed using that vessel's MMSI so the map centers on and highlights just that one ship. Show a label confirming which shipment/vessel is being tracked, with a "Back to full map" button to return to the default global view.

If a tracked vessel has no current AIS position available, show "No current position data for this vessel" rather than an error.

Match this page to the same design system as the rest of the app.

4. Alerts Simple feed logging status changes as they happen. In-app only, no email.

Not in scope yet

Any login/authentication/user accounts

Payments/billing

Team accounts

Email notifications

Any AIS API besides the MarineTraffic embed (AISstream/AISHub already tested and ruled out — browser-direct connections aren't permitted)

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/82261180-ca97-436d-bacc-172ff59a12bb).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
