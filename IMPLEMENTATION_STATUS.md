# Master prompt coverage

This project keeps the requested React Native/Expo + Node.js + MySQL stack. The pasted master prompt also proposes Next.js, NestJS and PostgreSQL; those are alternative stacks and are not mixed into this existing application.

## Implemented in this project

- One Expo React Native/React Native Web client for the browser and Android/iOS.
- Express REST API connected to MySQL 8.
- Yard inventory, locations, container pre-advice, gate-in, movement task planning and completion.
- Transactional slot reservation and movement completion, including release of the source slot on retrieval.
- Gate-in and gate-out writes are transactional. Gate-out requires a cleared hold and a container removed from its yard slot.
- Hold and authorised release actions, inspection records, movement events and audit-log entries.
- Database-generated operational dashboard counts, searchable container records, yard map and audit/event views.
- Login/logout, scrypt password hashes, expiring signed access tokens, rotating hashed refresh sessions, lockout/IP throttling, password change/reset tokens, activation/deactivation and login history.
- Nine seeded role definitions and database permissions enforced by API middleware; permission-aware navigation and administration screens for accounts and role grants.
- Expo SecureStore for native refresh tokens and short-lived browser session storage; mobile bottom navigation and camera barcode/QR scanning with manual lookup fallback.
- Role-filtered task queues and operator assignments, transactional gate-out with hold/location controls, and a More hub with gate, pre-advice, yard, slot, inspection/hold, relocation, reconciliation review, alerts, reports, profile and account management links.
- Database-backed operations dashboard for inventory, eligible/occupied/reserved/blocked slots, gate events, holds, task queues and lateness, dwell thresholds, reconciliation discrepancies, block occupancy, gate trends, ageing, exceptions, recent activity, alerts and equipment task productivity. Date, block and status filters are supported; the client polls every 30 seconds.
- Expanded container lifecycle records, backend search/filter/pagination, detail/history/visit/inspection/hold/manifest views, ISO 6346 format/check-digit validation, duplicate-history protection, CSV inventory import/export, and HTTPS document/photo references.
- Depot, yard-position, reference-value and operational-rule CRUD with search, pagination, CSV import/export where applicable, unique keys and controlled deactivation. Referenced yard positions cannot be made unavailable while occupied or reserved.
- Manifest/pre-advice create, edit, cancel, CSV import, expected-container links, booking/arrival/departure references, received/missing status, and an auditable unexpected-arrival exception approval flow. Gate-in eligibility comes only from an active manifest line or an approved exception; putaway requires a recorded eligible gate-in.
- Persisted inventory/slot reconciliation discrepancies with audited resolution reasons, plus dashboard discrepancy counts.
- Local MySQL bootstrap, SQL schema/seed file, and web export.

## Still missing from the master prompt

- Separate Next.js administration site; currently administration and operations share the Expo app.
- MFA and enterprise SSO providers, and email delivery for password-reset tokens. Local development prints reset tokens to the API console.
- Offline mobile queue, inspection photo/evidence upload and push notifications.
- Appointments and automated appointment integrations, actual binary document/photo upload and image evidence capture, billing exports and downloadable reports. Container document entries currently reference an HTTPS URI; they do not store binary files.
- Real-time push/websocket delivery; the overview polls the database-backed dashboard every 30 seconds. Filters apply to operational trends and related subsets while live inventory/slot KPIs remain current-state metrics.
- Operational status values remain application/schema constraints; the status master-data catalog is a controlled reference list and does not dynamically change database enum definitions.
- Real-time Socket.IO updates, scheduled workers, partner integrations, Swagger/OpenAPI, Docker deployment, CI/CD, backup automation and full automated acceptance coverage.
- Production security and operational review, including review of authentication configuration, email delivery, site-specific stacking rules and release authority.

The project is an operational MVP and must not be treated as production-ready until the missing access-control, deployment and ICD validation work is completed.
