# CRC Transport Ministry Application

React 18 + TypeScript + Vite + Tailwind CSS application for the CRC Transport Ministry (Johannesburg).

Production architecture: Static Single Page Application (SPA) hosted on Cloudflare Pages, backed by Supabase for database, authentication, and real-time multi-device sync.

---

## 🚀 Getting Started

### Local Development

For local development or testing in the AI Studio preview environment:

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

3. Start the local development server (Express backend + Vite middleware):
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` to access the application.

---

## 📦 Production Build

To build the static SPA for production:

```bash
npm run build
```

This compiles the static assets into the `dist/` directory. No Node.js server (`server.ts` or `tsx`) is required in production.

To preview the built static bundle locally:
```bash
npm run preview
```

---

## ☁️ Cloudflare Deployment Configuration

### Cloudflare Workers (Static Assets)
The repository is configured for Cloudflare Workers Static Assets via `wrangler.jsonc`:
```jsonc
{
  "name": "crc-transport-app",
  "compatibility_date": "2026-10-01",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  }
}
```

To deploy using Wrangler:
```bash
npx wrangler deploy
```

### Routing and Cache Headers
- SPA routing fallback is handled automatically by Cloudflare Workers Assets (`not_found_handling: "single-page-application"`).
- Custom `Cache-Control` headers for assets, HTML, and media are configured in `public/_headers`.

### Environment Variables
Configure the following environment variables in the Cloudflare Pages Dashboard (**Settings > Environment variables**):

| Variable | Description | Required |
| :--- | :--- | :--- |
| `VITE_SUPABASE_URL` | Supabase project URL (e.g. `https://your-project.supabase.co`) | **Yes** |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous public API key | **Yes** |
| `VITE_GOOGLE_SHEETS_WEBHOOK_URL` | Google Apps Script Web App URL for automated stats sync | Optional |
| `VITE_GOOGLE_SHEETS_SECRET` | Secret token configured in the Google Apps Script Web App | Optional |
| `VITE_GOOGLE_SHEETS_TAB_NAME` | Target Google Sheets tab name for stats (defaults to `Stats`) | Optional |
| `VITE_APPROVAL_SECRET` | Master authorization code for the admin account approval portal | Optional |
| `VITE_RESET_PASSWORD` | Confirmation password for clearing active manifest sessions | Optional |

> **Production Safety Note:** If `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` are missing or unconfigured in a production build, the app will display a prominent top banner: *"Database not connected – changes are NOT being saved. Contact the administrator."* and prevent silent data loss.

---

## 🗄️ Database Migrations

All SQL schema definitions and migrations for Supabase are located in:
```
/supabase/migrations/
```

Available migrations include:
- `20260811075833_create_transport_manifests.sql` — Transport manifests table & indexes
- `20260811092357_create_cancellation_ledger.sql.sql` — Cancellation ledger table & policies
- `20260812044053_add_sponsored_notes_rep_fields_to_ledger.sql` — Rep and sponsorship note extensions
- `20260813015916_add_general_notes_to_ledger.sql` — General notes field on ledger
- `20260923090000_create_sponsorship_audits.sql` — Sponsorship audits and tracking
- `20261007120000_add_legs_to_ledger_and_manifests.sql` — Trip legs support (going / return / both)
- `20261007140000_create_rehearsal_templates.sql` — Thursday rehearsal templates table

Run these migrations via the Supabase Dashboard SQL Editor or using the Supabase CLI (`supabase db push`).
