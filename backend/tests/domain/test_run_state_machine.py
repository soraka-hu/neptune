from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.domain.services.run_state_machine import RunStateMachine


def test_invalid_status_transition_rejected():
    with pytest.raises(ValueError, match="invalid run status transition"):
        RunStateMachine.validate_transition("pending", "success")
