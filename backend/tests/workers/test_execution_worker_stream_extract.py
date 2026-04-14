from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.workers.execution_worker import _extract_benchmark_output_from_api_response


def test_extract_benchmark_output_prefers_stream_events_text():
    response_data = {
        "json": {
            "code": 200,
            "msg": "run_completed",
            "data": {"finished": True, "text": ""},
            "stream_events": [
                {"code": 200, "msg": "message_output_created", "data": {"text": "你好"}},
                {"code": 200, "msg": "message_output_created", "data": {"text": "呀～"}},
                {"code": 200, "msg": "run_completed", "data": {"text": ""}},
            ],
        },
        "text": "",
    }
    assert _extract_benchmark_output_from_api_response(response_data) == "你好呀～"


def test_extract_benchmark_output_fallback_reads_raw_sse_text():
    raw = (
        'data: {"code": 200, "msg": "message_output_created", "data": {"text": "你好"}}\n\n'
        'data: {"code": 200, "msg": "message_output_created", "data": {"text": "今天过得怎么样？"}}\n\n'
        'data: {"code": 200, "msg": "run_completed", "data": {"text": ""}}\n\n'
    )
    response_data = {
        "json": None,
        "text": raw,
    }
    assert _extract_benchmark_output_from_api_response(response_data) == "你好今天过得怎么样？"
