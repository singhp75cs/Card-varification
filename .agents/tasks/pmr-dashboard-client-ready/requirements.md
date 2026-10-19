# Requirements — PMR Dashboard: Client-Ready / Demo-Worthy

## Summary

Make the existing PMR Dashboard polished enough to demo to and sell to a client.
The app is already wired end-to-end: an Angular 22 standalone frontend talking to a
FastAPI/SQLAlchemy/SQLite backend over JWT Bearer auth, with a seeded demo database
(30 orders, 4 users, activity log). This work fixes the weak spots in the current UI
and adds several high-impact, reusable features — all in the existing dark navy theme
(section-card, stat-card, gradients, rounded corners, glow).

Scope is additive and surgical on the backend: every endpoint the features need already
exists and must be reused. Frontend changes are the bulk of the work: new standalone
components, new service methods, and loading/error/empty states wherever data is fetched.

### Confirmed current behavior (from code review)
- `DashboardComponent` computes KPI cards from `rowData` (`rowData.length`,
  `countByStatus(...)`) — i.e. from the loaded grid rows, NOT from `GET /orders/stats`.
- The 4th KPI card is "Pending" rendered with the `stat-red` (red) class — misleading
  styling, since Pending is not an error state.
- Order load error path is `console.error` only; there is no loading spinner, no error
  banner, and no empty state in the dashboard, chart, or anywhere data is fetched.
- The grid already navigates to the labeling page in the **same tab** via
  `router.navigate(['/labeling'], ...)`. This is correct and must be preserved.
- `OrderService` exposes only `getLabelOrders()` / `getOrders()`. It has NO
  `getStats()`, `getActivity()`, `createOrder()`, or `uploadImages()` methods.
- Status filter / set-filter values in `order-columns.ts` already match the backend set
  (Pending | In Progress | Completed | Rejected).
- The chart (`PMRChartComponent` + `StatusChartService`) already pulls live orders and is
  restyled (doughnut + themed bars). It must keep working and keep its theme.
- `LabelingComponent` already has: dynamic labels from `GET /detect/labels` (with fallback),
  a back button (`goBack()` → `/dashboard`), detection, and same-tab navigation. Preserve all.
- Brand click (`goHome()` → `/dashboard`) and login flow work. Preserve both.

### Assumptions resolved (flagged for design review)
- **4th KPI decision:** Replace the misleading red "Pending" card with a clearly-labeled
  **"Avg Accuracy"** card (mean `accuracy` across all orders), AND keep a Pending card but
  restyled neutral/amber. Rationale: `GET /orders/stats` already returns
  `{total, completed, in_progress, pending, rejected}` — so Total / Completed / In Progress
  come straight from stats, and Pending is retained but recolored. "Avg Accuracy" is a
  compelling, sellable metric and is computable client-side from the loaded orders without a
  new endpoint. If the design prefers "Total Detections", that is the fallback (requires
  summing `detections` length per order or a count — note the extra fetch cost). Design review
  to confirm; this document assumes **Avg Accuracy** as the 4th KPI and the layout keeps 4+
  cards (Total, Completed, In Progress, Avg Accuracy) with Pending shown either as a 5th card
  or folded into In Progress styling — design to finalize card count/layout.
- **Stats source:** KPI counts (Total/Completed/In Progress/Pending/Rejected) come from
  `GET /orders/stats` (authoritative), not from loaded page rows. Avg Accuracy is derived
  client-side from the loaded orders because stats has no accuracy field.
- **CSV "user" column:** Backend orders carry `user_id` (int), not a user name, in the list
  payload. The CSV `user` column will export whatever the grid currently shows for user
  (today that is the `user_id` string). Design review to decide if a name lookup is in scope.
- **Admin detection for delete action (feature F):** Admin status is derived from
  `user_role` returned at login. `AuthService` currently stores only token + username, so a
  role accessor must be added (store `user_role` at login, expose `isAdmin()`), OR gate the
  delete action behind the backend's own 403. This document assumes a client-side `isAdmin()`
  added to `AuthService` for showing/hiding the action, with the backend 403 as the real guard.
- Feature F (detection-count badge + admin delete) is **optional-if-time** and may be
  backlogged without failing the task.

---

## Functional Requirements

### Fixes

**FR-1 — KPI cards fetch authoritative stats.**
The dashboard KPI row must display counts from `GET /orders/stats`, not from the loaded grid
rows. On the response, map `total`, `completed`, `in_progress`, `pending`, `rejected` to
clearly labeled cards. Remove the `countByStatus(...)`/`rowData.length` computation for KPI
values.

**FR-2 — Fix misleading Pending styling + add a 4th KPI.**
The Pending KPI must no longer use error/red styling; use a neutral or amber treatment.
Add an **Avg Accuracy** KPI card (mean of order `accuracy`, formatted e.g. `89.7%` or `89.67`),
clearly labeled. (See assumption above for the Total Detections fallback.)

**FR-3 — Loading / error / empty states for every data fetch.**
Grid, chart, stats, and activity feed must each show: a themed spinner/skeleton while loading;
a dismissible themed error banner on failure (backend down, HTTP 0/401/5xx); and a friendly
empty state when a successful response has zero rows. No failure may be console-only.

**FR-4 — Grid remains genuinely useful.**
Same-tab navigation on row click is preserved. Status filter values match the backend set
(Pending | In Progress | Completed | Rejected). Sorting and pagination remain functional.

### New features

**FR-5 — Live Activity Feed panel (feature A).**
Add `getActivity(limit?)` to `OrderService` calling `GET /orders/activity`. Render a themed
timeline section card near the chart: each entry shows a severity color dot
(info/success/warning/error), `user_name`, `action`, `order_ref`, and a relative time derived
from `created_at`. Guard null/missing/empty.

**FR-6 — Create Order modal (feature B).**
New standalone component with a form: `order_id`, `order_type`, `order_status`, `label`,
`comment`, `accuracy`, plus image upload. On submit: upload images via `POST /uploads`
(add `uploadImages(files)` to a service), join returned `url`s comma-separated into
`image_urls`, then `POST /orders` (add `createOrder(payload)`). A "New Order" button lives in
the table header. On success: close modal, refresh grid + stats + activity, show a success
toast. Required fields are validated client-side; a backend 409 (duplicate `order_id`) is
surfaced inline on the form.

**FR-7 — Status filter chips (feature C).**
Chip row above the grid: All / Pending / In Progress / Completed / Rejected. Client-side
filter of the loaded rows; the active chip is visually highlighted; the existing search box
continues to work alongside the chips (both apply).

**FR-8 — Toast / notification service (feature D).**
A reusable, `providedIn:'root'` toast service + standalone toast host component supporting
success / error / info variants, theme-consistent, auto-dismissing. Used by the create-order
flow and other success/error moments.

**FR-9 — CSV export (feature E).**
A button in the table header exports the **currently filtered** orders as a client-side CSV
blob (no backend call). Columns: `orderId, type, status, label, user, accuracy, comment`.
Values are CSV-escaped (quotes, commas, newlines).

**FR-10 — Optional-if-time (feature F).**
Per-row detection-count badge column, and an admin-only delete action calling
`DELETE /orders/{id}` behind a confirm dialog, refreshing grid + stats + activity on success.
May be backlogged.

### Must-not-break (regression guards)

**FR-11.** Same-tab navigation to the labeling page; clickable brand (`goHome()` → `/dashboard`);
the labeling page (detection button, dynamic labels from `GET /detect/labels`, back button,
Accept/Reject); the restyled chart (doughnut + themed bars); and the login flow all keep working.

---

## Non-Functional Requirements

**NFR-1 — Theme consistency.** All new/changed UI uses the existing dark navy visual language
(section-card, stat-card, gradients, rounded corners, glow). No new theme system.

**NFR-2 — Architecture constraints.** Standalone components only; services `providedIn:'root'`;
all backend calls reuse `environment.apiUrl` + `AuthService.getToken()` Bearer header. No
hardcoded URLs or tokens. JWT `sub` stays a string.

**NFR-3 — Backend discipline.** Additive/surgical only. Reuse existing endpoints; add backend
code only if a feature truly needs it. Any new schema is re-exported from
`backend/models/schemas.py` and `backend/models/__init__.py`.

**NFR-4 — Untrusted responses.** All backend responses are treated as untrusted: guard null,
missing, and empty fields before rendering or computing (as the existing mappers already do).

**NFR-5 — Verification environment.** Build/typecheck must use the Node 22 binary directly
(`/Users/irfan/.nvm/versions/node/v22.23.3/bin/...`); never bare `ng`/`npx`; never `ng serve`
during verification.

---

## Acceptance Criteria

1. With the backend up and an admin logged in, the four KPI card values equal the fields from
   `GET /orders/stats` (not grid-row counts). Changing the grid page/filter does not change
   KPI counts.
2. The Pending KPI is not rendered in red/error styling; it uses a neutral or amber treatment.
3. An "Avg Accuracy" KPI card is present, clearly labeled, and shows the mean order accuracy
   formatted to at most 2 decimals.
4. While the dashboard loads, a themed spinner/skeleton is visible; it disappears when data
   arrives.
5. With the backend stopped (or a forced 401), each data region (grid, chart, stats, activity)
   shows a dismissible themed error banner — no error is console-only.
6. When a successful response returns zero rows, each data region shows a friendly themed empty
   state rather than a blank area.
7. Clicking a grid row navigates to `/labeling` in the **same tab** (no `window.open`/new tab),
   carrying order context.
8. The grid status filter offers exactly Pending, In Progress, Completed, Rejected; sorting on
   each column and pagination both work.
9. An Activity Feed section card appears near the chart; `OrderService.getActivity()` calls
   `GET /orders/activity`; each entry shows a severity-colored dot, user, action, order_ref,
   and relative time; empty/err states per AC-5/AC-6 apply.
10. A "New Order" button in the table header opens a standalone modal with fields order_id,
    order_type, order_status, label, comment, accuracy, and an image uploader.
11. Submitting the modal uploads images via `POST /uploads`, comma-joins returned urls into
    `image_urls`, then `POST /orders`; on success the modal closes and the grid, stats, and
    activity all refresh and a success toast appears.
12. Submitting with a required field empty blocks submission with inline validation; submitting
    a duplicate `order_id` surfaces the backend 409 inline on the form (not just a console error).
13. Status filter chips (All / Pending / In Progress / Completed / Rejected) appear above the
    grid; selecting one filters the loaded rows client-side; the active chip is highlighted; the
    search box still filters alongside the active chip.
14. A reusable toast service + standalone host renders success/error/info toasts in the dark
    theme that auto-dismiss.
15. The CSV export button downloads a client-side `.csv` of the **currently filtered** rows with
    header `orderId,type,status,label,user,accuracy,comment`; values containing commas, quotes,
    or newlines are correctly escaped; no network request is made for the export.
16. (If implemented) A detection-count badge column shows per order, and an admin-only delete
    action calls `DELETE /orders/{id}` behind a confirm, refreshing grid/stats/activity on
    success; non-admins do not see the action.
17. The labeling page still runs detection, loads dynamic labels from `GET /detect/labels`
    (with fallback), has a working back button to `/dashboard`, and supports Accept/Reject.
18. The brand element still navigates to `/dashboard` on click; the login flow still
    authenticates against `POST /auth/login` and stores the JWT.
19. `tsc --noEmit -p tsconfig.app.json` and `ng build --configuration development` both succeed
    using the Node 22 binary; no new type errors are introduced.
20. No new service hardcodes a URL or token: every backend call uses `environment.apiUrl` +
    `AuthService.getToken()`.

---

## Out of Scope

- New backend endpoints or schema changes beyond what a listed feature strictly requires
  (reuse existing endpoints; the stats/activity/upload/detect/CRUD endpoints already exist).
- Replacing or re-theming the charting library, the ag-Grid setup, or the overall layout system.
- Server-side pagination/search wiring for the grid (grid filtering/chips are client-side on
  loaded rows for this iteration).
- Resolving `user_id` → user display name in the grid/CSV (unless design review pulls it in).
- Fixing seeded sample image availability (`assets/images/sample*.jpg`); detection on seeded
  orders depends on those assets existing and is a demo-data concern, not this task.
- Mobile/responsive redesign beyond the theme behaving reasonably at desktop demo sizes.
- Internationalization, SSR, and auth hardening (token refresh, role management UI).
