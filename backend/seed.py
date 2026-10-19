"""
Seed the database with demo users and verification cases.

DB RESET PROCEDURE (the schema changed from the old labeling domain, so the old
SQLite file MUST be deleted first):

    cd backend
    rm -f pmr_dashboard.db
    .venv/bin/python seed.py

create_tables() runs below, so deleting the file and re-seeding yields a fresh
schema. This is a LOCAL-ONLY operation — no git writes, no network egress.
"""
import glob
import os
import random
from datetime import datetime, timedelta

from database import (
    SessionLocal, User, VerificationCase, CasePhoto, CaseDocument,
    AIValidationResult, ActivityLog, create_tables,
)
from services.ai_validation import AssetRef, validate_case

UPLOAD_DIR = os.getenv("UPLOAD_DIR", "uploads")


def hash_password(plain: str) -> str:
    """Hash a password with bcrypt.

    passlib 1.7.4 reads bcrypt.__about__ which newer bcrypt removed, raising at
    hash time. Try passlib first; if its bcrypt backend is broken, fall back to
    the bcrypt library directly so seeding always works. The resulting hash is a
    standard bcrypt hash either way, verifiable by the auth router's passlib
    CryptContext.
    """
    try:
        from passlib.context import CryptContext
        return CryptContext(schemes=["bcrypt"], deprecated="auto").hash(plain)
    except Exception:
        import bcrypt
        return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


create_tables()
db = SessionLocal()

# ── Clear existing data (children before parents to respect FKs) ─────────────
db.query(AIValidationResult).delete()
db.query(CaseDocument).delete()
db.query(CasePhoto).delete()
db.query(VerificationCase).delete()
db.query(ActivityLog).delete()
db.query(User).delete()
db.commit()

# ── Users ─────────────────────────────────────────────────────────────────────
users_data = [
    {"name": "System Admin", "email": "admin@example.com",    "password": "pwd", "role": "admin"},
    {"name": "Fatima Noor",  "email": "officer@example.com",  "password": "pwd", "role": "field_officer"},
    {"name": "Ali Raza",     "email": "officer2@example.com", "password": "pwd", "role": "field_officer"},
    {"name": "Review Desk",  "email": "office@example.com",   "password": "pwd", "role": "front_office"},
]

created_users = {}
for u in users_data:
    user = User(
        name      = u["name"],
        email     = u["email"],
        hashed_pw = hash_password(u["password"]),
        role      = u["role"],
    )
    db.add(user)
    created_users[u["email"]] = user

db.commit()
for user in created_users.values():
    db.refresh(user)

officer1 = created_users["officer@example.com"]
officer2 = created_users["officer2@example.com"]
reviewer = created_users["office@example.com"]
print(f"✅  Created {len(created_users)} users")

# ── Verification cases spanning every status ─────────────────────────────────
# Reuse real uploaded images so review screens show actual photos.
sample_images = sorted(glob.glob(os.path.join(UPLOAD_DIR, "*.jpg")))


def pick_image(i: int) -> str:
    if not sample_images:
        return "/uploads/placeholder.jpg"
    return "/uploads/" + os.path.basename(sample_images[i % len(sample_images)])


now = datetime.utcnow()

# (case_ref, status, officer, needs review fields, with_document)
cases_spec = [
    ("VC001", "Draft",            officer1, None,               False),
    ("VC002", "Submitted",        officer1, None,               True),
    ("VC003", "Submitted",        officer2, None,               True),
    ("VC004", "Needs Correction", officer1, "Needs Correction", True),
    ("VC005", "Rejected",         officer2, "Rejected",         True),
    ("VC006", "Completed",        officer1, "Approved",         True),
]

review_comments = {
    "Needs Correction": "Please recapture the meter photo in better lighting.",
    "Rejected":         "Details do not match the uploaded identity card.",
    "Approved":         "All checks passed. Verification complete.",
}

created_cases = []
for idx, (ref, status, officer, decision, with_doc) in enumerate(cases_spec, start=1):
    created = now - timedelta(days=(idx * 115) // 6)
    captured = created if status != "Draft" else None

    case = VerificationCase(
        case_ref          = ref,
        status            = status,
        customer_name     = f"Customer {idx}",
        site_address       = f"{idx*10} Main Street, District {idx}",
        site_id           = f"SITE-{idx:03d}",
        contact           = f"+1-555-010{idx}",
        verification_type = "Site Installation" if idx % 2 else "Meter Verification",
        notes             = f"Auto-seeded verification case #{idx}",
        latitude          = round(24.86 + idx * 0.01, 5),
        longitude         = round(67.00 + idx * 0.01, 5),
        gps_status        = "captured",
        captured_at       = captured,
        officer_id        = officer.id,
        created_at        = created,
        updated_at        = created,
    )
    if decision:
        case.review_decision = decision
        case.reviewer        = reviewer.name
        case.review_comment  = review_comments[decision]
        case.reviewed_at     = created + timedelta(hours=2)
    db.add(case)
    db.flush()  # assign case.id

    # Photos (Draft gets one too so the officer form shows thumbnails)
    photo = CasePhoto(
        case_id       = case.id,
        url           = pick_image(idx),
        original_name = f"site_{idx}.jpg",
        caption       = "Site front view",
        category      = "Front",
    )
    db.add(photo)
    db.flush()

    doc = None
    if with_doc:
        _card_types = ["Aadhaar Card", "PAN Card", "Insurance Card",
                       "Driving License", "Passport", "Voter ID"]
        _card = _card_types[idx % len(_card_types)]
        doc = CaseDocument(
            case_id       = case.id,
            url           = pick_image(idx + 3),
            original_name = f"{_card.lower().replace(' ', '_')}_{idx}.jpg",
            document_type = _card,
            content_type  = "image/jpeg",
        )
        db.add(doc)
        db.flush()

    # AI results for submitted/reviewed cases — call the real service so seed
    # data matches live output.
    if status in ("Submitted", "Needs Correction", "Rejected", "Completed"):
        photo_refs = [AssetRef("photo", photo.id,
                               os.path.abspath(os.path.join(UPLOAD_DIR, os.path.basename(photo.url))),
                               photo.original_name, "")]
        doc_refs = []
        if doc:
            doc_refs = [AssetRef("document", doc.id,
                                 os.path.abspath(os.path.join(UPLOAD_DIR, os.path.basename(doc.url))),
                                 doc.original_name, doc.content_type, doc.document_type)]
        try:
            results = validate_case(photo_refs, doc_refs)
        except Exception as exc:
            results = [{"photo_id": None, "document_id": None,
                        "photo_quality_pass": False, "required_objects_pass": False,
                        "note": f"ai-error: {exc}"}]
        for r in results:
            db.add(AIValidationResult(case_id=case.id, **r))

    created_cases.append(case)

db.commit()
print(f"✅  Created {len(created_cases)} verification cases")

# ── Activity log ───────────────────────────────────────────────────────────────
activities = [
    (reviewer.name, "Logged in",                       "",      "info"),
    (officer1.name, "Created case VC001",              "VC001", "success"),
    (officer1.name, "Submitted case VC002",            "VC002", "success"),
    (officer2.name, "Submitted case VC003",            "VC003", "success"),
    (reviewer.name, "Needs Correction case VC004",     "VC004", "warning"),
    (reviewer.name, "Rejected case VC005",             "VC005", "error"),
    (reviewer.name, "Approved case VC006",             "VC006", "success"),
]

for idx, (name, action, ref, sev) in enumerate(activities):
    db.add(ActivityLog(
        user_name  = name,
        action     = action,
        order_ref  = ref,
        severity   = sev,
        created_at = datetime.utcnow() - timedelta(minutes=len(activities) - idx),
    ))

db.commit()
print(f"✅  Created {len(activities)} activity log entries")

print("\n🔑  Demo credentials (password is 'pwd' for all):")
for u in users_data:
    print(f"     {u['role']:<14} {u['email']}")
print("\n🚀  Seed complete. Run:  uvicorn main:app --reload --port 8000")

db.close()
