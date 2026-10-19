"""
Self-asserting integration test for the verification state machine (pytest absent,
so run as a script: `.venv/bin/python tests/test_state_machine.py`).

Uses a throwaway SQLite DB and FastAPI TestClient. Forces YOLO to fail so the test
is fast and deterministic, while proving AI result rows are still persisted and the
case still becomes Submitted (FR-7.5).

Covers: register/login officer → create → attach photo → submit (Submitted +
AIValidationResult rows) → front office request-correction → officer resubmit →
front office approve (Completed). Plus 403/409/422 negative cases.
"""
import os
import sys
import tempfile
import uuid

# Point the app at a throwaway DB BEFORE importing the app.
_tmp_db = os.path.join(tempfile.gettempdir(), f"test_fsv_{uuid.uuid4().hex}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db}"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient
import database
import services.ai_validation as ai

import main  # noqa: E402

# Force the YOLO loader to fail → exercises the resilience fallback (FR-7.5).
ai.get_model = lambda: (_ for _ in ()).throw(RuntimeError("forced yolo failure"))

database.create_tables()
client = TestClient(main.app)


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _register(name, email, role):
    r = client.post("/auth/register", json={
        "name": name, "email": email, "password": "pwd", "role": role,
    })
    assert r.status_code == 201, r.text
    return r.json()["access_token"]


def _upload_photo(token):
    # tiny valid jpeg via Pillow
    from PIL import Image
    import io
    buf = io.BytesIO()
    Image.new("RGB", (640, 480), (100, 110, 120)).save(buf, "JPEG")
    buf.seek(0)
    r = client.post("/uploads/single",
                    files={"file": ("site.jpg", buf, "image/jpeg")},
                    headers=_auth(token))
    assert r.status_code == 201, r.text
    return r.json()["url"]


def run():
    officer = _register("Officer One", f"officer_{uuid.uuid4().hex}@t.io", "field_officer")
    officer2 = _register("Officer Two", f"officer2_{uuid.uuid4().hex}@t.io", "field_officer")
    office = _register("Reviewer", f"office_{uuid.uuid4().hex}@t.io", "front_office")

    # Create (field officer) → Draft
    r = client.post("/cases", json={"customer_name": "Acme", "site_address": "1 Road"},
                    headers=_auth(officer))
    assert r.status_code == 201, r.text
    case = r.json()
    ref = case["case_ref"]
    assert case["status"] == "Draft"
    assert case["assigned_officer"] == "Officer One"
    print(f"PASS create → Draft ({ref})")

    # Submit with no photos → 422
    r = client.post(f"/cases/{ref}/submit", headers=_auth(officer))
    assert r.status_code == 422, r.text
    print("PASS submit without photo → 422")

    # Attach a photo
    url = _upload_photo(officer)
    r = client.post(f"/cases/{ref}/photos", json={"url": url, "original_name": "site.jpg"},
                    headers=_auth(officer))
    assert r.status_code == 201, r.text

    # GPS out of range → 422
    r = client.put(f"/cases/{ref}/gps", json={"latitude": 100, "longitude": 10, "gps_status": "captured"},
                   headers=_auth(officer))
    assert r.status_code == 422, r.text
    print("PASS gps latitude 100 → 422")

    # Valid GPS
    r = client.put(f"/cases/{ref}/gps", json={"latitude": 24.8, "longitude": 67.0, "gps_status": "captured"},
                   headers=_auth(officer))
    assert r.status_code == 200, r.text
    assert r.json()["gps_status"] == "captured"

    # Owner isolation: officer2 cannot read officer's case → 403
    r = client.get(f"/cases/{ref}", headers=_auth(officer2))
    assert r.status_code == 403, r.text
    print("PASS non-owner read → 403")

    # Officer cannot approve → 403
    r = client.post(f"/cases/{ref}/approve", json={"comment": ""}, headers=_auth(officer))
    assert r.status_code == 403, r.text
    print("PASS officer approve → 403")

    # Approve a Draft (front office) → 409
    r = client.post(f"/cases/{ref}/approve", json={"comment": ""}, headers=_auth(office))
    assert r.status_code == 409, r.text
    print("PASS approve Draft → 409")

    # Submit → Submitted + AI results (even with forced YOLO failure)
    r = client.post(f"/cases/{ref}/submit", headers=_auth(officer))
    assert r.status_code == 200, r.text
    detail = r.json()
    assert detail["status"] == "Submitted"
    assert detail["captured_at"] is not None
    assert len(detail["ai_results"]) >= 1, detail
    photo_result = [x for x in detail["ai_results"] if x["photo_id"] is not None][0]
    assert photo_result["required_objects_pass"] is False
    assert "yolo-unavailable" in photo_result["note"]
    print("PASS submit → Submitted with AI results (fallback engaged)")

    # Reject with empty comment → 422
    r = client.post(f"/cases/{ref}/reject", json={"comment": "   "}, headers=_auth(office))
    assert r.status_code == 422, r.text
    print("PASS reject empty comment → 422")

    # Request correction → Needs Correction
    r = client.post(f"/cases/{ref}/request-correction",
                    json={"comment": "Fix the meter photo"}, headers=_auth(office))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "Needs Correction"
    assert r.json()["review_decision"] == "Needs Correction"
    print("PASS request-correction → Needs Correction")

    # Officer resubmits → Submitted
    r = client.post(f"/cases/{ref}/submit", headers=_auth(officer))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "Submitted"
    print("PASS resubmit → Submitted")

    # Approve → Completed
    r = client.post(f"/cases/{ref}/approve", json={"comment": "Looks good"}, headers=_auth(office))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "Completed"
    assert r.json()["review_decision"] == "Approved"
    print("PASS approve → Completed (decision Approved)")

    # Resubmit a Completed (terminal) → 409
    r = client.post(f"/cases/{ref}/submit", headers=_auth(officer))
    assert r.status_code == 409, r.text
    print("PASS submit Completed → 409")

    # Front office sees all; officer stats restricted to own
    r = client.get("/cases?status=Completed", headers=_auth(office))
    assert r.status_code == 200 and any(c["case_ref"] == ref for c in r.json())
    print("PASS front office list Completed")

    print("\nALL STATE MACHINE TESTS PASSED")


if __name__ == "__main__":
    try:
        run()
    finally:
        if os.path.exists(_tmp_db):
            os.remove(_tmp_db)
