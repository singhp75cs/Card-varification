# Design Review — PMR Dashboard: Client-Ready / Demo-Worthy

Reviewed: `design.md` against `requirements.md`, with every load-bearing claim verified
against the actual source (`backend/routers/*.py`, `backend/schemas.py`, `src/app/**`,
`package.json`, and the installed `node_modules/ag-grid-community@33.3.2`).

**Verdict: CHANGES_REQUESTED** — 2 HIGH, 5 MEDIUM, 4 NIT.

The design is unusually thorough and most of its backend/service claims check out. The
blocking problems are concentrated in Feature C (status filter chips), which is built on an
AG Grid capability this project does not have, and on a grid API method that no longer exists
in the installed AG Grid version. There are also a few concrete gaps in signatures/typing and
in the activity-feed data path.

---

## Findings

### 1. HIGH — Feature C relies on AG Grid Set Filter, which is Enterprise-only and not registered

**Where:** Feature C (FR-7), design.md lines ~383–392; and the pre-existing
`src/app/config/order-columns.ts` `filter: 'agSetColumnFilter'`.

The design implements the status chips with:
```ts
gridApi.setFilterModel({ orderStatus: { filterType: 'set', values: [chip] } });
```
and leans on the column's existing `agSetColumnFilter` (`order-columns.ts`) plus AG Grid ANDing
the column filter with the quick filter.

Verified against the installed grid: `main.ts` registers **only** `AllCommunityModule` from
`ag-grid-community@33.3.2`. The Set Filter (`agSetColumnFilter` / `SetFilterModule`) is an **AG Grid
Enterprise** feature — `grep -c "SetFilterModule:" node_modules/ag-grid-community/dist/package/main.cjs.js`
returns `0`, and `AllCommunityModule` ships only `TextFilterModule`, `NumberFilterModule`,
`DateFilterModule`, `QuickFilterModule`, etc. So:
- `setFilterModel({ orderStatus: { filterType: 'set', ... } })` has no registered Set Filter to
  apply the model to — it will not filter (and in v33 an unregistered module logs an error).
- The existing `agSetColumnFilter` on the status column is itself already non-functional under
  community modules; the design builds Feature C on top of that broken assumption and AC-8's
  "status filter offers exactly Pending/In Progress/Completed/Rejected" is not actually met today.

This also undercuts the design's "both apply for free" claim, since that depended on a working
column Set Filter being ANDed with the quick filter.

**Concrete fix (pick one, state it in the design):**
- (a) Make the chips an **external filter** that does not depend on Set Filter. Keep `rowData`
  authoritative, set an `activeChip` field, register an external filter:
  ```ts
  // in grid options: isExternalFilterPresent + doesExternalFilterPass
  isExternalFilterPresent = () => this.activeChip !== 'All';
  doesExternalFilterPass = (node: any) => node.data?.orderStatus === this.activeChip;
  // on chip click:
  this.activeChip = chip;
  this.gridApi?.onFilterChanged();
  ```
  The external filter is ANDed with the quick filter by AG Grid, preserving "both apply."
- (b) Change the status column to the community **Text** filter (`agTextColumnFilter`) and drive it
  via `setFilterModel({ orderStatus: { filterType: 'text', type: 'equals', filter: chip } })`.
- Either way, also fix `order-columns.ts` to stop using `agSetColumnFilter` (see Finding 2), since
  it is not available in this build.

### 2. HIGH — `gridApi.setQuickFilter(...)` does not exist in AG Grid 33.3.2; design keeps it "unchanged"

**Where:** Feature C note "The search box continues to call `gridApi.setQuickFilter(value)`
unchanged" (design.md ~389–391); existing `dashboard.component.ts::onQuickFilterChanged`.

Verified against `node_modules/ag-grid-community/dist/types/src/api/gridApi.d.ts` for 33.3.2: the
grid API exposes `resetQuickFilter()` but **not** `setQuickFilter(...)`. The grid-level quick filter
is set via the grid option `quickFilterText` (`gridOptions.d.ts:438 quickFilterText?: string`), i.e.
`api.setGridOption('quickFilterText', value)`. The existing `this.gridApi.setQuickFilter(event.target.value)`
is therefore already a runtime `TypeError`. The design explicitly preserves this call and depends on
it to satisfy AC-13 ("search box still filters alongside the active chip").

**Concrete fix:** Replace the call (and keep it working for the chips to AND against):
```ts
onQuickFilterChanged(event: any): void {
  this.gridApi?.setGridOption('quickFilterText', event.target.value);
}
```
Call this out in the design as a required change to `onQuickFilterChanged`, not an "unchanged"
behavior. Because this touches the search box, remove it from the implicit regression-safe list.

### 3. MEDIUM — AuthService `login()` response type does not include `user_role` / `user_id`

**Where:** Shared building block #2 (AuthService role support), design.md ~250–265;
`src/app/auth/auth.service.ts`.

The design adds `localStorage.setItem('user_role', res.user_role ...)` and
`res.user_id` inside `login()`'s success `map()`. Verified: the current `login()` types the HTTP
response as `http.post<{ access_token: string; user_name: string }>(...)` — `res.user_role` and
`res.user_id` are **not on that type**, so reading them will not compile under
`tsc --noEmit` (AC-19/NFR-5). The backend `TokenResponse` does return both
(`schemas.py`: `user_role: str`, `user_id: int`), so the fields exist at runtime; only the
TS generic is too narrow.

**Concrete fix:** Widen the response generic in the design's AuthService snippet:
```ts
this.http.post<{ access_token: string; user_name: string; user_role: string; user_id: number }>(
  `${environment.apiUrl}/auth/login`, { email, password })
```
and keep the `?? ''` / `!= null` guards for the mock-fallback path where these are absent.

### 4. MEDIUM — Activity feed is fetched by DashboardComponent, but the design never adds `getActivity()` to the dashboard's data flow consistently with the chart being a self-contained component

**Where:** Feature A (FR-5), design.md ~300–330, and "Dashboard orchestration" / FR-3 chart section.

Two conflicting statements about who owns which fetch:
- Feature A says the **dashboard** owns `getActivity(20)` and passes `items`/`loading`/`error` into
  `ActivityFeedComponent` via `@Input()`.
- The FR-3 section says "plus the chart and activity components" track their own state, and the
  chart (`PMRChartComponent`) is modified to own its own `loading/error/empty`.

So the chart self-fetches (via `StatusChartService`) and owns its state, while the activity feed is
fed from the dashboard. That split is defensible, but the design's `refreshAll()` claims to refresh
the chart too ("a single refresh ... update stats, grid, and activity together" and elsewhere
"re-fetches grid + stats + activity"). The **chart is not in that list** and has no input/trigger to
re-fetch, yet AC-11/AC-16 and the create/delete flows imply the chart should reflect new/removed
orders after a refresh.

**Concrete fix:** Decide and state one model. Recommended: give `PMRChartComponent` a public
`reload()` method (or an `@Input() reloadToken` it reacts to) and have `refreshAll()` call it, so
after create/delete the doughnut/bars update too. Update the design's refresh lists to read
"grid + stats + activity + chart." If the chart is intentionally left stale until navigation, say so
explicitly and reconcile with AC-11.

### 5. MEDIUM — Chart component reads `StatusChartService.ChartOrder` (`.date`), but the design's FR-3 wrapper work risks breaking the "untouched config" guarantee without specifying the subscribe shape

**Where:** FR-3 chart changes, design.md ~290–298; `pmr-chart.component.ts`,
`status-chart.service.ts`.

The design says it adds `loading/error/empty` to `PMRChartComponent` and "the error branch reuses
`<app-error-banner>`", but `PMRChartComponent` currently calls
`this.orderService.getOrders().subscribe((orders) => {...})` with a **next-only** callback and no
error arm. To add an error state you must convert this to `{ next, error }` and set
`this.error`/`this.loading`. The design does not show this and asserts the subscription stays
otherwise untouched; adding `imports: [ErrorBannerComponent, EmptyStateComponent, LoadingSpinnerComponent]`
to the chart component is also required but is not listed in the chart's "Modified" entry (only
"loading/error/empty flags and wrappers" are mentioned).

**Concrete fix:** In the design, specify for `PMRChartComponent`:
- add `loading=true/error:string|null/empty=false` fields;
- rewrite the subscribe to `{ next: orders => { ...; this.loading=false; this.empty = orders.length===0; }, error: err => { this.error = messageFor(err); this.loading=false; } }`;
- add the three shared state components to the component's `imports`;
- confirm the `charts-wrapper` is only *wrapped*, not restructured (COLORS/STATUS_ORDER/options stay).

### 6. MEDIUM — "Avg Accuracy" KPI averages only the loaded page/rows, but the design claims it averages "all orders" — reconcile with the stats-vs-rows rule (AC-1/AC-3)

**Where:** FR-1/FR-2, design.md ~215–245.

`avgAccuracy` is defined as "mean of `rowData.map(r => r.accuracyNum)`". `getLabelOrders()` → `GET /orders`
returns up to the backend `limit` (default 100, the seed is 30), so for the seed this equals all
orders — fine. But two frictions:
1. The design elsewhere is emphatic that KPI cards must **not** derive from `rowData`
   (AC-1: "changing the grid page/filter does not change KPI counts"). Avg Accuracy *does* derive
   from `rowData`. That is acceptable per the requirements' resolved assumption (stats has no
   accuracy field), but the design should explicitly state that Avg Accuracy is computed over the
   **full loaded order set and is NOT affected by chip/quick-filter/pagination** — otherwise a naive
   implementation that reads filtered rows would violate AC-1's spirit for that one card.
2. `avgAccuracy` must ignore the client-side chip filter. If chips use an external filter
   (Finding 1), ensure the getter reads `this.rowData` (all loaded rows), not the grid's
   post-filter nodes.

**Concrete fix:** State: "`avgAccuracy` = mean of `accuracyNum` over the full `rowData` array
(all loaded orders), recomputed only when orders are (re)fetched; it ignores chips/search/pagination,
consistent with AC-1." Confirm the formatting rule ("at most 2 decimals", `—` when empty) matches AC-3.

### 7. MEDIUM — Create-order `image_urls` path vs. `absUrl`: the leading-slash claim needs a one-line correction

**Where:** Feature B submit step 2, design.md ~352–356; `order.service.ts::absUrl`.

The design says uploaded URLs (`/uploads/<name>`) "start with `uploads/` after the leading-slash
strip — consistent with the KEEP rule." Verified `absUrl`: it does `path.replace(/^\//, '')` then
checks `normalized.startsWith('uploads/')` and prefixes with `apiUrl`. That is correct **for display**.
But Feature B stores `image_urls = results.map(r => r.url).join(',')` where each `r.url` is the raw
`/uploads/<name>` (leading slash) sent to `POST /orders`. That is fine — the backend stores the string
as-is and `absUrl` normalizes on read. The subtle issue: the design should confirm it stores the URL
**as returned** (`/uploads/..`) and does not pre-strip the slash, because `toOrder()`/`absUrl` expects
to do the stripping. No behavior bug if left as the backend returns it; the risk is an implementer
"normalizing" twice.

**Concrete fix:** Add one sentence: "Store `r.url` verbatim (e.g. `/uploads/ab12.jpg`); do not strip
the leading slash — `absUrl` handles normalization on read."

### 8. NIT — "activity feed endpoint is `GET /orders/activity`, not `GET /activity`" is correct, but the requirements text (FR-5) says `GET /orders/activity` already

**Where:** Overview, design.md ~18–24.

Verified: the route is registered under `prefix="/orders"` with `@router.get("/activity", ...)`, so
the real path is `/orders/activity` (the docstring in `orders.py` saying `GET /activity` is wrong).
The design's correction is right. Minor: FR-5 in requirements already specifies `GET /orders/activity`,
so the design's framing ("the requirements' phrasing") slightly overstates a conflict that isn't there.
No action needed beyond keeping `/orders/activity`.

### 9. NIT — `ActivityItem.order_ref` guard vs. backend always sending a string

**Where:** Feature A guards, design.md ~322–326; `schemas.py::ActivityOut`.

`ActivityOut.order_ref: str` has no default and the ORM column is non-null in practice, so `order_ref`
is always a string from the real backend. The design's "render the `order_ref` chip only if non-empty"
is a fine UX guard, just note it is cosmetic (empty string), not a null guard.

### 10. NIT — `changeDetection: ChangeDetectionStrategy.Eager` convention

**Where:** "Non-standard pattern to preserve", design.md ~40–52.

Confirmed every existing component uses `ChangeDetectionStrategy.Eager`, which is not a real enum
member (`OnPush`/`Default` only) yet compiles because the enum is a numeric type and `Eager` is… not
defined — this would normally be a `tsc` error. The design mandates copying it into new components.
Verify this actually typechecks under `tsc --noEmit -p tsconfig.app.json` (AC-19) before relying on it;
if the existing files only compile because of loose settings, new files will inherit the same risk.
Not blocking, but the design's "the project compiles with it" should be confirmed by the build step,
not assumed.

### 11. NIT — Feature E CSV `user` column exports `user_id` string; explicitly in scope-cut

**Where:** Feature E, design.md ~420–430; Out of Scope (requirements).

Consistent with the requirements' resolved assumption and Out-of-Scope ("Resolving user_id → name …").
Fine as-is. One concrete nit: the header lists `user` and the row maps `o.user`, which is the
`user_id` string from `toOrder()` — matches AC-15's header exactly. No change needed; flagged only so
the implementer does not "improve" it into a name lookup.

---

## Verified Assumptions (checked against source)

- **`GET /orders` returns `detections[]` per order** — `OrderOut.detections: List[DetectionOut] = []`
  (`schemas.py`). So `detectionCount` can be derived client-side with no extra fetch (Feature F). ✓
- **`GET /orders/stats` returns `{total, completed, in_progress, pending, rejected}`** —
  `DashboardStats` + `get_stats` (`orders.py`). ✓
- **`GET /orders/activity` exists under the `/orders` prefix with `limit` capped at 100** —
  `@router.get("/activity", ... limit: int = Query(20, le=100))`. ✓
- **`POST /orders` returns 201 `OrderOut` and raises 409 on duplicate `order_id`** — confirmed in
  `create_order`. The 409 `detail` is `"order_id already exists"`, so the design's "read the 409 body
  `detail`" is viable. ✓
- **`DELETE /orders/{order_id}` is keyed on the string `order_id`, admin-guarded (403), 204 on success,
  404 if missing** — `delete_order(order_id: str, ... Depends(require_admin))`. ✓
- **`POST /uploads` binds a repeated field named `files`, returns 201 `List[UploadResult]`, each with
  `url` = `/uploads/<name>`** — `upload_images(files: List[UploadFile] = File(...))`, `_store` returns
  `url=f"/uploads/{stored_name}"`. Backend MIME/size guards (`ALLOWED_MIME`, 20 MB default) match the
  design's client-side mirror. ✓
- **`GET /detect/labels` returns `List[str]` (title-cased) with a static fallback** — `get_labels`
  (`yolo.py`). Labeling page already consumes it with a fallback; design correctly leaves labeling
  untouched. ✓
- **`TokenResponse` returns `user_name`, `user_role`, `user_id`** — `schemas.py`; `auth.py` login sets
  all three. So AuthService can persist role/id (Finding 3 is only a TS-typing gap, not a data gap). ✓
- **JWT `sub` is a string** — `create_token` casts `sub` to `str`; `get_current_user` casts back to int.
  The design's NFR-2 "sub stays a string" claim holds; nothing in the design touches it. ✓
- **`absUrl` prefixes only `uploads/` paths with `apiUrl` and leaves `assets/*` relative** — confirmed
  in `order.service.ts`. ✓
- **Same-tab navigation / clickable brand** — `dashboard.component.ts::openLabelingPage` uses
  `router.navigate(['/labeling'], { queryParams })`; `app.component.ts::goHome` →
  `router.navigate(['/dashboard'])`; no `window.open` anywhere. ✓
- **Labeling page** — dynamic labels + fallback, `goBack()` → `/dashboard`, detection via
  `DetectionService`, Accept/Reject (`saveLabeling`/`cancel`) all present; design leaves the file
  unmodified. ✓
- **Chart is live + restyled** — `PMRChartComponent` + `StatusChartService.getOrders()` map
  `created_at→date`, `order_status→orderStatus`; COLORS/STATUS_ORDER/4-month bucketing present. ✓
- **Login flow** — `AuthService.login()` posts to `${apiUrl}/auth/login` with `{email, password}` and
  stores the JWT, with an `auth.json` mock fallback. ✓
- **`forEachNodeAfterFilterAndSort` and `setFilterModel` exist on the v33.3.2 grid API** — confirmed in
  `gridApi.d.ts`. CSV export (Feature E) is feasible as written. ✓
- **`providedIn: 'root'` / standalone discipline** — all existing services are root-provided; all
  components standalone; `main.ts` bootstraps standalone. New services/components fit the pattern. ✓

## Unverified / Wrong Assumptions

- **WRONG — Set Filter availability (Finding 1):** The design assumes a working column Set Filter
  (`agSetColumnFilter`) and `setFilterModel({ filterType: 'set' })`. `ag-grid-community@33.3.2` does
  **not** include `SetFilterModule` (Enterprise-only); only `AllCommunityModule` is registered in
  `main.ts`. The feature cannot work as specified.
- **WRONG — `gridApi.setQuickFilter` (Finding 2):** Not a member of the v33.3.2 grid API
  (`gridApi.d.ts` has `resetQuickFilter` only; quick filtering is via the `quickFilterText` grid
  option). The design keeps this call "unchanged"; it is already broken.
- **NARROW TYPE — AuthService login response (Finding 3):** The fields exist at runtime (backend
  returns them) but the current TS generic omits `user_role`/`user_id`, so the design's snippet will
  not typecheck until the generic is widened.
- **UNVERIFIED — `ChangeDetectionStrategy.Eager` typechecks (Finding 10):** The design asserts the
  project "compiles and runs with it." I did not run `tsc`; `Eager` is not a real enum member, so this
  must be confirmed by the AC-19 build step rather than assumed. New components copying it inherit the
  same risk.
- **UNVERIFIED — chart refresh after create/delete (Finding 4):** The design's `refreshAll()` lists
  grid+stats+activity but not the chart; whether the chart is expected to update post-create/delete is
  not resolved against AC-11/AC-16.

---

## Verdict rationale

HIGH: Findings 1, 2 (both make specified features non-functional against the real AG Grid build).
MEDIUM: Findings 3, 4, 5, 6, 7 (compile gap, ownership/refresh ambiguity, unspecified subscribe
rewrite, AC-1 reconciliation, store-verbatim clarification).
NIT: Findings 8, 9, 10, 11.

HIGH + MEDIUM = 7 (> 0) → **CHANGES_REQUESTED**.
