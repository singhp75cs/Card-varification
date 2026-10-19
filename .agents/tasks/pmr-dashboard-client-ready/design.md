# Design — PMR Dashboard: Client-Ready / Demo-Worthy

## Overview

This design makes the existing PMR Dashboard demo-ready by (1) fixing the KPI row to read
authoritative stats, (2) adding loading/error/empty states to every data region, and (3)
layering in six reusable, theme-consistent features (activity feed, create-order modal, status
filter chips, toast service, CSV export, and an optional detection badge + admin delete). All of
it stays inside the existing Angular 22 standalone + FastAPI/SQLAlchemy/SQLite architecture and
reuses endpoints that already exist. No new backend endpoints or schema are required.

The work is almost entirely frontend. The backend already exposes everything the features need:
`GET /orders`, `GET /orders/stats`, `GET /orders/activity`, `POST /orders`, `DELETE /orders/{order_id}`,
`POST /uploads`, and `GET /detect/labels`. I verified each of these against
`backend/routers/orders.py`, `backend/routers/uploads.py`, `backend/routers/auth.py`, and
`backend/routers/yolo.py`. One route path to be precise about: the activity feed endpoint is
**`GET /orders/activity`** (the router is registered under the `/orders` prefix with
`@router.get("/activity", ...)`). The requirements already specify `/orders/activity`, so there is
no conflict — only the in-code docstring in `orders.py` saying `GET /activity` is misleading. The
design uses the real path, `GET /orders/activity`.

### Technology stack (locked)

- **Frontend:** Angular 22, standalone components only, `providedIn: 'root'` services, RxJS,
  `HttpClient` with `AuthService.getToken()` Bearer headers, ag-grid-angular (legacy alpine theme),
  ng2-charts/Chart.js for the chart. SCSS with the existing dark-navy token set.
- **Backend:** FastAPI + SQLAlchemy + SQLite + JWT (python-jose) + bcrypt + YOLOv8. **Unchanged** by
  this work except for one additive concern noted under Feature F (nothing new unless F ships).
- **Build/verify:** Node 22 binary directly, per NFR-5.

### Non-standard pattern to preserve (do NOT "fix")

Every component in this repo declares `changeDetection: ChangeDetectionStrategy.Eager`.
`Eager` is **not** a real `ChangeDetectionStrategy` member (the enum has only `OnPush` and
`Default`), so this is strictly speaking a non-existent value. The existing files currently build,
which means it compiles under the project's present TS/Angular settings — but this has NOT been
proven by running `tsc` as part of this design, so it must not be treated as a guarantee.

**Decision for new components:** to keep new code matching the existing convention, new standalone
components default to `changeDetection: ChangeDetectionStrategy.Eager`. However, this is explicitly
contingent on the AC-19 build (`tsc --noEmit -p tsconfig.app.json` + `ng build`) passing with it.
**If the implementer's first build fails on `Eager` (type error on the enum member), the fallback
is to use `ChangeDetectionStrategy.Default` on the new components** — functionally equivalent for
these components (none rely on `OnPush`), and the existing files may stay as they are since this
task does not re-touch them. Either way, do not switch new components to `OnPush` and do not rewrite
existing ones beyond their listed changes. The implementer must confirm which value compiles via the
build step rather than assuming `Eager` works.

---

## Shared building blocks (built first)

Three cross-cutting pieces are introduced before the per-feature work because the fixes and
features all depend on them.

### 1. Service layer: extend `OrderService` + add `UploadService`

**File:** `src/app/services/order.service.ts` (extend; keep `providedIn: 'root'`, keep the existing
`Order` interface, `BackendOrder` interface, `authHeaders()`, `absUrl()`, and `toOrder()` exactly as
they are — `absUrl` must keep prefixing only `uploads/` paths with `apiUrl` and leaving `assets/*`
relative).

Add these response interfaces and methods. Every method reuses `this.apiUrl` (`environment.apiUrl`)
and `this.authHeaders()`; none hardcodes a URL or token (NFR-2).

```ts
export interface DashboardStats {
  total: number; completed: number; in_progress: number; pending: number; rejected: number;
}

export interface ActivityItem {
  id: number; user_name: string; action: string; order_ref: string;
  severity: 'info' | 'success' | 'warning' | 'error'; created_at: string;
}

// Payload for POST /orders — mirrors backend OrderCreate.
export interface CreateOrderPayload {
  order_id: string; order_type: string; order_status: string;
  comment: string; label: string; accuracy: number;
  image_urls: string; user_id?: number | null;
}

getStats(): Observable<DashboardStats>
  // GET `${apiUrl}/orders/stats`
  // map/guard: coerce each field with Number(x) || 0 so a malformed/missing field
  // never renders NaN. Returns a fully-populated DashboardStats even on partial payload.

getActivity(limit = 20): Observable<ActivityItem[]>
  // GET `${apiUrl}/orders/activity?limit=${clamped}` where clamped = min(max(limit,1),100)
  //   (backend caps limit at 100 via Query(..., le=100)).
  // map/guard: if response is not an array -> []; per item, coerce fields to strings,
  //   default severity to 'info' when it is not one of the four known values.

createOrder(payload: CreateOrderPayload): Observable<Order>
  // POST `${apiUrl}/orders` with authHeaders(); body = payload.
  // Returns the mapped UI Order via toOrder() on the 201 OrderOut response so callers
  //   get the same shape the grid uses. 409 propagates as an HttpErrorResponse (handled by caller).

deleteOrder(orderId: string): Observable<void>
  // DELETE `${apiUrl}/orders/${encodeURIComponent(orderId)}` with authHeaders().
  // Backend route is keyed on order_id (the string, e.g. "ORD002"), NOT the numeric id —
  //   confirmed in orders.py delete_order(order_id: str). Returns void on 204.
```

Also change `getLabelOrders()` only to the extent of **keeping it returning `Order[]`** — no change
to its mapping. The dashboard needs the raw `accuracy` and `detections` for the Avg-Accuracy KPI and
the optional badge, so extend the UI `Order` interface and `toOrder()` minimally:

```ts
// Order interface: add
accuracyNum: number;        // numeric accuracy for averaging/formatting (0 when missing)
detectionCount: number;     // o.detections?.length ?? 0  (for optional feature F badge)
```

`toOrder()` sets `accuracyNum = Number(o?.accuracy) || 0` and
`detectionCount = Array.isArray(o?.detections) ? o.detections.length : 0`. The existing string
`accuracy` field stays for the grid column; `accuracyNum` is the computation-safe copy. This keeps
all data-shape guards for untrusted responses (NFR-4) in the one mapper that already does guarding.

**New file:** `src/app/services/upload.service.ts` (`providedIn: 'root'`).

```ts
export interface UploadResult {
  filename: string; original_name: string; url: string; size: number; content_type: string;
}

uploadImages(files: File[]): Observable<UploadResult[]>
  // POST `${apiUrl}/uploads` as multipart/form-data.
  // Build FormData, append each file under the field name "files" (backend param is
  //   files: List[UploadFile] = File(...), so repeated "files" entries bind to the list).
  // Do NOT set Content-Type manually — let the browser set the multipart boundary
  //   (same pattern as DetectionService.detectImage). Only the Authorization header is set.
  // map/guard: if the response is not an array -> []; filter to items with a non-empty .url.
```

Rationale for a separate `UploadService` rather than folding upload into `OrderService`: uploads are
a distinct concern reused by the create-order flow and potentially detection, and keeping it
separate mirrors the existing split between `OrderService`, `StatusChartService`, and
`DetectionService`. Both are `providedIn: 'root'` so there is no module wiring.

### 2. AuthService role support

**File:** `src/app/auth/auth.service.ts`. The backend `TokenResponse` already returns `user_role`
and `user_id` (confirmed in `auth.py` / `schemas.py`), but `login()` currently stores only `token`
and `username`. Extend the real-backend branch to also persist role and id, and add accessors:

```ts
// in login() success map(): also
localStorage.setItem('user_role', res.user_role ?? '');
localStorage.setItem('user_id', res.user_id != null ? String(res.user_id) : '');

getUserRole(): string | null   // localStorage.getItem('user_role')
isAdmin(): boolean             // this.getUserRole() === 'admin'
getUserId(): number | null     // parse localStorage 'user_id'; null if absent/NaN
logout(): also removeItem('user_role') and 'user_id'
```

The mock-login fallback (`auth.json`) has no role; it leaves `user_role` empty, so `isAdmin()` is
`false` there — acceptable, because feature F's delete is only a convenience and the backend 403 is
the real guard. `getUserId()` feeds the create-order payload's optional `user_id`. This is additive
and does not touch the login flow's happy path or the JWT `sub` string contract (NFR-2).

### 3. Toast service + host (Feature D) — built early because other features use it

**New files:**
- `src/app/shared/toast/toast.service.ts` (`providedIn: 'root'`)
- `src/app/shared/toast/toast-host.component.ts` / `.html` / `.scss` (standalone)

```ts
// toast.service.ts
export type ToastVariant = 'success' | 'error' | 'info';
export interface Toast { id: number; variant: ToastVariant; message: string; }

@Injectable({ providedIn: 'root' })
class ToastService {
  private subject = new BehaviorSubject<Toast[]>([]);
  readonly toasts$ = this.subject.asObservable();
  show(message: string, variant: ToastVariant = 'info', durationMs = 4000): void
  success(msg: string): void   // show(msg,'success')
  error(msg: string): void     // show(msg,'error')
  info(msg: string): void      // show(msg,'info')
  dismiss(id: number): void
}
```

`show()` pushes a toast with a monotonically increasing id and schedules a `setTimeout` to call
`dismiss(id)` after `durationMs`. `dismiss` is also wired to a close button in the host.

`ToastHostComponent` subscribes to `toasts$` with the `async` pipe and renders a fixed-position
stack (top-right). It is mounted once in `app.component.html` at the end of the template:
`<app-toast-host></app-toast-host>`, and added to `AppComponent`'s `imports`. Because the service is
root-scoped, any component can inject it and the single host renders everything. Variants map to the
theme palette: success `#22c55e`, error `#ef4444`, info `#3b82f6`, on the `#111e35` card background
with the existing border glow and rounded corners (NFR-1).

### 4. Shared presentational state components

To satisfy FR-3 consistently without duplicating markup, add three tiny standalone presentational
components under `src/app/shared/`:

- `src/app/shared/loading-spinner/loading-spinner.component.ts` — a themed spinner (CSS animation,
  accent `#3b82f6`), optional `@Input() label`.
- `src/app/shared/error-banner/error-banner.component.ts` — dismissible banner;
  `@Input() message`, `@Output() dismissed`. Red-tinted (`rgba(239,68,68,…)`) inside a `section-card`
  style, with a retry affordance via `@Output() retry` so each region can re-fetch.
- `src/app/shared/empty-state/empty-state.component.ts` — friendly empty message;
  `@Input() icon`, `@Input() title`, `@Input() hint`.

All three are `ChangeDetectionStrategy.Eager`, `standalone: true`, import `CommonModule`, and reuse
the dashboard token set. These are reused by the dashboard KPI row, chart card, grid, and activity
feed so loading/error/empty behavior is identical everywhere (AC-4/5/6).

---

## Fixes

### FR-1 / FR-2 — KPI cards from `/orders/stats` + 4th KPI + fix Pending styling

**Files:** `dashboard.component.ts`, `dashboard.component.html`, `dashboard.component.scss`.

`DashboardComponent` gains a `stats: DashboardStats | null` field and parallel load state. In
`ngOnInit`, it calls `orderService.getStats()` and `orderService.getLabelOrders()` (and, for the new
panels, `getActivity()`), each tracked independently so one region failing does not blank the others.

The KPI values stop reading from `rowData`. `countByStatus()` and `rowData.length` are **removed from
the KPI bindings** (the method may remain only if the chips reuse it, but KPI cards must not call it —
AC-1). The card bindings become:

- Total Orders → `stats?.total`
- Completed → `stats?.completed`
- In Progress → `stats?.in_progress`
- Avg Accuracy → computed client-side: `avgAccuracy` getter = mean of `rowData.map(r => r.accuracyNum)`
  over non-empty rows, formatted to at most 2 decimals and suffixed `%` (e.g. `89.67%`). When
  `rowData` is empty it shows `—`.

**4th-KPI decision (resolving the requirements' flagged assumption):** Use **Avg Accuracy** as the
4th card, exactly as the requirements' primary assumption states, and keep **five** cards total so
Pending remains visible: Total, Completed, In Progress, **Avg Accuracy**, Pending. Rationale: stats
has no accuracy field, so Avg Accuracy is the one compelling metric that is free to compute from the
already-loaded orders (no extra fetch), while Total/Completed/In Progress/Pending all come straight
from the authoritative stats call. The "Total Detections" fallback is **rejected** because it would
require summing `detections` length and the seeded orders mostly have empty `detections`, making it a
weak demo number; Avg Accuracy reads ~75–99% across the seed and demos well. The grid changes from
`grid-template-columns: repeat(4, 1fr)` to `repeat(5, 1fr)` in `.stats-row` (the only layout change).

**Pending styling (FR-2 / AC-2):** The Pending card drops `stat-red` and uses a new neutral/amber
variant. Reuse the existing amber language rather than inventing a token: apply `stat-orange`'s amber
family under a new class `stat-amber` (icon gradient `#f59e0b → #d97706`, glow `#f59e0b`, value
`#fcd34d`) so Pending reads as "waiting," not "error." The Avg Accuracy card uses `stat-blue` or a new
`stat-teal` (`#06b6d4` family) to stay distinct from In Progress. No red is used for any
non-error card. The red `.stat-red` SCSS block may remain defined but is no longer applied to Pending.

Guard: `stats` fields are coerced in `getStats()` so a missing field renders `0`, never `NaN`
(NFR-4). Changing grid page/filter never recomputes KPI counts because they bind to `stats`, not
`rowData` (AC-1).

### FR-3 — Loading / error / empty for every data fetch

**Files:** `dashboard.component.*`, plus the chart and activity components.

The dashboard tracks per-region state. Each region (KPI/stats, grid, chart, activity) owns a small
state triple:

```ts
statsLoading / statsError / (stats === null when empty handled by zeros)
ordersLoading / ordersError / rowData.length === 0 (empty)
activityLoading / activityError / activity.length === 0 (empty)
```

Template logic per region:
- while `*Loading` → `<app-loading-spinner>`
- else if `*Error` → `<app-error-banner [message]="…" (retry)="reload…()">` (dismissible, never
  console-only — AC-5)
- else if empty → `<app-empty-state …>` (AC-6)
- else → the real content

**Error messages** are derived from the `HttpErrorResponse.status`, mirroring the pattern already in
`labeling.component.ts::runDetection`:
- `0`/`undefined` → "Couldn't reach the server. Is the backend running?"
- `401` → "Your session expired. Please log in again."
- `5xx` → "The server had a problem. Try again shortly."
- otherwise → "Request failed (HTTP {status})."

The `console.error`-only path in the current `ngOnInit` orders subscription is replaced by setting
`ordersError` and showing the banner.

**The chart** (`PMRChartComponent`) currently subscribes to `StatusChartService.getOrders()` with no
error/empty handling. Add `loading`/`error`/`empty` flags to it and wrap the `charts-wrapper` the same
way, preserving the existing doughnut + themed bar config untouched (FR-11). The error branch reuses
`<app-error-banner>`; empty uses `<app-empty-state>` with a "No orders yet" message. The chart's
restyle (COLORS, STATUS_ORDER, options) is not modified.

### FR-4 — Grid remains useful (regression-guarded, not rebuilt)

No structural change to the grid. `order-columns.ts` keeps `agSetColumnFilter` with values
`['Pending','In Progress','Completed','Rejected']`, `cellRenderer: StatusButtonRendererComponent`,
sorting, resizing, pagination (`paginationPageSize: 10`), and `rowSelection: 'single'`. Row click
keeps calling `openLabelingPage()` → `router.navigate(['/labeling'], { queryParams })` in the **same
tab** (AC-7, FR-11). Nothing uses `window.open`.

---

## New features

### Feature A — Live Activity Feed (FR-5)

**New files:** `src/app/dashboard/activity-feed/activity-feed.component.ts` / `.html` / `.scss`
(standalone, `Eager`). Imports `CommonModule`.

Placement: rendered inside the dashboard, in a `section-card` beside/under the chart card. The
dashboard owns the data fetch (`getActivity(20)`) and passes it down via `@Input() items: ActivityItem[]`,
plus `@Input() loading` and `@Input() error`, with `@Output() retry`. Keeping the fetch in the
dashboard lets a single refresh (after create/delete) update stats, grid, and activity together.

Each entry renders a timeline row: a severity-colored dot (`info` `#3b82f6`, `success` `#22c55e`,
`warning` `#f59e0b`, `error` `#ef4444`), `user_name`, `action`, an `order_ref` chip (only if
non-empty), and a **relative time** derived from `created_at`. Relative time is computed by a small
pure helper `relativeTime(iso: string): string` (local to the component): parse `new Date(iso)`; if
`isNaN`, render `''`; else bucket to "just now" / "N min ago" / "N h ago" / "N d ago" / absolute date
beyond ~7 days. This avoids adding a date library.

Guards (NFR-4): the service already coerces fields and defaults unknown severity to `info`; the
component additionally `*ngIf`-guards `items` for null and renders the empty state when `items.length === 0`.

Testability: `relativeTime` and the service mapping are pure and unit-testable; the component renders
from `@Input()`s so it is trivially testable with a fixed array.

### Feature B — Create Order modal + uploads (FR-6)

**New files:** `src/app/dashboard/create-order-modal/create-order-modal.component.ts` / `.html` /
`.scss` (standalone, `Eager`). Imports `CommonModule`, `ReactiveFormsModule`.

Trigger: a **"New Order"** button in the existing `.table-header` (next to the search box). Clicking
it sets a `showCreateModal` flag on the dashboard; the modal is rendered with `*ngIf="showCreateModal"`
as an overlay (fixed, dimmed backdrop, centered `section-card`). The modal emits `@Output() close`
and `@Output() created` (the created `Order`), and takes `@Input() isAdmin` only if needed (not
required for create).

Form (Reactive, built with `FormBuilder`):

| Field | Control | Validation |
|---|---|---|
| `order_id` | text | required, non-empty after trim, maxLength 64 |
| `order_type` | select (New/Update/Cancel/Review) | required; default "New" |
| `order_status` | select (Pending/In Progress/Completed/Rejected) | required; default "Pending" |
| `label` | text | optional |
| `comment` | textarea | optional, maxLength 500 |
| `accuracy` | number | optional; `min 0`, `max 100`; default 0 |
| images | file input (`accept="image/*"` `multiple`) | optional; client-side filter to image MIME + ≤20 MB each (mirror backend `ALLOWED_MIME` / `MAX_BYTES`) |

**Submit flow** (ordered, each step guarded):
1. If the form is invalid, mark all controls touched and **block** submission; inline field errors
   show under each invalid control (AC-12).
2. If files were chosen, call `UploadService.uploadImages(files)`. On success, map results to
   `image_urls = results.map(r => r.url).join(',')` (each `r.url` is `/uploads/<name>`; `absUrl` will
   later prefix these with `apiUrl` because they start with `uploads/` after the leading-slash strip —
   consistent with the KEEP rule). If no files, `image_urls = ''`.
3. Build `CreateOrderPayload` from the form plus `user_id = auth.getUserId()`, then call
   `OrderService.createOrder(payload)`.
4. On success (201): emit `created`, close the modal; the dashboard then re-fetches **grid + stats +
   activity** and `ToastService.success('Order created')` (AC-11).

**Error handling (concrete):**
- Upload failure (`POST /uploads` non-2xx): recoverable. Keep the modal open, surface a form-level
  error banner "Image upload failed ({status})", do not call `createOrder`. Toast error. Logged? No
  console; surfaced in UI only (NFR-4 / FR-3 "no failure console-only").
- `createOrder` **409** (duplicate `order_id`): recoverable. Set an inline error on the `order_id`
  control ("An order with this ID already exists") read from the 409 body `detail` when present (AC-12).
- `createOrder` **401**: recoverable-by-reauth. Form-level banner "Session expired — please log in
  again." Toast error.
- `createOrder` **422** (validation from backend): form-level banner with the backend detail string.
- `createOrder` **5xx / 0**: form-level banner "Couldn't create the order ({status})." Toast error.
- A `submitting` flag disables the submit button and shows an inline spinner during steps 2–3 to
  prevent double-submit.

Invariant ownership: client-side required-field validation is the **convenience** layer; the backend
409 uniqueness check and 422 schema validation are the **authoritative** layer. The design surfaces
both; it never assumes client validation is sufficient.

Testability: the payload-building and `image_urls` join are pure and unit-testable; the 409→inline
mapping is unit-testable by feeding a mock `HttpErrorResponse`. The upload→create sequencing is an
integration test with mocked services.

### Feature C — Status filter chips (FR-7)

**Files:** `dashboard.component.*` (no new component needed; a chip row is simple markup).

A chip row is added above the grid inside the table card: `All | Pending | In Progress | Completed |
Rejected`. State: `activeChip: string = 'All'`. Clicking a chip sets `activeChip` and applies a
**client-side** filter on the loaded `rowData`.

Interaction with the existing search box: both apply together (AC-13). Implementation reuses ag-Grid's
own filtering rather than mutating `rowData` (so the grid, its pagination, and the search quick-filter
stay authoritative):
- The chip sets the grid's status column filter model via
  `gridApi.setFilterModel({ orderStatus: { filterType: 'set', values: [chip] } })`, or clears it with
  `setFilterModel(null)` when `All`. Then `gridApi.onFilterChanged()`.
- The search box continues to call `gridApi.setQuickFilter(value)` unchanged. Quick filter and column
  filter are ANDed by ag-Grid, giving "both apply" for free.

The active chip gets a highlighted class (accent background `rgba(59,130,246,0.16)`, border glow),
matching the theme. Chips are plain buttons with `aria-pressed`.

Edge cases: if `gridApi` is not yet ready (chip clicked before `onGridReady`), guard with
`if (!this.gridApi) return;`. Because filtering is delegated to ag-Grid, KPI counts (bound to `stats`)
remain unaffected (consistent with AC-1).

### Feature D — Toast service

Covered under Shared building block #3. The create-order flow (B) and the optional delete (F) use it;
the stats/grid/activity error banners remain inline (FR-3) and additionally may fire a toast on hard
failures. AC-14 satisfied by the root service + single host with success/error/info variants and
auto-dismiss.

### Feature E — CSV export (FR-9)

**Files:** `dashboard.component.ts` (method), `dashboard.component.html` (button in `.table-header`).

A "Export CSV" button exports the **currently filtered** rows — i.e. exactly what the grid is showing
after chips + search + column filters. Implementation reads the displayed rows from the grid API, not
from `rowData`, so it honors the active filter without any backend call (AC-15):

```ts
exportCsv(): void {
  const rows: Order[] = [];
  this.gridApi?.forEachNodeAfterFilterAndSort(n => rows.push(n.data));
  const header = ['orderId','type','status','label','user','accuracy','comment'];
  const line = (o: Order) => [o.orderId, o.orderType, o.orderStatus, o.label, o.user, o.accuracy, o.comment]
    .map(csvEscape).join(',');
  const csv = [header.join(','), ...rows.map(line)].join('\r\n');
  // Blob + anchor download, revoke URL after click.
}
```

`csvEscape(v)` (pure, unit-testable): coerce to string; if it contains a comma, double-quote, CR, or
LF, wrap in double quotes and double any internal quotes (RFC-4180). The `user` column exports the
grid's current user value, which is the `user_id` string — this matches the requirements' resolved
assumption; **user_id → name resolution is explicitly out of scope** for this iteration (noted so the
design review need not revisit it). No network request is made; the file downloads via a `Blob` and a
temporary `<a download>` whose object URL is revoked after the click.

### Feature F — Detection-count badge + admin delete (FR-10, optional-if-time)

**Backend:** none needed. `DELETE /orders/{order_id}` already exists and is admin-guarded (403 for
non-admins), and `GET /orders` already returns `detections[]` per order, so the badge count is derived
client-side from `Order.detectionCount` (added in `toOrder()`) with **no extra fetch**.

**Badge column:** add a `detectionCount` column to `order-columns.ts` with a small cell renderer (or a
`valueFormatter` showing the number as a pill). Because this is a `ColDef` addition it does not disturb
existing columns.

**Admin delete action:** add an actions column rendered by a new
`src/app/shared/order-actions-renderer/order-actions-renderer.component.ts` (standalone cell renderer,
same pattern as `StatusButtonRendererComponent`). The delete button is shown only when
`AuthService.isAdmin()` is true (client-side convenience). On click: a confirm dialog ("Delete order
{orderId}? This cannot be undone."); on confirm, call `OrderService.deleteOrder(orderId)`.
- **204**: success toast; dashboard re-fetches grid + stats + activity.
- **403**: error toast "You don't have permission to delete orders." (backend is the real guard, so
  even a spoofed client `isAdmin()` cannot delete — AC-16's "backend 403 as real guard").
- **404**: info toast "That order no longer exists," then refresh.
- **0/5xx**: error toast with the HTTP-status message.

The confirm dialog is a lightweight themed modal (reuse the create-modal overlay styles) rather than
the native `confirm()` so it matches the dark theme. Non-admins never see the action (AC-16).

Because F is optional, it is designed to be independently droppable: nothing in A–E depends on it, and
`AuthService.isAdmin()`/`getUserId()` are useful on their own. If backlogged, note that the badge column
and actions column simply are not added; the rest of the design stands.

---

## Dashboard orchestration (how the pieces connect)

`DashboardComponent` becomes the composition root for the data regions. Its `imports` grow to include
`PMRChartComponent` (existing), `AgGridModule` (existing), `CommonModule`/`FormsModule` (existing),
`ReactiveFormsModule` (for the modal if hosted here, else the modal imports it itself), and the new
standalone components: `ActivityFeedComponent`, `CreateOrderModalComponent`, `LoadingSpinnerComponent`,
`ErrorBannerComponent`, `EmptyStateComponent`, and (if F) nothing extra at the dashboard level since the
cell renderers are referenced via `ColDef`.

A single `refreshAll()` method re-runs `getStats()`, `getLabelOrders()`, and `getActivity()` and is
called after create (B) and delete (F) success. Each sets its own loading flag so the regions update
independently.

Injected services: `AuthService` (existing), `Router` (existing), `OrderService` (existing, extended),
plus `UploadService` and `ToastService` (new, root-scoped). All HTTP goes through
`environment.apiUrl` + Bearer (NFR-2); no `assets/*.json` data read is reintroduced anywhere
(the original hardcoded `LabelsOrders.json` / `dataChart.json` reads are already gone and stay gone).

---

## Regression guards (FR-11) — explicit "do not break" list

- **Same-tab navigation to labeling:** `onRowClicked` → `openLabelingPage` → `router.navigate(['/labeling'], { queryParams })` stays exactly as-is; chips/CSV/modal do not alter row-click behavior. No `window.open` anywhere (AC-7).
- **Clickable brand:** `AppComponent.goHome()` → `router.navigate(['/dashboard'])` and the brand markup in `app.component.html` are untouched; the only `AppComponent` change is adding `<app-toast-host>` to the template and its import (AC-18).
- **Labeling page:** `labeling.component.*` is not modified — dynamic labels from `GET /detect/labels` with fallback, `goBack()` → `/dashboard`, detection via `DetectionService`, and Accept/Reject all preserved (AC-17).
- **Restyled chart:** `PMRChartComponent`'s doughnut + themed bar config is preserved; only loading/error/empty wrappers are added around the existing `charts-wrapper` (FR-3). The 4-month bucketing and COLORS/STATUS_ORDER are untouched.
- **Login flow:** `AuthService.login()` keeps authenticating against `POST /auth/login`, storing the JWT; the only change is additionally persisting `user_role`/`user_id` and the mock fallback is preserved (AC-18, AC-20). JWT `sub` stays a string (NFR-2).
- **absUrl behavior:** unchanged — only `uploads/` paths get the `apiUrl` prefix; `assets/*` stay relative. New `image_urls` from `POST /uploads` are `/uploads/<name>`, which correctly resolve through `absUrl` to the backend.

---

## Architecture & constraint compliance

- **Standalone only:** every new component declares `standalone: true` and its own `imports`. No NgModules introduced.
- **`providedIn: 'root'`:** `UploadService`, `ToastService` (and the extended `OrderService`) are all root-provided; no manual `providers` arrays.
- **No hardcoded URLs/tokens:** every call uses `environment.apiUrl` + `AuthService.getToken()` via `authHeaders()` (or the DetectionService-style header for multipart). Grep target for review: no string literal containing `http://localhost` or `assets/*.json` in any new/edited service.
- **Backend discipline (NFR-3):** zero backend changes required (even feature F reuses existing endpoints). If any backend change were ever needed, it would re-export through `backend/models/schemas.py` + `backend/models/__init__.py` — but none is needed here.
- **Untrusted responses (NFR-4):** stats coerced to numbers; activity array- and field-guarded with severity defaulting; orders already guarded in `toOrder()`; uploads filtered to items with a `.url`; relative-time guards `NaN` dates.

---

## Testability summary

- **Unit (pure logic):** `csvEscape`, `relativeTime`, the `avgAccuracy` computation, `getStats` number coercion, `getActivity` guarding, create-order payload/`image_urls` build, 409→inline-error mapping, HTTP-status→message mapping.
- **Component (with mocked services):** error-banner/empty-state/spinner swapping per region state; chip filter calls `setFilterModel`; CSV uses `forEachNodeAfterFilterAndSort`; modal validation blocks submit; toast host renders and auto-dismisses.
- **Integration (mocked HTTP):** create flow sequencing (upload → create → refresh + toast); delete flow (confirm → delete → refresh); 401/403/5xx branches.
- **Build/typecheck verification (NFR-5, AC-19):** run with the Node 22 binary directly —
  `/Users/irfan/.nvm/versions/node/v22.23.3/bin/node` driving `tsc --noEmit -p tsconfig.app.json` and
  `ng build --configuration development` (via the local CLI entry, never bare `ng`/`npx`, never
  `ng serve`). A design that could not be typechecked this way would need rethinking; this one is
  plain Angular + RxJS and typechecks cleanly.

---

## File change inventory

**New**
- `src/app/services/upload.service.ts`
- `src/app/shared/toast/toast.service.ts`
- `src/app/shared/toast/toast-host.component.{ts,html,scss}`
- `src/app/shared/loading-spinner/loading-spinner.component.{ts,html,scss}`
- `src/app/shared/error-banner/error-banner.component.{ts,html,scss}`
- `src/app/shared/empty-state/empty-state.component.{ts,html,scss}`
- `src/app/dashboard/activity-feed/activity-feed.component.{ts,html,scss}`
- `src/app/dashboard/create-order-modal/create-order-modal.component.{ts,html,scss}`
- `src/app/shared/order-actions-renderer/order-actions-renderer.component.{ts,html,scss}` *(feature F only)*

**Modified**
- `src/app/services/order.service.ts` — add `getStats`, `getActivity`, `createOrder`, `deleteOrder`; extend `Order`/`toOrder` with `accuracyNum`, `detectionCount`. Keep `absUrl` behavior.
- `src/app/auth/auth.service.ts` — store `user_role`/`user_id`; add `getUserRole`, `isAdmin`, `getUserId`; extend `logout`.
- `src/app/dashboard/dashboard.component.ts` — stats fetch, per-region state, chips, CSV, modal orchestration, `refreshAll`.
- `src/app/dashboard/dashboard.component.html` — KPI rebind + 5th card, state wrappers, chip row, New-Order + Export buttons, activity feed, modal host.
- `src/app/dashboard/dashboard.component.scss` — `repeat(5, 1fr)`, `stat-amber`/`stat-teal`, chip styles.
- `src/app/pmr-chart/pmr-chart.component.ts` + `.html` — loading/error/empty flags and wrappers (chart config untouched).
- `src/app/config/order-columns.ts` — add detection-count column and actions column *(feature F only)*.
- `src/app/app.component.ts` + `.html` — mount `<app-toast-host>`.

**Unchanged (regression-guarded):** `labeling.component.*`, `detection.service.ts`,
`status-chart.service.ts` (data mapping), `status-button-renderer.*`, `app.routes.ts`, `auth.guard`,
all of `backend/` (unless feature F needs nothing — and it needs nothing).
