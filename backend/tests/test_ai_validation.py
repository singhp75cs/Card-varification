"""
Self-asserting unit test for the AI validation service (pytest is not installed
in the venv, so this runs as a plain script: `.venv/bin/python tests/test_ai_validation.py`).

Covers:
  * REAL Pillow photo-quality path on a generated fixture image.
  * Forced-YOLO-failure path → fallback note + required_objects_pass False, no raise.
  * Document heuristic + OCR stub.
  * Empty case → single "no assets" row.
"""
import os
import sys
import tempfile

# Allow running from the backend directory.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import ai_validation
from services.ai_validation import AssetRef, validate_case, REQUIRED_OBJECTS


def _make_fixture_image(path: str):
    from PIL import Image
    img = Image.new("RGB", (1200, 900), color=(120, 130, 140))
    # Draw some edges so the sharpness proxy is non-trivial.
    for x in range(0, 1200, 40):
        for y in range(0, 900):
            img.putpixel((x, y), (240, 240, 240))
    img.save(path, "JPEG")


def test_photo_quality_real():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "fixture.jpg")
        _make_fixture_image(p)
        results = validate_case([AssetRef("photo", 1, p, "fixture.jpg", "")], [])
        assert len(results) == 1, results
        r = results[0]
        assert r["photo_id"] == 1
        assert r["photo_quality_score"] is not None and 0.0 <= r["photo_quality_score"] <= 1.0
        assert r["photo_quality_pass"] in (True, False)
        assert isinstance(r["required_objects"], list)
        assert len(r["required_objects"]) == len(REQUIRED_OBJECTS)
        # Happy path provenance should mention real photo quality.
        assert "photo-quality:real" in r["note"]
    print("PASS test_photo_quality_real")


def test_yolo_failure_fallback():
    """Force the YOLO loader to raise and assert the fallback engages without raising."""
    orig = ai_validation.get_model
    def boom():
        raise RuntimeError("forced yolo failure")
    ai_validation.get_model = boom
    try:
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "fixture.jpg")
            _make_fixture_image(p)
            results = validate_case([AssetRef("photo", 2, p, "fixture.jpg", "")], [])
            r = results[0]
            assert r["required_objects_pass"] is False, r
            assert all(o["present"] is False for o in r["required_objects"]), r
            assert "yolo-unavailable" in r["note"], r
    finally:
        ai_validation.get_model = orig
    print("PASS test_yolo_failure_fallback")


def test_document_heuristic_and_ocr_stub():
    results = validate_case([], [AssetRef("document", 5, "/nope/aadhaar.pdf",
                                          "aadhaar_card.pdf", "application/pdf", "Aadhaar Card")])
    assert len(results) == 1
    r = results[0]
    assert r["document_id"] == 5
    assert r["document_type_detected"] == "Aadhaar Card"
    assert r["document_type_confidence"] == 1.0
    assert r["ocr_text"] is None          # STUB
    assert r["extracted_fields"] is None  # STUB
    assert "ocr:stub" in r["note"]
    print("PASS test_document_heuristic_and_ocr_stub")


def test_empty_case():
    results = validate_case([], [])
    assert len(results) == 1
    assert results[0]["note"] == "no assets"
    print("PASS test_empty_case")


if __name__ == "__main__":
    test_photo_quality_real()
    test_yolo_failure_fallback()
    test_document_heuristic_and_ocr_stub()
    test_empty_case()
    print("\nALL AI VALIDATION TESTS PASSED")
