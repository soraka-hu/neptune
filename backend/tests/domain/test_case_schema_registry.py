from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.domain.services.schema_registry_service import CaseSchemaRegistry


def test_invalid_case_input_rejected():
    payload = {"schema_version": "1.0", "method": "POST"}

    with pytest.raises(ValueError, match="invalid input_payload"):
        CaseSchemaRegistry.validate_input_payload("api", payload)
