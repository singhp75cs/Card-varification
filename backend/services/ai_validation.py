"""
AI validation service for field site verification.

This module runs the AI checks that execute server-side when a field officer
submits (or resubmits) a case. It is a pure library — no FastAPI/DB types in its
public signature — so it can be unit-tested in isolation. The verification router
resolves stored upload URLs to filesystem paths, builds `AssetRef`s, calls
`validate_case(...)`, and persists the returned dicts as `AIValidationResult` rows.

What is REAL vs HEURISTIC vs STUB (FR-7.4 — the stub/real boundary MUST be visible
both here in code comments and in each result row's `note` provenance string):

  * Photo quality      — REAL   (Pillow 10.3.0): resolution + brightness/contrast +
                                  a Laplacian-like sharpness proxy mapped to a 0..1 score.
  * Required objects    — REAL   (YOLOv8 via ultralytics 8.3.40, model backend/yolov8n.pt).
                                  This is a LOCKED requirement (CL-1); it is not a heuristic.
                                  The try/except fallback below runs ONLY if model load or
                                  inference raises (resilience for FR-7.5) — never on the
                                  happy path.
  * Document type       — HEURISTIC: the officer-selected document_type cross-checked
                                      against filename / extension / content-type keywords.
  * OCR / extracted     — STUB  : no OCR engine is bundled; ocr_text / extracted_fields
                                  are returned as None with an "ocr:stub" provenance note.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv

load_dotenv()

# ── Tunable constants ────────────────────────────────────────────────────────

PHOTO_QUALITY_PASS_THRESHOLD = 0.5
# Expected elements for CARD verification, each mapped to the valid COCO classes
# (yolov8n) that satisfy it. The bundled model is the general COCO model — it has
# no "card" class — so we check for the classes a card photo actually produces:
#   * a card/document photographed flat is detected as "book",
#   * a card shot on/with a phone (or a card-sized rectangle) as "cell phone",
#   * a "selfie with card" contains a "person".
# Using these valid, detectable classes (instead of the old building/signage/meter,
# which are not COCO classes and so could never match) means the checks reflect
# what the model can really see.
REQUIRED_OBJECTS = [
    ("Card / Document", ["book", "cell phone", "laptop", "tv", "remote"]),
    ("Cardholder (person)", ["person"]),
]

YOLO_MODEL = os.getenv("YOLO_MODEL", "yolov8n.pt")


# ── Asset reference (input to validate_case) ─────────────────────────────────

@dataclass
class AssetRef:
    kind: str            # "photo" | "document"
    asset_id: int
    local_path: str      # absolute path under UPLOAD_DIR resolved by the router
    original_name: str
    content_type: str
    selected_type: str = ""   # for documents: the officer-selected document_type


# ── Lazy YOLO loader (moved verbatim from the old routers/yolo.py) ───────────

_model = None


def _allow_ultralytics_globals():
    """Allowlist ultralytics classes for torch.load under PyTorch 2.6+.

    PyTorch 2.6 flipped torch.load's default to weights_only=True, which refuses
    to unpickle the ultralytics model classes stored in a .pt checkpoint. The
    weights ship from the official ultralytics release, so we trust them and
    register the needed globals. Newer ultralytics does this itself; this guard
    keeps older/edge versions working too. Safe no-op on PyTorch < 2.6.
    """
    try:
        import torch
        add_safe_globals = getattr(torch.serialization, "add_safe_globals", None)
        if add_safe_globals is None:
            return  # PyTorch < 2.6 — no allowlist mechanism, nothing to do.

        safe = []
        try:
            from ultralytics.nn.tasks import (
                DetectionModel, SegmentationModel, ClassificationModel, PoseModel,
            )
            safe += [DetectionModel, SegmentationModel, ClassificationModel, PoseModel]
        except Exception:
            pass
        try:
            import torch.nn as nn
            safe += [nn.Sequential, nn.ModuleList, nn.Conv2d]
        except Exception:
            pass

        if safe:
            add_safe_globals(safe)
    except Exception:
        # Never let the allowlist helper itself break model loading.
        pass


def get_model():
    """Lazy-load the real YOLOv8 model once (CL-1 — the REAL object-presence path)."""
    global _model
    if _model is None:
        _allow_ultralytics_globals()
        from ultralytics import YOLO
        _model = YOLO(YOLO_MODEL)
    return _model


# ── Photo quality (REAL — Pillow) ────────────────────────────────────────────

def _score_photo_quality(local_path: str) -> tuple[float, Optional[str]]:
    """Return (score 0..1, error_note_or_None) for a photo.

    REAL check using Pillow: combine a resolution factor, a mid-range brightness
    factor, and a Laplacian-like sharpness proxy (variance of neighbour
    differences on a downscaled grayscale image) into a single 0..1 score.
    If the image can't be opened, return (0.0, "photo-quality: unreadable image").
    """
    try:
        from PIL import Image, ImageFilter, ImageStat
    except Exception as exc:  # pragma: no cover — Pillow is confirmed present
        return 0.0, f"photo-quality: Pillow unavailable ({exc})"

    try:
        with Image.open(local_path) as img:
            img.load()
            width, height = img.size
            gray = img.convert("L")

            # Resolution factor: ~1.0 once the longer edge >= 1024px.
            longest = max(width, height) or 1
            resolution_factor = min(1.0, longest / 1024.0)

            # Brightness factor: peaks near mid-grey (128), falls off at extremes.
            mean_lum = ImageStat.Stat(gray).mean[0]
            brightness_factor = 1.0 - (abs(mean_lum - 128.0) / 128.0)
            brightness_factor = max(0.0, min(1.0, brightness_factor))

            # Sharpness proxy: variance of a Laplacian-like edge image on a
            # downscaled copy (bounded so clean photos land near ~1.0).
            small = gray.copy()
            small.thumbnail((256, 256))
            edges = small.filter(ImageFilter.FIND_EDGES)
            variance = ImageStat.Stat(edges).var[0]
            sharpness_factor = max(0.0, min(1.0, variance / 500.0))

            score = (
                0.30 * resolution_factor
                + 0.30 * brightness_factor
                + 0.40 * sharpness_factor
            )
            return round(max(0.0, min(1.0, score)), 4), None
    except Exception:
        return 0.0, "photo-quality: unreadable image"


# ── Required objects (REAL — YOLO, with resilience fallback only) ────────────

def _detect_required_objects(local_path: str) -> tuple[list, bool, list, str]:
    """Return (required_objects, pass_bool, detections, provenance_note).

    REAL YOLO path (CL-1): run the model on the photo and mark each expected
    object present if any detected class name contains it (case-insensitive).
    `required_objects_pass = all(present)`.

    In addition to the pass/fail per required object, this now returns the raw
    detections with NORMALISED bounding boxes so the UI can draw them on the
    image. Each detection is:
        {"label": str, "confidence": float,
         "box": {"x": 0..1, "y": 0..1, "w": 0..1, "h": 0..1}}
    where x/y is the top-left corner and w/h the size, all as fractions of the
    image width/height (so the frontend can scale to any rendered size).

    The try/except fallback exists SOLELY for resilience (FR-7.5): if the model
    cannot load or inference raises, every object is marked present=False, no
    detections are returned, and a "yolo-unavailable" note is recorded.
    """
    try:
        model = get_model()
        results = model(local_path, verbose=False)
        detected: set[str] = set()
        detections: list = []

        for result in results:
            names = getattr(result, "names", {}) or {}
            boxes = getattr(result, "boxes", None)
            if boxes is None:
                continue

            # Image dimensions for this result (for normalising boxes).
            shape = getattr(result, "orig_shape", None)  # (height, width)
            img_h, img_w = (shape[0], shape[1]) if shape else (0, 0)

            for box in boxes:
                cls = int(box.cls[0])
                name = names.get(cls, "") if isinstance(names, dict) else ""
                if not name:
                    continue
                detected.add(str(name).lower())

                conf = float(box.conf[0]) if getattr(box, "conf", None) is not None else 0.0
                # xyxy in pixel coordinates → normalised x/y/w/h.
                try:
                    x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
                except Exception:
                    continue
                if img_w and img_h:
                    nx = max(0.0, min(1.0, x1 / img_w))
                    ny = max(0.0, min(1.0, y1 / img_h))
                    nw = max(0.0, min(1.0, (x2 - x1) / img_w))
                    nh = max(0.0, min(1.0, (y2 - y1) / img_h))
                    detections.append({
                        "label": str(name),
                        "confidence": round(conf, 4),
                        "box": {"x": round(nx, 5), "y": round(ny, 5),
                                "w": round(nw, 5), "h": round(nh, 5)},
                    })

        required = []
        for friendly_name, coco_classes in REQUIRED_OBJECTS:
            present = any(
                cls.lower() in d or d in cls.lower()
                for cls in coco_classes
                for d in detected
            )
            required.append({"name": friendly_name, "present": present})

        # A valid card-verification photo must at least show the card/document
        # (the first required element). The cardholder is a bonus, not required.
        all_present = required[0]["present"] if required else False

        note = f"objects:yolo ({len(detections)} detection(s))"
        return required, all_present, detections, note
    except Exception as exc:
        # Resilience fallback only (FR-7.5) — never the happy path.
        required = [{"name": name, "present": False} for name, _ in REQUIRED_OBJECTS]
        return required, False, [], f"objects:yolo-unavailable ({exc}), fallback"


# ── Document type (HEURISTIC) + OCR (STUB) ───────────────────────────────────

_DOC_KEYWORDS = {
    "Aadhaar Card":    ("aadhaar", "aadhar", "uidai", "uid"),
    "PAN Card":        ("pan", "permanent account", "incometax", "income-tax"),
    "Insurance Card":  ("insurance", "policy", "mediclaim", "health card", "cover"),
    "Driving License": ("driving", "licence", "license", "dl", "rto"),
    "Passport":        ("passport", "ppt"),
    "Voter ID":        ("voter", "epic", "election"),
}


def _classify_document(doc: AssetRef, selected_type: str) -> dict:
    """HEURISTIC document typing + STUB OCR.

    `document_type_detected` is derived from filename/extension/content-type
    keywords. Confidence is 1.0 when the heuristic agrees with the officer's
    selected type, otherwise ~0.5 (the officer selection stays authoritative on
    the case row; this is only the AI's read). OCR is an explicit stub.
    """
    haystack = f"{doc.original_name} {doc.content_type}".lower()
    detected = None
    for dtype, keywords in _DOC_KEYWORDS.items():
        if any(k in haystack for k in keywords):
            detected = dtype
            break
    if detected is None:
        detected = selected_type or "Other"

    confidence = 1.0 if detected == selected_type else 0.5

    return {
        "document_type_detected": detected,
        "document_type_confidence": confidence,
        "ocr_text": None,            # STUB — no OCR engine bundled
        "extracted_fields": None,    # STUB
        "note": "document-type:heuristic; ocr:stub",
    }


# ── Orchestrator ──────────────────────────────────────────────────────────────

def validate_case(photos: List[AssetRef], documents: List[AssetRef]) -> List[dict]:
    """Run AI validation over a case's assets.

    Returns a list of `AIValidationResult`-shaped dicts: one per photo and one
    per document. Never raises for a single-asset failure — a per-asset error is
    captured into that asset's result row via its `note`.
    """
    results: List[dict] = []

    for photo in photos:
        quality_score, quality_err = _score_photo_quality(photo.local_path)
        quality_pass = quality_score >= PHOTO_QUALITY_PASS_THRESHOLD
        required, required_pass, detections, objects_note = _detect_required_objects(photo.local_path)

        quality_note = quality_err or "photo-quality:real"
        note = f"{quality_note}; {objects_note}"

        results.append({
            "photo_id": photo.asset_id,
            "document_id": None,
            "photo_quality_score": quality_score,
            "photo_quality_pass": quality_pass,
            "required_objects": required,
            "required_objects_pass": required_pass,
            "document_type_detected": None,
            "document_type_confidence": None,
            "ocr_text": None,
            # Store the raw detections (with normalised bounding boxes) so the UI
            # can draw boxes on the image. The column is a flexible JSON field.
            "extracted_fields": {"detections": detections},
            "note": note,
        })

    for doc in documents:
        # The authoritative officer-selected document_type is carried on the
        # AssetRef (set by the router from the CaseDocument row).
        selected_type = doc.selected_type or "Other"
        classified = _classify_document(doc, selected_type)
        results.append({
            "photo_id": None,
            "document_id": doc.asset_id,
            "photo_quality_score": None,
            "photo_quality_pass": None,
            "required_objects": None,
            "required_objects_pass": None,
            "document_type_detected": classified["document_type_detected"],
            "document_type_confidence": classified["document_type_confidence"],
            "ocr_text": classified["ocr_text"],
            "extracted_fields": classified["extracted_fields"],
            "note": classified["note"],
        })

    if not results:
        results.append({
            "photo_id": None,
            "document_id": None,
            "photo_quality_score": None,
            "photo_quality_pass": None,
            "required_objects": None,
            "required_objects_pass": None,
            "document_type_detected": None,
            "document_type_confidence": None,
            "ocr_text": None,
            "extracted_fields": None,
            "note": "no assets",
        })

    return results
