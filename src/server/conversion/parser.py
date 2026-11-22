"""Offline Docling adapter. Only the versioned IPC envelope reaches stdout."""

import base64
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import importlib.metadata
import json
import os
from pathlib import Path
import sys
from typing import Any, Iterator


class Rejected(Exception):
    def __init__(self, code: str) -> None:
        self.code = code


def protocol_manifest() -> dict[str, Any]:
    script = Path(__file__)
    sibling = script.with_name("conversion-protocol.json")
    if sibling.is_file():
        return json.loads(sibling.read_text(encoding="utf-8"))
    if len(script.parents) >= 3:
        source = script.parents[2] / "shared" / "conversion-protocol.json"
        if source.is_file():
            return json.loads(source.read_text(encoding="utf-8"))
    raise Rejected("runtime_unavailable")


@contextmanager
def quiet_engine() -> Iterator[None]:
    # Native libraries can write directly to fd1/fd2, bypassing Python logging.
    # Discard both channels rather than buffering unbounded diagnostics/content.
    with open(os.devnull, "w", encoding="utf-8") as sink:
        saved = (os.dup(1), os.dup(2))
        try:
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
            with redirect_stdout(sink), redirect_stderr(sink):
                yield
        finally:
            os.dup2(saved[0], 1)
            os.dup2(saved[1], 2)
            os.close(saved[0])
            os.close(saved[1])


# @id CODE-DRT-001 @implements REQ-DRT-001
def convert_document(manifest: dict[str, Any]) -> dict[str, Any]:
    engine = manifest["engine"]
    try:
        if importlib.metadata.version(engine["distribution"]) != engine["version"]:
            raise Rejected("runtime_unavailable")
        from docling.datamodel.accelerator_options import (
            AcceleratorDevice,
            AcceleratorOptions,
        )
        from docling.datamodel.base_models import ConversionStatus, InputFormat
        from docling.datamodel.pipeline_options import EasyOcrOptions, PdfPipelineOptions
        from docling.document_converter import (
            DocumentConverter,
            ImageFormatOption,
            PdfFormatOption,
        )
        import pypdfium2
    except Rejected:
        raise
    except Exception:
        raise Rejected("runtime_unavailable") from None

    check = sys.argv[1:] == ["--check"]
    if not check and len(sys.argv) != 3:
        raise Rejected("invalid_input")
    source = None if check else Path(sys.argv[1])
    extension = "" if check else Path(sys.argv[2]).suffix.lower().removeprefix(".")
    if not check and extension not in manifest["formats"]:
        raise Rejected("unsupported_type")
    limits = manifest["limits"]
    try:
        if source is not None and (not source.is_file() or source.is_symlink()):
            raise Rejected("invalid_document")
        if source is not None and source.stat().st_size > limits["inputBytes"]:
            raise Rejected("input_too_large")
        if extension == "pdf":
            with pypdfium2.PdfDocument(str(source)) as pdf:
                raw = getattr(pypdfium2, "raw", None)
                if raw is not None and raw.FPDF_GetSecurityHandlerRevision(pdf.raw) >= 0:
                    raise Rejected("invalid_document")
                if len(pdf) <= 0:
                    raise Rejected("invalid_document")
                if len(pdf) > limits["pdfPages"]:
                    raise Rejected("page_limit")
        options = PdfPipelineOptions(
            artifacts_path=Path("/models/docling"),
            enable_remote_services=False,
            accelerator_options=AcceleratorOptions(
                num_threads=1, device=AcceleratorDevice.CPU
            ),
            ocr_options=EasyOcrOptions(lang=["ja", "en"], download_enabled=False),
        )
        image_options = options.model_copy(deep=True)
        image_options.ocr_options.force_full_page_ocr = True
        converter = DocumentConverter(
            allowed_formats=[
                InputFormat.PDF,
                InputFormat.IMAGE,
                InputFormat.DOCX,
                InputFormat.PPTX,
                InputFormat.XLSX,
            ],
            format_options={
                InputFormat.PDF: PdfFormatOption(pipeline_options=options),
                InputFormat.IMAGE: ImageFormatOption(pipeline_options=image_options),
            },
        )
        if check:
            # Image OCR uses the same pinned models as PDF OCR; loading one
            # pipeline proves availability without a download or a document.
            converter.initialize_pipeline(InputFormat.PDF)
            return {
                "version": manifest["version"],
                "doclingDistribution": engine["distribution"],
                "doclingVersion": engine["version"],
            }
        converted = converter.convert(
            source,
            max_num_pages=limits["pdfPages"],
            max_file_size=limits["inputBytes"],
        )
        if converted.status != ConversionStatus.SUCCESS:
            raise Rejected("conversion_failed")
        if extension == "pdf" and len(converted.pages) > limits["pdfPages"]:
            raise Rejected("page_limit")
        document = converted.document.export_to_dict()
        markdown = converted.document.export_to_markdown().encode("utf-8")
        if not markdown.strip() or not isinstance(document, dict) or not document:
            raise Rejected("conversion_failed")
        structured = json.dumps(
            document, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")
        if (
            len(markdown) > limits["outputBytes"]
            or len(structured) > limits["outputBytes"]
        ):
            raise Rejected("output_too_large")
        return {
            "version": manifest["version"],
            "markdownBase64": base64.b64encode(markdown).decode("ascii"),
            "documentJsonBase64": base64.b64encode(structured).decode("ascii"),
        }
    except Rejected:
        raise
    except Exception:
        raise Rejected("runtime_unavailable" if check else "invalid_document") from None


def main() -> int:
    manifest: dict[str, Any] | None = None
    try:
        with quiet_engine():
            manifest = protocol_manifest()
            frame = convert_document(manifest)
        status = 0
    except BaseException as error:
        code = (
            error.code
            if isinstance(error, Rejected)
            else "interrupted"
            if isinstance(error, KeyboardInterrupt)
            else "conversion_failed"
        )
        if manifest is None or code not in manifest["failureCodes"]:
            code = "runtime_unavailable"
        frame = {"version": 1, "error": code}
        status = 2
    print(json.dumps(frame, ensure_ascii=True, separators=(",", ":")), flush=True)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
