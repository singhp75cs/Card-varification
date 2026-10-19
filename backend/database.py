"""
SQLAlchemy setup + ORM models.
Tables: users, verification_cases, case_photos, case_documents,
        ai_validation_results, activity_log
"""
import os
from datetime import datetime
from dotenv import load_dotenv
from sqlalchemy import (
    create_engine, Column, Integer, String, Float,
    DateTime, ForeignKey, Text, Boolean, JSON
)
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./pmr_dashboard.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False}  # SQLite only
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# ── Canonical status / enum-like constants (single source of truth) ──────────

# All legal VerificationCase.status values. Stored as a plain String column
# (no DB-level enum) to match the migration-free SQLite style. `Approved` is a
# legal review_decision value only — it is never persisted as a `status`
# (approval writes status="Completed" + review_decision="Approved").
CASE_STATUSES = ("Draft", "Submitted", "Approved", "Rejected", "Needs Correction", "Completed")

# Review decisions recorded on the case independently of status.
REVIEW_DECISIONS = ("Approved", "Rejected", "Needs Correction")

# Allowed document/card types for CaseDocument.document_type.
DOCUMENT_TYPES = (
    "Aadhaar Card",
    "PAN Card",
    "Insurance Card",
    "Driving License",
    "Passport",
    "Voter ID",
    "Other",
)

# Allowed gps_status values on a case.
GPS_STATUSES = ("captured", "manual", "unavailable")


# ── ORM Models ───────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id           = Column(Integer, primary_key=True, index=True)
    name         = Column(String(100), nullable=False)
    email        = Column(String(200), unique=True, index=True, nullable=False)
    hashed_pw    = Column(String(200), nullable=False)
    role         = Column(String(20), default="field_officer")   # field_officer | front_office | admin
    is_active    = Column(Boolean, default=True)
    created_at   = Column(DateTime, default=datetime.utcnow)

    cases        = relationship("VerificationCase", back_populates="officer")


class VerificationCase(Base):
    """A field site verification case created and submitted by a field officer."""
    __tablename__ = "verification_cases"

    id                = Column(Integer, primary_key=True, index=True)
    case_ref          = Column(String(50), unique=True, index=True, nullable=False)  # e.g. VC001
    status            = Column(String(50), nullable=False, default="Draft")          # one of CASE_STATUSES
    customer_name     = Column(String(200), nullable=False)
    site_address      = Column(String(400), nullable=False)
    site_id           = Column(String(100), nullable=True)
    contact           = Column(String(100), nullable=True)
    verification_type = Column(String(100), nullable=True)
    notes             = Column(Text, default="")
    latitude          = Column(Float, nullable=True)
    longitude         = Column(Float, nullable=True)
    gps_status        = Column(String(20), nullable=False, default="unavailable")    # one of GPS_STATUSES
    captured_at       = Column(DateTime, nullable=True)      # set server-side at submit (UTC)
    officer_id        = Column(Integer, ForeignKey("users.id"), nullable=False)
    review_decision   = Column(String(30), nullable=True)    # one of REVIEW_DECISIONS
    reviewer          = Column(String(100), nullable=True)
    review_comment    = Column(Text, nullable=True)
    reviewed_at       = Column(DateTime, nullable=True)
    created_at        = Column(DateTime, default=datetime.utcnow)
    updated_at        = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    officer    = relationship("User", back_populates="cases")
    photos     = relationship("CasePhoto", back_populates="case", cascade="all, delete-orphan")
    documents  = relationship("CaseDocument", back_populates="case", cascade="all, delete-orphan")
    ai_results = relationship("AIValidationResult", back_populates="case", cascade="all, delete-orphan")


class CasePhoto(Base):
    """A site photo attached to a verification case."""
    __tablename__ = "case_photos"

    id            = Column(Integer, primary_key=True, index=True)
    case_id       = Column(Integer, ForeignKey("verification_cases.id"), nullable=False, index=True)
    url           = Column(String(300), nullable=False)      # /uploads/<name>
    original_name = Column(String(300), default="")
    caption       = Column(String(300), default="")
    category      = Column(String(100), default="")
    created_at    = Column(DateTime, default=datetime.utcnow)

    case = relationship("VerificationCase", back_populates="photos")


class CaseDocument(Base):
    """A document (image or PDF) attached to a verification case."""
    __tablename__ = "case_documents"

    id            = Column(Integer, primary_key=True, index=True)
    case_id       = Column(Integer, ForeignKey("verification_cases.id"), nullable=False, index=True)
    url           = Column(String(300), nullable=False)      # /uploads/<name>
    original_name = Column(String(300), default="")
    document_type = Column(String(50), nullable=False, default="Other")   # one of DOCUMENT_TYPES
    content_type  = Column(String(100), default="")
    created_at    = Column(DateTime, default=datetime.utcnow)

    case = relationship("VerificationCase", back_populates="documents")


class AIValidationResult(Base):
    """Structured AI validation output persisted per asset (photo/document) per run."""
    __tablename__ = "ai_validation_results"

    id                       = Column(Integer, primary_key=True, index=True)
    case_id                  = Column(Integer, ForeignKey("verification_cases.id"), nullable=False, index=True)
    photo_id                 = Column(Integer, ForeignKey("case_photos.id"), nullable=True)
    document_id              = Column(Integer, ForeignKey("case_documents.id"), nullable=True)
    photo_quality_score      = Column(Float, nullable=True)     # 0..1
    photo_quality_pass       = Column(Boolean, nullable=True)
    required_objects         = Column(JSON, nullable=True)      # [{"name": str, "present": bool}]
    required_objects_pass    = Column(Boolean, nullable=True)
    document_type_detected   = Column(String(50), nullable=True)
    document_type_confidence = Column(Float, nullable=True)     # 0..1
    ocr_text                 = Column(Text, nullable=True)      # stub → None
    extracted_fields         = Column(JSON, nullable=True)      # stub → None
    note                     = Column(String(300), nullable=False, default="")
    created_at               = Column(DateTime, default=datetime.utcnow)

    case = relationship("VerificationCase", back_populates="ai_results")


class ActivityLog(Base):
    """Feeds the real-time notification panel."""
    __tablename__ = "activity_log"

    id           = Column(Integer, primary_key=True, index=True)
    user_name    = Column(String(100), default="System")
    action       = Column(String(200), nullable=False)
    order_ref    = Column(String(50), default="")      # case_ref the entry refers to
    severity     = Column(String(20), default="info")  # info|success|warning|error
    created_at   = Column(DateTime, default=datetime.utcnow)


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_db():
    """FastAPI dependency: yields a DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_tables():
    Base.metadata.create_all(bind=engine)
