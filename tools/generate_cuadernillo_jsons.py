#!/usr/bin/env python3
"""
Lee los PDF en `data/`, analiza el texto (PyMuPDF + normalización del importador)
y escribe **un JSON por cuadernillo** con preguntas completas, opciones y feedback.

Salidas:
  - `data/preguntas/<slug>.json`   (para editar junto a los PDF)
  - `web/data/cuadernillos/<slug>.json` (idénticos; la app los carga por HTTP)
  - `web/data/cuadernillos/manifest.json`

La app ya no necesita leer PDF en tiempo de ejecución: basta con regenerar tras cambiar PDFs.

Uso:  python tools/generate_cuadernillo_jsons.py
"""

from __future__ import annotations

import importlib.util
import json
import re
import time
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[1]


def _load_icfes():
    spec = importlib.util.spec_from_file_location("icfes_import", ROOT / "tools" / "import_icfes_pdfs.py")
    m = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(m)
    return m


def _slug(name: str) -> str:
    base = Path(name).stem.lower()
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-")
    return base[:90] or "cuadernillo"


def main() -> None:
    icfes = _load_icfes()
    pdf_dir = ROOT / "data"
    out_repo = ROOT / "data" / "preguntas"
    out_web = ROOT / "web" / "data" / "cuadernillos"
    out_repo.mkdir(parents=True, exist_ok=True)
    out_web.mkdir(parents=True, exist_ok=True)

    pdfs = sorted(pdf_dir.glob("*.pdf"))
    if not pdfs:
        raise SystemExit(f"No hay PDF en {pdf_dir}. Coloca ahí los cuadernillos.")

    exported_at = int(time.time() * 1000)
    manifest: Dict[str, Any] = {
        "format": "cuadernillos_manifest_v1",
        "descripcion": "Lista de JSON por cuadernillo; la app los fusiona sin leer PDF.",
        "exportedAt": exported_at,
        "archivos": [],
    }

    total_items = 0
    for pdf in pdfs:
        mod_name, parsed = icfes.parse_pdf(pdf)
        mid = icfes.stable_module_id(mod_name)
        max_q = max((q.number for q in parsed), default=0)

        items: List[Dict[str, Any]] = []
        for q in parsed:
            if not q.choices or len(q.choices) < 2:
                continue
            ci = icfes._letter_to_index(q.correct_letter, len(q.choices))

            topic = None
            if mod_name == "Matemáticas":
                topic = icfes._infer_topic_math(q.text)
            elif mod_name == "Lectura Crítica":
                topic = icfes._infer_topic_reading(q.text)
            elif mod_name == "Ciencias Naturales":
                topic = icfes._infer_topic_science(q.text)
            elif mod_name == "Inglés":
                topic = "Inglés (cuadernillo)" if max_q > 25 else "Inglés"

            difficulty = icfes._infer_difficulty_by_position(q.number, max_q)
            explain, option_fb = icfes._build_feedback(mod_name, q.text, q.choices, ci, q.correct_letter)

            items.append(
                {
                    "id": icfes.stable_question_id(pdf.name, q.number),
                    "numero": q.number,
                    "tema": topic,
                    "dificultad": difficulty,
                    "enunciado": q.text,
                    "opciones": q.choices,
                    "indiceCorrecto": ci,
                    "respuestaLetra": (q.correct_letter or "").strip().upper() or chr(ord("A") + ci),
                    "explicacionGeneral": explain,
                    "feedbackPorOpcion": option_fb,
                }
            )

        slug = _slug(pdf.name)
        doc: Dict[str, Any] = {
            "format": "cuadernillo_json_v1",
            "archivoPdf": pdf.name,
            "moduloNombre": mod_name,
            "moduleId": mid,
            "exportedAt": exported_at,
            "totalPreguntas": len(items),
            "preguntas": items,
        }

        text = json.dumps(doc, ensure_ascii=False, indent=2)
        (out_repo / f"{slug}.json").write_text(text, encoding="utf-8")
        (out_web / f"{slug}.json").write_text(text, encoding="utf-8")

        manifest["archivos"].append(
            {
                "slug": slug,
                "url": f"./data/cuadernillos/{slug}.json",
                "archivoPdf": pdf.name,
                "moduloNombre": mod_name,
                "moduleId": mid,
                "totalPreguntas": len(items),
            }
        )
        total_items += len(items)

    (out_web / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_repo / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"OK: {len(pdfs)} cuadernillos, {total_items} preguntas -> {out_web} y {out_repo}")


if __name__ == "__main__":
    main()
