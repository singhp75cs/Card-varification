# Implementation Plan — Wire YOLO detection into the Angular labeling page

## Context discovered during exploration

- Project: Angular 22 standalone-components frontend + FastAPI/YOLOv8 backend (SQLite `pmr_dashboard.db`).
- Build/test commands: frontend `npm install` + `npx ng build` (default config is `production`; do NOT run `ng serve`). Backend: venv + `pip install -r backend/requirements.txt` + `uvicorn main:app --port 8000` run from inside `backend/`.
- `provideHttpClient()` is ALREADY present in `src/app/app.config.ts` — no change needed there.
- `src/environments/environment.ts` has only `{ production: false }`. `environment.prod.ts` has `apiBaseUrl: 'https://api.example.com'`. **angular.json has NO `fileReplacements`**, so `environment.prod.ts` is never swapped in — `ng build` always compiles `environment.ts`. The service therefore imports from `environments/environment` and the real value must live in `environment.ts`.
- Backend `/detect` (router prefix `/detect`, `@router.post("")`) requires auth via `get_current_user`, which uses `OAuth2PasswordBearer` → expects header `Authorization: Bearer <jwt>`. The JWT is decoded with `SECRET_KEY` (`.env`: `pmr-dashboard-super-secret-key-change-in-production`) / `HS256`, and `sub` must be a valid active `User.id`. **There is no dev/bypass path.**
- `yolo.py` ALREADY returns normalized 0..1 coords (`x,y` = top-left fraction, `width,height` = fraction). The `DetectionBox`/`YoloResult` contract is satisfied. **No backend code change is required.**

### Auth finding and chosen approach (concrete)

Finding: `src/app/auth/auth.service.ts` is mock-only. `login()` reads `src/assets/auth.json`, matches email+password, and stores a FAKE token (e.g. `fake-jwt-token-123`) in `localStorage['token']` + name in `localStorage['username']`. `getToken()` returns `localStorage['token']`. That fake token is NOT a real JWT and `jwt.decode` in `backend/routers/auth.py` will reject it → every `/detect` call would 401. So reusing only the stored mock token does NOT authenticate against the real backend.

Chosen approach (minimal, reuses existing storage): Upgrade `AuthService.login()` to call the REAL backend `POST /auth/login` first (JSON body `{ email, password }`, which `LoginRequest` accepts), and on success store the returned `access_token` under the SAME existing key `localStorage['token']` and `user_name` under `localStorage['username']`. On network/backend failure, fall back to the current `auth.json` mock match (preserves offline/dev behavior and existing tests). The seed users in `backend/seed.py` use the SAME emails as `auth.json` (`eve.holt@reqres.in`, `john@example.com`, `bob.doe@example.com`) with password `pwd`, so the same credentials that work in the mock also work against the real backend once `python seed.py` has been run. `DetectionService` reads the token via `AuthService.getToken()` (unchanged key) and sends `Authorization: Bearer <token>`. No new storage key, no new auth mechanism.

Operational prerequisite for a real-token path to actually authenticate: `backend/seed.py` must have been run so matching users exist. This is a run step, not a code change.

### Backend change needed?

No code change. `yolo.py` already emits the normalized contract and `/auth/login` already issues JWTs. The plan touches the backend only to verify it runs (see verification). If, during verification, the reviewer finds the normalized contract is somehow unmet, that would be the only justification to touch `yolo.py` — exploration shows it is already met, so expect no change.

### Scope note

This is a single cohesive feature: a detection service, the labeling-component UI that consumes it, the env/config wiring it imports, and the login upgrade that makes the token real. These pieces are mutually dependent (the component needs the service; the service needs the token; the token needs the login upgrade), so the work is implemented as one ordered sequence rather than split into independent features.

---

# Implementation Plan

- [ ] 1. Add `apiUrl: 'http://localhost:8000'` to the dev environment and a matching entry to the prod environment so the detection service has a stable base URL to import.
      What: In `environment.ts` add `apiUrl: 'http://localhost:8000'` to the exported object. In `environment.prod.ts` add `apiUrl: 'http://localhost:8000'` alongside the existing `apiBaseUrl` (leave `apiBaseUrl` untouched to avoid breaking anything that reads it). Do not add `fileReplacements` to angular.json — out of scope and the service reads `environment.ts` which is what the build compiles.
      Files: src/environments/environment.ts, src/environments/environment.prod.ts
      Verify: `npx ng build` compiles with no TypeScript error referencing `environment` (full build run in step 5; this step just must not introduce a type error).

- [ ] 2. Create the detection service with the YOLO TS interfaces and a `detectImage` method that POSTs multipart form-data with the Bearer token.
      What: Create `DetectionService` (`@Injectable({ providedIn: 'root' })`, constructor-injected `HttpClient` and `AuthService`, matching `order.service.ts` style). Define exported interfaces:
      `export interface DetectionBox { label: string; confidence: number; x: number; y: number; width: number; height: number; }`
      `export interface YoloResult { image_url: string; detections: DetectionBox[]; saved_path: string; }`
      Method `detectImage(file: Blob | File, orderId?: string): Observable<YoloResult>`: build a `FormData` with `file` (append as `('file', file, 'image.jpg')` so a bare Blob gets a filename) and, when `orderId` is provided, `order_id`; read the token via `this.auth.getToken()`; set `headers = new HttpHeaders(token ? { Authorization: 'Bearer ' + token } : {})`; `return this.http.post<YoloResult>(`${environment.apiUrl}/detect`, formData, { headers })`. Do NOT set `Content-Type` manually (let the browser set the multipart boundary).
      Files: src/app/services/detection.service.ts
      Verify: `npx ng build` (step 5) — service compiles with no TS errors.

- [ ] 3. Upgrade `AuthService.login()` to authenticate against the real backend and store the real JWT, falling back to the existing mock on failure; keep `getToken`/`logout`/`isAuthenticated`/`getUsername` unchanged.
      What: Change `login(email, password)` to first `this.http.post<{ access_token: string; user_name: string }>(`${environment.apiUrl}/auth/login`, { email, password })` and `pipe(map(...))` to store `access_token` → `localStorage['token']` and `user_name` → `localStorage['username']`, returning `{ token, name }`. Wrap with `catchError` that falls back to the current `assets/auth.json` match logic (preserved verbatim) so offline/dev and the existing `auth.service.spec.ts` still pass. Import `environment` from `../../environments/environment` and `HttpHeaders`/`catchError`/`of` as needed. The `localStorage` key stays `'token'` so `DetectionService` and `authGuard` keep working unchanged.
      Files: src/app/auth/auth.service.ts
      Verify: `npx ng build` (step 5) — compiles with no TS errors; existing `auth.service.spec.ts` logic (mock fallback) remains satisfiable.

- [ ] 4. Add the "Run YOLO Detection" button and its handler to the labeling component: fetch the current image as a Blob, call the service, convert normalized boxes to canvas pixels, push into `boxes[currentImageIndex]`, redraw; with loading + error state. Manual drawing stays untouched.
      What:
      - `.ts`: inject `DetectionService` in the constructor (keep existing `ActivatedRoute`). Add fields `isDetecting = false;` and `detectionError = '';`. Add `async runDetection(): Promise<void>` that: returns early if `!this.isEditable` or `this.isDetecting`; sets `isDetecting = true`, `detectionError = ''`; `const src = this.images[this.currentImageIndex];` guard empty; `const resp = await fetch(src);` then `const blob = await resp.blob();` (handles data/asset/remote URLs the same way); call `this.detection.detectImage(blob, this.orderId)` and subscribe/`firstValueFrom`. On success: guard `result?.detections?.length`; for each detection guard that `x,y,width,height,label` are present/finite, compute `px_x = box.x * canvas.width`, `px_y = box.y * canvas.height`, `px_w = box.width * canvas.width`, `px_h = box.height * canvas.height` using `this.canvasRef.nativeElement`, push `{ x: px_x, y: px_y, w: px_w, h: px_h, label: box.label }` into `this.boxes[this.currentImageIndex]` (ensure the array exists), then `this.drawBoxes()`. On error: set a user-facing `detectionError` message mapping statuses — 401 → "Not authorized. Please log in again.", 503 → "Detection model unavailable. Try again shortly.", 0/unknown → "Could not reach the detection service." Always clear `isDetecting` in a `finally`. Do NOT modify `startDraw/draw/endDraw/drawBoxes/resizeCanvas` logic.
      - `.html`: in the existing Action Buttons `<div class="mt-4">`, add before/with the Accept button: `<button *ngIf="isEditable" class="btn btn-primary btn-lg px-4 py-2 me-3" (click)="runDetection()" [disabled]="isDetecting"><span *ngIf="isDetecting" class="spinner-border spinner-border-sm me-2"></span>{{ isDetecting ? 'Detecting…' : 'Run YOLO Detection' }}</button>` and an error line `<div *ngIf="detectionError" class="text-danger mt-2">{{ detectionError }}</div>`.
      - `.scss`: no new rules required (reuses existing `.text-danger` and Bootstrap button classes); only add a rule if a spacing tweak is needed, keeping the existing style.
      Files: src/app/labeling/labeling.component.ts, src/app/labeling/labeling.component.html, src/app/labeling/labeling.component.scss
      Verify: `npx ng build` (step 5) — compiles with no TS/template errors.

- [ ] 5. Verify the frontend builds cleanly end to end.
      What: Install deps and run a production build.
      Files: (none)
      Verify: `npm install` then `npx ng build` from the repo root (`/Users/irfan/Downloads/DashBoard-GenAI-master`) completes with exit code 0 and NO TypeScript/template errors. Do NOT run `ng serve`. (A pre-existing `anyComponentStyle` budget warning is acceptable; TS errors are not.)

- [ ] 6. Verify the backend runs and the `/detect` route is registered (operational verification; no backend code change expected).
      What: Create venv, install backend deps, seed the DB, start uvicorn, confirm health; confirm `/detect` is registered.
      Files: (none; running `python seed.py` only populates the SQLite DB)
      Verify: from `/Users/irfan/Downloads/DashBoard-GenAI-master/backend`: `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`, then `python seed.py` (expect "Seed complete"), then `uvicorn main:app --port 8000` in the background and `curl -s http://localhost:8000/health` returns `{"status":"healthy"}`.
      Fallback (if `ultralytics`/`torch` install is too heavy or fails to install in the environment): skip the full inference stack and instead confirm the route is registered — `curl -s http://localhost:8000/openapi.json | grep -q '"/detect"'` (or open `/docs`) returns a match, proving the YOLO router is mounted. The model only loads lazily on the first `/detect` call, so route registration does not require torch. Document in findings whether the full stack installed or the fallback was used.

---

## Verification results (iteration 1 — actually run)

Environment note: the system default `node` is v20.20.2, which Angular CLI rejects (requires >= v22). nvm had v22.23.3 installed; all frontend builds below were run under `nvm use 22.23.3`.

### Frontend

- `node_modules` was already present (no `npm install` needed).
- `npx ng build` (default = production): compilation succeeded with NO TypeScript/template errors; all chunks built, including `labeling-component`. The build's non-zero gate is a PRE-EXISTING `initial` bundle-size budget: initial total 1.95 MB vs the `maximumError: "1mb"` in `angular.json` (driven by Bootstrap/ag-grid/charts, not this feature — the change adds only a small service + method). This budget threshold is pre-existing config, unrelated to the change.
- `npx ng build --configuration development` (no budgets): **exit 0**, "Application bundle generation complete." This confirms clean TS/template compilation of the new `DetectionService`, the `AuthService` login upgrade, and the labeling-component button/handler. Output location dist was removed as a temp artifact.

### Backend

- Created temp venv `backend/.venv`, upgraded pip, `pip install -r requirements.txt` — **full stack installed successfully**, including `torch==2.8.0`, `torchvision==0.23.0`, and `ultralytics==8.2.18` (Python 3.9.6 on macOS arm64).
- `python seed.py` **failed** due to a pre-existing dependency-pin incompatibility: `passlib==1.7.4` with the resolved `bcrypt==5.0.0` raises `ValueError: password cannot be longer than 72 bytes` during passlib's bcrypt backend self-test. requirements.txt pins passlib but not bcrypt, so a newer bcrypt was pulled in. This is an environment/pinning issue, NOT caused by this change, and does not affect route registration (the YOLO model and auth both load/verify lazily). Seeding is a run step, not a code change in scope.
- Started `uvicorn main:app --port 8000`: startup completed ("Application startup complete").
- `curl -s http://localhost:8000/health` → `{"status":"healthy"}` ✅
- `/detect` route registration confirmed via `curl -s http://localhost:8000/openapi.json`: paths include `/detect`, `/detect/order/{order_id}` (and `/orders/{order_id}/detections`). The POST `/detect` endpoint the frontend calls is mounted. ✅
- Real YOLO inference was NOT exercised (no live /detect POST run), so no claim is made that inference works end to end; route registration + health were verified instead. The normalized-coordinate contract in `yolo.py`/`schemas.py` was confirmed by reading the code (x,y,width,height normalized 0..1, matching the TS interfaces) — no backend code change was required or made.
- Cleanup: uvicorn stopped, temp `backend/.venv`, the generated empty `backend/pmr_dashboard.db`, the `dist/` build output, and `/tmp` helper/log files all removed.

## Notes / assumptions

- `apiUrl` is hard-coded to `http://localhost:8000` per the task default; it matches the backend's documented run port and the CORS allow-list already permits `http://localhost:4200`/`4201`.
- The normalized→pixel conversion uses live canvas dimensions at draw time, matching manual-box behavior; no re-conversion on resize (parity with existing boxes), as specified.
- All model output is treated as untrusted: empty detection lists and missing/non-finite box fields are guarded before pushing to `boxes`.
- Reviewer stop contract unchanged: this plan is implemented by the existing loop; the reviewer writes `/Users/irfan/Downloads/DashBoard-GenAI-master/.agents/tasks/review.json` with `verdict` = `APPROVED` to stop.
