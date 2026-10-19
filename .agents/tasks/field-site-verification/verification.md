# Verification — Field Site Verification Workflow

All changes were made **in place** in the existing repo-root project:
`/Users/irfan/Downloads/DashBoard-GenAI-master/src` (Angular) and
`/Users/irfan/Downloads/DashBoard-GenAI-master/backend` (FastAPI). **No git worktree,
no `.worktrees` directory, no second/parallel/duplicate project or `src` tree** was
created, and **no git commits/branches/pushes** were made — the working tree is left
modified and uncommitted for review (HEAD is still the pre-existing commit
`837fee2`). Confirmed: `ls .worktrees` → "No such file or directory"; the only `src`
directory (outside `backend/.venv`) is the real one.

No new Python or npm packages were added. Python runs under
`backend/.venv/bin/python` (3.9.6, Pillow 10.3.0, ultralytics 8.3.40); the frontend
builds under nvm Node 22.23.3.

---

## 1. Backend import health (NFR-5, shim sync)

```
cd backend
.venv/bin/python -c "import main"    → exit 0
.venv/bin/python -c "import models"  → exit 0   (proves orm/schemas/__init__ shims are in sync)
.venv/bin/python -c "import main, models"  → "BACKEND IMPORT OK"
```

`/openapi.json` lists all `/cases*` and `/uploads/document` routes and **no**
`/orders*` or `/detect*` routes (grep for order/detect → `[]`).

## 2. DB reset + seed (NFR-6)

```
rm -f /Users/irfan/Downloads/DashBoard-GenAI-master/backend/pmr_dashboard.db
cd /Users/irfan/Downloads/DashBoard-GenAI-master/backend
.venv/bin/python seed.py
```

Output:
```
✅  Created 4 users
✅  Created 6 verification cases
✅  Created 7 activity log entries
```

Seeded cases `VC001`–`VC006` cover every status (Draft, Submitted, Needs Correction,
Rejected, Completed) and reviewed cases carry `review_decision`/`reviewer`/`review_comment`.
AI results for submitted/reviewed cases were produced by calling the **real**
`services.ai_validation.validate_case` on the seeded photo paths, so seed data matches
live output. The DB is left freshly seeded for the user.

### Demo credentials (password `pwd` for all)

| Role          | Email                 | Name         |
|---------------|-----------------------|--------------|
| admin         | admin@example.com     | System Admin |
| field_officer | officer@example.com   | Fatima Noor  |
| field_officer | officer2@example.com  | Ali Raza     |
| front_office  | office@example.com    | Review Desk  |

The known passlib 1.7.4 / bcrypt 72-byte self-test issue is handled by `seed.py`'s
direct-`bcrypt.hashpw` fallback (kept verbatim), which is the hash path that actually
runs. Login verification succeeded at runtime for both officer and front-office users
(see curl §1 below), so no auth change was needed.

## 3. Backend tests (pytest absent → runnable self-asserting scripts)

```
cd backend
.venv/bin/python tests/test_ai_validation.py   → ALL AI VALIDATION TESTS PASSED
.venv/bin/python tests/test_state_machine.py    → ALL STATE MACHINE TESTS PASSED
```

- `test_ai_validation.py`: REAL Pillow photo-quality path on a generated fixture;
  forced-YOLO-failure → fallback note + `required_objects_pass=False` with no raise;
  document heuristic (confidence 1.0 on match) + OCR stub (`ocr_text`/`extracted_fields` None);
  empty case → single `"no assets"` row.
- `test_state_machine.py` (throwaway DB, YOLO forced to fail to prove FR-7.5):
  create→Draft, submit-without-photo→422, gps 100→422, non-owner read→403, officer
  approve→403, approve Draft→409, submit→Submitted with persisted AI rows (fallback
  note), reject empty comment→422, request-correction→Needs Correction, resubmit→
  Submitted, approve→Completed (decision Approved), submit Completed→409, front-office
  list Completed.

## 4. Live curl state-machine transcript (uvicorn on :8000, real seeded DB)

Server started with `.venv/bin/python -m uvicorn main:app --port 8000` (stopped
afterward). Observed status codes / shapes (new case `VC008`):

| Step | Request | Observed |
|---|---|---|
| 1 | POST /auth/login (officer@ / office@, pwd) | 200, tokens; `user_role` field_officer / front_office |
| 2 | POST /cases (officer) | **201**, status `Draft`, `assigned_officer`=Fatima Noor, auto `case_ref` VC008 |
| 3 | POST /cases/VC008/submit (no photo) | **422** `"At least one photo is required before submitting"` |
| 4 | POST /uploads/single (jpeg) | **201**, `/uploads/<hash>.jpg` |
| 5 | POST /cases/VC008/photos | **201** |
| 6 | POST /uploads/document (pdf) | **201**, `/uploads/<hash>.pdf` |
| 7 | POST /cases/VC008/documents (Utility Bill) | **201** |
| 8 | PUT /cases/VC008/gps latitude 100 | **422** (≤ 90) |
| 9 | PUT /cases/VC008/gps valid | **200**, `gps_status` captured |
| 10 | POST /cases/VC008/approve (officer) | **403** "Front office access required" |
| 11 | POST /cases/VC008/submit | **200**, status `Submitted`, `captured_at` set server-side, **2 AIValidationResult rows** |
| 12 | GET /cases?status=Submitted (front office) | **200**, VC008 present |
| 13 | GET /cases/VC008 (front office) | **200**, photos 1 / documents 1 / ai_results 2 / gps captured |
| 14 | POST /cases/VC008/reject empty comment | **422** "A review comment is required" |
| 15 | POST /cases/VC008/request-correction | **200**, status `Needs Correction`, decision `Needs Correction`, reviewer Review Desk |
| 16 | POST /cases/VC008/submit (officer resubmit) | **200**, status `Submitted`, AI re-run (2 rows) |
| 17 | POST /cases/VC008/approve | **200**, status `Completed`, decision `Approved`, `reviewed_at` set |
| 18 | POST /cases/VC008/submit (terminal) | **409** "Cannot submit a case in status 'Completed'" |
| 19 | GET /cases/activity | transition log entries: Created / Attached photo / Attached document / Set GPS / Submitted (×2, "ran AI validation (2 result(s))") / Needs Correction / Approved |
| 20 | GET /cases/stats (front office) | `{total:8, draft:2, submitted:2, needs_correction:1, rejected:1, completed:2}` |

### Stored AIValidationResult rows (step 11) — REAL structured data

Photo row:
```
photo_id=7, photo_quality_score=0.6868, photo_quality_pass=true,
required_objects=[{building,false},{signage,false},{meter,false}],
required_objects_pass=false, note="photo-quality:real; objects:yolo"
```
Document row:
```
document_id=7, document_type_detected="Utility Bill", document_type_confidence=1.0,
ocr_text=null, extracted_fields=null, note="document-type:heuristic; ocr:stub"
```

The `objects:yolo` provenance (not `yolo-unavailable`) confirms the **real YOLOv8
model ran on the happy path** (`backend/yolov8n.pt` via ultralytics 8.3.40).

## 5. What is REAL vs HEURISTIC vs STUB (FR-7.4)

- **Photo quality — REAL (Pillow):** resolution + mid-range brightness + a
  Laplacian-like sharpness proxy mapped to a 0..1 score; pass threshold 0.5.
  Unreadable image → score 0.0, pass False, `note="photo-quality: unreadable image"`.
- **Required objects — REAL YOLOv8 (ultralytics):** lazy-loaded exactly like the old
  `routers/yolo.py::get_model` (`_allow_ultralytics_globals()` + `YOLO(YOLO_MODEL)`),
  detections mapped case-insensitively onto `["building","signage","meter"]`;
  `required_objects_pass = all(present)`. The try/except fallback (all present=False,
  `note="objects:yolo-unavailable (...), fallback"`) runs **only** if model load/
  inference raises (FR-7.5) — never on the happy path, as confirmed above.
- **Document type — HEURISTIC:** officer-selected type cross-checked against filename/
  extension/content-type keywords; confidence 1.0 on match else 0.5.
- **OCR / extracted fields — STUB:** `ocr_text=null`, `extracted_fields=null`,
  `note` carries `ocr:stub`; the Front Office UI shows "OCR not available".

## 6. Frontend build (NFR-5, acceptance 22)

```
. ~/.nvm/nvm.sh && nvm use 22.23.3
cd /Users/irfan/Downloads/DashBoard-GenAI-master
npx ng build --configuration development
```
→ **Application bundle generation complete**, exit 0, **zero TS/template errors or
warnings** (strict + strictTemplates). `dist/` was deleted afterward.

## 7. In-place / no-git confirmation

- No `.worktrees` directory, no duplicate project or second `src` tree.
- No commits/branches/pushes; `git status` shows only modified/added working-tree files.
- Temp fixtures and the local uvicorn process were cleaned up; the local SQLite DB is
  left freshly seeded.
