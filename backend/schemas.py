"""
Pydantic v2 schemas for request validation and response serialisation.
"""
from __future__ import annotations
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

# Single source of truth for enum-like constants lives in database.py.
from database import GPS_STATUSES, DOCUMENT_TYPES


# ── Auth ──────────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    name:     str
    email:    EmailStr
    password: str
    role:     str = "field_officer"


class LoginRequest(BaseModel):
    email:    EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type:   str = "bearer"
    user_name:    str
    user_role:    str          # field_officer | front_office | admin — stored client-side
    user_id:      int


# ── User ──────────────────────────────────────────────────────────────────────

class UserOut(BaseModel):
    id:         int
    name:       str
    email:      str
    role:       str
    is_active:  bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Verification case (requests) ──────────────────────────────────────────────

class CaseCreate(BaseModel):
    case_ref:          Optional[str] = None   # server auto-generates if omitted
    customer_name:     str = Field(min_length=1, max_length=200)
    site_address:      str = Field(min_length=1, max_length=400)
    site_id:           Optional[str] = Field(default=None, max_length=100)
    contact:           Optional[str] = Field(default=None, max_length=100)
    verification_type: Optional[str] = Field(default=None, max_length=100)
    notes:             Optional[str] = Field(default="", max_length=4000)


class CaseUpdate(BaseModel):          # details editable while Draft / Needs Correction
    customer_name:     Optional[str] = Field(default=None, min_length=1, max_length=200)
    site_address:      Optional[str] = Field(default=None, min_length=1, max_length=400)
    site_id:           Optional[str] = Field(default=None, max_length=100)
    contact:           Optional[str] = Field(default=None, max_length=100)
    verification_type: Optional[str] = Field(default=None, max_length=100)
    notes:             Optional[str] = Field(default=None, max_length=4000)


class GpsUpdate(BaseModel):
    latitude:   Optional[float] = Field(default=None, ge=-90,  le=90)
    longitude:  Optional[float] = Field(default=None, ge=-180, le=180)
    gps_status: str = "captured"   # captured | manual | unavailable

    @field_validator("gps_status")
    @classmethod
    def _status_known(cls, v: str) -> str:
        if v not in GPS_STATUSES:
            raise ValueError(f"gps_status must be one of {GPS_STATUSES}")
        return v

    @model_validator(mode="after")
    def _coords_consistent(self):
        if self.gps_status == "unavailable":
            if self.latitude is not None or self.longitude is not None:
                raise ValueError("coordinates must be null when gps_status is 'unavailable'")
        else:
            if self.latitude is None or self.longitude is None:
                raise ValueError("both latitude and longitude are required unless gps_status is 'unavailable'")
        return self


class PhotoAttach(BaseModel):
    url:           str = Field(min_length=1, max_length=300)
    original_name: Optional[str] = Field(default="", max_length=300)
    caption:       Optional[str] = Field(default="", max_length=300)
    category:      Optional[str] = Field(default="", max_length=100)


class DocumentAttach(BaseModel):
    url:           str = Field(min_length=1, max_length=300)
    original_name: Optional[str] = Field(default="", max_length=300)
    document_type: str = "Other"          # validated against DOCUMENT_TYPES → 422 if unknown
    content_type:  Optional[str] = Field(default="", max_length=100)

    @field_validator("document_type")
    @classmethod
    def _type_known(cls, v: str) -> str:
        if v not in DOCUMENT_TYPES:
            raise ValueError(f"document_type must be one of {DOCUMENT_TYPES}")
        return v


class ReviewAction(BaseModel):            # approve / reject / request-correction body
    comment: Optional[str] = Field(default=None, max_length=4000)
    # reject & request-correction require a non-empty comment; the router enforces 422.


# ── Verification case (responses) ─────────────────────────────────────────────

class PhotoOut(BaseModel):
    id:            int
    case_id:       int
    url:           str
    original_name: str
    caption:       str
    category:      str
    created_at:    datetime

    model_config = {"from_attributes": True}


class DocumentOut(BaseModel):
    id:            int
    case_id:       int
    url:           str
    original_name: str
    document_type: str
    content_type:  str
    created_at:    datetime

    model_config = {"from_attributes": True}


class AIResultOut(BaseModel):
    id:          int
    case_id:     int
    photo_id:    Optional[int] = None
    document_id: Optional[int] = None
    photo_quality_score:   Optional[float] = None
    photo_quality_pass:    Optional[bool]  = None
    required_objects:      Optional[list[dict]] = None   # [{name, present}]
    required_objects_pass: Optional[bool]        = None
    document_type_detected:   Optional[str]   = None
    document_type_confidence: Optional[float] = None
    ocr_text:         Optional[str]  = None
    extracted_fields: Optional[dict] = None
    note:       str
    created_at: datetime

    model_config = {"from_attributes": True}


class CaseOut(BaseModel):                 # list-row shape (no nested children)
    id:            int
    case_ref:      str
    status:        str
    customer_name: str
    site_address:  str
    site_id:           Optional[str]
    contact:           Optional[str]
    verification_type: Optional[str]
    notes:             Optional[str]
    latitude:   Optional[float]
    longitude:  Optional[float]
    gps_status: str
    captured_at: Optional[datetime]
    officer_id:  int
    assigned_officer: Optional[str] = None   # officer display name, populated in router
    review_decision: Optional[str]
    reviewer:        Optional[str]
    review_comment:  Optional[str]
    reviewed_at:     Optional[datetime]
    created_at:  datetime
    updated_at:  datetime

    model_config = {"from_attributes": True}


class CaseDetailOut(CaseOut):             # detail shape with nested children
    photos:     list[PhotoOut]    = []
    documents:  list[DocumentOut] = []
    ai_results: list[AIResultOut] = []


class CaseStats(BaseModel):               # KPI counts per status
    total:            int
    draft:            int
    submitted:        int
    needs_correction: int
    rejected:         int
    completed:        int


# ── Activity log ──────────────────────────────────────────────────────────────

class ActivityOut(BaseModel):
    id:         int
    user_name:  str
    action:     str
    order_ref:  str
    severity:   str
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Uploads ───────────────────────────────────────────────────────────────────

class UploadResult(BaseModel):
    filename:      str   # server-side stored name (unique)
    original_name: str   # client-provided original filename
    url:           str   # public URL, e.g. /uploads/<filename>
    size:          int   # bytes
    content_type:  str = ""
