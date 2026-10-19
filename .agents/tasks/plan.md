# Implementation Plan — Wire PMR Dashboard to the real FastAPI backend (orders + labeling)

Goal: OrderService and LabelingService must read/write the live FastAPI backend
(`environment.apiUrl`, default `http://localhost:8000`) using `auth.getToken()` for
Bearer auth, instead of the mock JSON files in `src/assets`. Add one backend
endpoint to persist drawn labels. Keep YOLO detection and auth untouched.

Design decisions (made during exploration, grounded in code):
- `dashboard.component.ts` is the ONLY consumer of `OrderService` (via `getLabelOrders()`;
  `getOrders()` is unused). The chart uses a *separate* `StatusChartService` reading
  `assets/dataChart.json` — OUT OF SCOPE, do not touch.
- `labeling.component.ts` currently imports only `DetectionService`; wiring in
  `LabelingService` (load existing labels, real save, real upload) is net-new there.
- Backend `OrderOut` has `user_id` (int, nullable) but NO user name. The grid shows a
  `user` column, so map `user_id` → `String(user_id ?? '')`. Keep the camelCase `Order`
  interface so the grid's `ORDER_COLUMNS` (orderId/orderType/orderStatus/label/user/
  accuracy/comment) keep working unchanged.
- `accuracy` is a `float` on the backend but the grid/labeling just display it; map to a
  string for display parity with the old `"90:00%"` style is unnecessary — pass the number
  through as-is (ag-grid renders numbers fine). Keep `Order.accuracy: string` by coercing
  to string to avoid changing `order-columns.ts`.
- Coordinate contract: `Detection` rows store NORMALIZED 0..1 coords; the labeling canvas
  works in PIXELS. Frontend converts px→norm before PUT (divide by live canvas w/h) and
  norm→px when loading (multiply by live canvas w/h). This mirrors the existing
  `runDetection()` conversion already in `labeling.component.ts`.
- Backend change is additive: one new endpoint `PUT /orders/{order_id}/labels` + one new
  schema `LabelBoxIn`, following the exact delete-then-insert pattern from
  `yolo.py::detect_order_images` and the `_log` helper in `orders.py`.

Build/verify commands (discovered):
- Frontend: `npx ng build --configuration development` (Angular 22, strict + strictTemplates).
- Backend: no pytest in `requirements.txt`; verify by running `uvicorn main:app --port 8000`
  from `backend/` and exercising endpoints with `curl` + a real JWT from `/auth/login`.
- `python -c "import main"` from `backend/` is a cheap import-sanity check for the Python edits.

---

- [ ] 1. BACKEND: add the `LabelBoxIn` schema.
      Add to `backend/schemas.py`, after the `DetectionBox`/`DetectionOut` block (near the
      Detection section), a Pydantic v2 model:
      `class LabelBoxIn(BaseModel): label: str; confidence: float = 1.0; x: float; y: float; width: float; height: float; image_path: str = ""`.
      Coords are documented as NORMALIZED 0..1. No wrapper model needed — the endpoint
      accepts `List[LabelBoxIn]` directly.
      Files: `backend/schemas.py`
      Verify: `cd backend && python -c "import schemas; schemas.LabelBoxIn(label='x', x=0.1, y=0.1, width=0.2, height=0.2)"` prints no error.

- [ ] 2. BACKEND: re-export `LabelBoxIn` from the models package (keep in sync).
      Add `LabelBoxIn` to the `from schemas import (...)` list and `__all__` in
      `backend/models/schemas.py`, and to the `from .schemas import (...)` block and
      `__all__` in `backend/models/__init__.py` (place it near `DetectionBox`/`DetectionOut`).
      Files: `backend/models/schemas.py`, `backend/models/__init__.py`
      Verify: `cd backend && python -c "from models import LabelBoxIn; from models.schemas import LabelBoxIn"` exits 0.

- [ ] 3. BACKEND: add `PUT /orders/{order_id}/labels` endpoint.
      In `backend/routers/orders.py`: import `LabelBoxIn` on the existing
      `from schemas import ...` line. Add an endpoint below `get_detections`:
      `@router.put("/{order_id}/labels", response_model=OrderOut)` taking
      `order_id: str`, `body: List[LabelBoxIn]`, `db`, `current = Depends(get_current_user)`.
      Behavior: look up order by `order_id` (404 if missing); delete existing
      `Detection` rows where `order_id_fk == order.id` (same as yolo bulk-clear);
      insert one `Detection` per box (`order_id_fk=order.id`, `image_path=b.image_path or ""`,
      `label`, `confidence`, `x`, `y`, `width`, `height`); `db.commit()`; `db.refresh(order)`;
      call `_log(db, current.name, f"Saved {len(body)} labels for order {order_id}", order_id, "success")`;
      return `order` (serialized as `OrderOut` with fresh `detections`).
      Docstring MUST state the normalized-0..1 coordinate contract and that the frontend
      converts px↔norm.
      Files: `backend/routers/orders.py`
      Verify: `cd backend && python -c "import main"` exits 0 (router imports and mounts).
      Then live: start `uvicorn main:app --port 8000`, obtain a token via
      `curl -s -X POST localhost:8000/auth/login -H 'Content-Type: application/json' -d '{"email":"...","password":"..."}'`,
      and `curl -X PUT localhost:8000/orders/<id>/labels -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '[{"label":"Car","x":0.1,"y":0.1,"width":0.2,"height":0.3}]'`
      returns 200 with an `OrderOut` whose `detections` contains the posted box; a second
      PUT with a different list REPLACES (not appends) the detections.

- [ ] 4. FRONTEND: rewrite `OrderService` to use the backend.
      Replace mock JSON reads in `src/app/services/order.service.ts`. Inject `AuthService`
      and import `environment`. Keep the camelCase `Order` interface (grid depends on it).
      Add a private `authHeaders()` returning `HttpHeaders` with `Authorization: Bearer <token>`
      when a token exists (reuse the `detection.service.ts` pattern). Add a private
      `mapOrder(o: any): Order` that maps backend `OrderOut`:
      `orderId=o.order_id`, `orderType=o.order_type`, `orderStatus=o.order_status`,
      `comment=o.comment ?? ''`, `user=String(o.user_id ?? '')`, `accuracy=String(o.accuracy ?? '')`,
      `label=o.label ?? ''`, and `imageUrl` = split `o.image_urls` (comma-separated string;
      guard null/empty) into an array, prefixing each path that starts with `/uploads` or
      is relative with `environment.apiUrl` to build absolute URLs (leave `http(s)://` and
      `assets/` paths as-is). Implement:
      `getLabelOrders(): Observable<Order[]>` → GET `${apiUrl}/orders` with headers, `.pipe(map(list => (list ?? []).map(mapOrder)))`.
      Also provide `getOrders()` as an alias returning the same (keeps any future caller working),
      plus `getStats()` GET `/orders/stats`, `getOrder(id)` GET `/orders/{id}` (mapped),
      `createOrder(body)` POST `/orders`, `updateOrder(id, body)` PUT `/orders/{id}` — all with
      auth headers. Remove `ordersUrl`/`jsonUrl` fields. Treat responses as untrusted (null guards).
      Files: `src/app/services/order.service.ts`
      Verify: covered by step 7 build.

- [ ] 5. FRONTEND: rewrite `LabelingService` to use the backend.
      In `src/app/services/labeling.service.ts`: inject `AuthService`, import `environment`,
      add the same `authHeaders()` helper. Update interfaces: keep `LabelBox` but align to
      backend by adding optional `confidence?: number` and `image_path?: string` (keep
      `x,y,w,h,label` so the component compiles). Remove `jsonUrl` and
      `getLabelingData()`/`fake-labels.json`. Implement:
      `getLabelsByOrderId(orderId): Observable<DetectionOut-like[]>` → GET
      `${apiUrl}/orders/${orderId}/detections` with headers; return raw stored boxes
      (NORMALIZED coords `{label, confidence, x, y, width, height, image_path}`), null-guarded
      to `[]`. The caller converts normalized→pixel.
      `saveLabeling(orderId, labels): Observable<any>` → real PUT
      `${apiUrl}/orders/${orderId}/labels` with headers, body = the normalized box list
      (shape `{label, confidence?, x, y, width, height, image_path?}`). Remove the setTimeout stub.
      `uploadImage(file: File): Observable<UploadResult>` → real POST
      `${apiUrl}/uploads/single` with `FormData` field `file` and auth headers (no manual
      Content-Type). Define/return an `UploadResult`-shaped interface `{filename, original_name,
      url, size, content_type}` with `url` left as returned (caller prefixes apiUrl for absolute).
      Remove the setTimeout stub.
      Files: `src/app/services/labeling.service.ts`
      Verify: covered by step 7 build.

- [ ] 6. FRONTEND: wire consumers to the new Observables + px↔norm + error state.
      `src/app/dashboard/dashboard.component.ts`: `getLabelOrders()` now returns mapped
      `Order[]`; keep the existing `.subscribe({ next, error })` but add an `errorMessage`
      field set in the `error` handler (distinguish 401 → "Please log in again" vs other →
      "Could not load orders"). No template change strictly required, but set the field so a
      backend-down/401 state is observable.
      `src/app/labeling/labeling.component.ts`: inject `LabelingService`. On init (after
      images resolved), call `labeling.getLabelsByOrderId(this.orderId)` and, once the canvas
      is sized, convert each stored NORMALIZED box to pixels
      (`x: box.x*canvas.width, y: box.y*canvas.height, w: box.width*canvas.width,
      h: box.height*canvas.height, label: box.label`) into `boxes[currentImageIndex]`, guarding
      non-finite values (mirror `runDetection()`); then `drawBoxes()`. Set a `loadError` field on failure.
      Rewrite `saveLabeling()` to actually persist: take `boxes[currentImageIndex]`, convert
      px→norm (`x: b.x/canvas.width, y: b.y/canvas.height, width: b.w/canvas.width,
      height: b.h/canvas.height, label: b.label, confidence: 1`), guard `canvas.width>0 &&
      canvas.height>0`, and call `labeling.saveLabeling(this.orderId, normBoxes).subscribe({...})`,
      setting a `saveError`/success flag instead of the current `alert()`/`console.log` mocks.
      Keep manual drawing and the `runDetection()` YOLO button unchanged. Keep `cancel()` clearing boxes.
      If the template needs it, add `*ngIf` error spans next to existing `detectionError` using
      the new fields (`loadError`, `saveError`) in `labeling.component.html` and `errorMessage`
      in `dashboard.component.html`.
      Files: `src/app/dashboard/dashboard.component.ts`, `src/app/dashboard/dashboard.component.html`,
      `src/app/labeling/labeling.component.ts`, `src/app/labeling/labeling.component.html`
      Verify: covered by step 7 build.

- [ ] 7. FRONTEND: build the app and confirm it compiles under strict templates.
      Files: (none — verification)
      Verify: `cd /Users/irfan/Downloads/DashBoard-GenAI-master && npx ng build --configuration development`
      completes with no TypeScript/template errors.

- [ ] 8. INTEGRATION: live backend exercise of the new label-persistence path.
      Start the backend (`cd backend && uvicorn main:app --port 8000`), log in to get a JWT,
      ensure at least one order exists (create via `POST /orders` if needed), then:
      PUT a normalized label list to `/orders/<id>/labels` (expect 200 + OrderOut with those
      detections), GET `/orders/<id>/detections` (expect the same boxes back), PUT a different
      list (expect replacement, not append), and GET `/orders` (expect mapped list the
      dashboard consumes). Confirm an ActivityLog "Saved N labels" entry via `GET /orders/activity`.
      Files: (none — verification)
      Verify: all four curl calls return the expected status/shape described above.

Notes / assumptions:
- JSON asset files are NOT deleted (per constraints); services simply stop reading them.
- `StatusChartService`/`dataChart.json` and the login mock fallback are intentionally left
  as-is — out of scope for this task.
- If the backend has no seeded user, step 8 may require registering one via `POST /auth/register`
  first; this is a data prerequisite, not a code gap.
