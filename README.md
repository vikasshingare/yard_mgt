# Yardwise — ICD Yard Management System

Shared React Native application for web, Android and iOS (Expo SDK 58), with a Node.js/Express API and MySQL 8 database. The MVP includes authentication and role permissions, inventory, yard map, gate visits, slot reservation, movement tasks, holds, audit events and barcode/QR scanning. Photo evidence and external integrations remain later phases.

## Start the web app

From this folder:

```powershell
npm run start:web
```

Expo prints a local URL (usually `http://localhost:8081`). The API and database must be running, and an application user must be created before signing in.

## Set up MySQL and the API

Oracle MySQL 8.4 is installed. XAMPP already uses `localhost:3306`, so the YMS runs its own MySQL data directory on `localhost:3307` and leaves XAMPP's database in place. Initialize MySQL, create the project database and start the API with:

```powershell
npm run db:start
npm run user:create
npm run api
```

`db:start` starts the dedicated MySQL 8.4 server, generates a root password on first setup, and stores the local connection details in the ignored `server/.env` file. Keep it private. `server/database/schema.sql` creates `icd_yms` and loads the demonstration yard and inventory.

`user:create` interactively creates your first System Administrator or other role account. Password input is hidden in the terminal. Create at least one System Administrator before opening the web or mobile client. Sign in with the account you created; there are no default application credentials.

## Authentication and permissions

The API uses scrypt password hashes, 15-minute signed access tokens, rotating 14-day refresh tokens stored as hashes, explicit logout/session revocation, password changes and one-time 30-minute password-reset tokens. Disabled accounts and expired or revoked sessions are rejected server-side. Repeated failures trigger a temporary account lock and source-IP throttling. Operational routes check permissions against the user's role on every request.

The nine requested roles and their permission grants are seeded in MySQL. System Administrators can create/deactivate accounts, assign roles and edit permission grants under **User management**. Users created from that screen must change their temporary password at first sign-in. The mobile app stores refresh tokens in Expo SecureStore; the web client stores them in session-scoped browser storage and holds access tokens in memory. The compact mobile bar includes Home, Inventory, Tasks, Scan and More; available screens are filtered by role.

Password reset currently creates a one-time token and logs it to the API console in development. Configure an email delivery provider before using self-service password reset outside local development. MFA and enterprise SSO are not enabled; add an identity provider before representing either as available.

`server/database/schema.sql` is the base portable database file. It creates `icd_yms`, operational tables, yard slots, and sample container/task data. `npm run db:setup` applies the idempotent domain migrations as well. If applying the SQL file directly, then run `npm run db:migrate` to add the container, document, depot, master-data, manifest/approval, and reconciliation tables and permissions.

The web client uses `http://localhost:4000/api` by default. For phones on the same Wi-Fi, the root `.env` must point `EXPO_PUBLIC_API_URL` to `http://<development-computer-LAN-IP>:4000/api` (already set to this computer's current LAN address). With the web app using port 8081, start the mobile bundler on 8082:

```powershell
npm run start:mobile -- --port 8082
```

Scan the terminal QR code using the Expo Go version for SDK 58. Allow Node.js through Windows Firewall on the Private network if the phone cannot reach the API.

## Scripts

- `npm run start:web` — run the web app
- `npm run start:mobile` — run Expo for Android/iOS
- `npm run api` — run the API in watch mode
- `npm run user:create` — securely create an initial application account (run after database setup)
- `npm run user:seed-roles` — create one-time, password-change-required local accounts for each of the nine roles
- `npm run db:start` — start local MySQL 8.4 and create/load the database
- `npm run db:setup` — reload/create the database using the saved local connection
- `npm run db:migrate` — idempotently apply domain module migrations
- `npm run build:web` — export a static web build to `dist/`

## API routes

- `GET /api/health`, `GET /api/dashboard` (database KPIs, filters, activities and alerts; refreshes in the client every 30 seconds)
- `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me`
- `POST /api/auth/password/change`, `POST /api/auth/password-reset/request`, `POST /api/auth/password-reset/complete`
- `GET /api/admin/users`, `POST /api/admin/users`, `PATCH /api/admin/users/:id/status`, `PATCH /api/admin/users/:id/role`
- `GET /api/admin/roles`, `GET /api/admin/permissions`, `PUT /api/admin/roles/:role/permissions`, `GET /api/admin/login-history`
- `GET/POST /api/containers`, `GET/PUT /api/containers/:id`, `/api/containers/import.csv`, `/api/containers/export.csv`, container history/documents/hold routes
- `GET/POST/PUT /api/manifests`, manifest container-line and CSV routes, and audited unexpected-arrival exception request/review routes
- `/api/master/:type`, `/api/depots`, `/api/yard-locations`, and `/api/operational-rules` for paginated master-data CRUD, controlled deactivation, search and CSV import/export
- `/api/reconciliation/discrepancies`, `/api/reconciliation/run`, and discrepancy resolution routes
- `GET /api/locations`, `GET /api/tasks`, `GET /api/events`, `GET /api/audit`
- `POST /api/tasks`, `PATCH /api/tasks/:id/complete`
- `GET /api/operators`, `POST /api/visits/gate-in`, `GET /api/visits/open`, `POST /api/visits/:id/gate-out`

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for requirements already covered and the remaining master-prompt gaps.

This is an MVP foundation, not an approved live-yard safety system. Validate the site location master, stacking rules, release authority, identity/access controls, backup and acceptance procedures with ICD operations and safety stakeholders before production use.
