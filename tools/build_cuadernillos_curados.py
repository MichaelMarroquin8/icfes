#!/usr/bin/env python3
"""
Genera `web/data/cuadernillos_curados.json` desde `web/data/icfes_import.json`.

No lee PDF: parte del bundle ya importado (mismos enunciados, opciones y clave correcta).
Reorganiza por cuadernillo, añade análisis de calidad y retroalimentación reescrita para estudio.

Uso:
  python tools/build_cuadernillos_curados.py
  python tools/build_cuadernillos_curados.py --input ruta/icfes_import.json --out ruta/salida.json
"""

from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[1]


def _sh(s: str, n: int) -> str:
    s = (s or "").replace("\n", " ").strip()
    if len(s) <= n:
        return s
    return s[: n - 1].rstrip() + "…"


def _primer_bloque(stem: str, max_len: int = 160) -> str:
    line = stem.strip().split("\n")[0].strip()
    return _sh(line, max_len)


def _letra(indice: int) -> str:
    return chr(ord("A") + indice) if 0 <= indice < 26 else "?"


def _build_retro_curada(
    module: str,
    stem: str,
    choices: List[str],
    correct_index: int,
    correct_letter: Optional[str],
) -> Tuple[str, List[str]]:
    """Retro distinta a la plantilla genérica del importador PDF."""
    n = len(choices)
    letters = [_letra(i) for i in range(n)]
    L = (correct_letter or "").strip().upper() or letters[correct_index]
    hook = _primer_bloque(stem, 200)

    explain = (
        f"Respuesta correcta: {L}. En {module} se te pide cerrar el razonamiento a partir del enunciado "
        f"(«{hook}»). La opción {L} es la que mejor encaja: no contradice los datos ni la consigna."
    )

    wrong_hints = [
        "Atiende a un detalle parcial pero no responde exactamente lo que se pregunta.",
        "Mezcla datos o ideas ciertas con una conclusión que no se desprende del enunciado.",
        "Confunde comparaciones (totales, promedios, mayorías, extremos) sin verificar la consigna exacta.",
        "Exige información o pasos que el ejercicio no pide para decidir.",
    ]
    wi = 0
    out_fb: List[str] = []
    for i, txt in enumerate(choices):
        if i == correct_index:
            out_fb.append(
                f"Sí ({letters[i]}). {_sh(txt, 240)} — es coherente con la pregunta y con la evidencia disponible."
            )
        else:
            hint = wrong_hints[wi % len(wrong_hints)]
            wi += 1
            out_fb.append(
                f"No ({letters[i]}). {_sh(txt, 140)} — {hint} Compara con la línea de razonamiento de ({L})."
            )
    return explain, out_fb


def _analizar_pregunta(q: Dict[str, Any]) -> List[str]:
    adv: List[str] = []
    text = (q.get("text") or "").strip()
    ch = q.get("choices") or []
    if len(text) < 25:
        adv.append(f"Pregunta {q.get('sourcePos')}: enunciado muy corto; conviene revisar extracción.")
    if len(ch) < 2:
        adv.append(f"Pregunta {q.get('sourcePos')}: menos de dos opciones.")
    elif len(ch) != 4:
        adv.append(f"Pregunta {q.get('sourcePos')}: tiene {len(ch)} opciones (habitualmente 4).")
    ci = int(q.get("correctIndex") or 0)
    if ch and (ci < 0 or ci >= len(ch)):
        adv.append(f"Pregunta {q.get('sourcePos')}: índice correcto fuera de rango.")
    return adv


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=ROOT / "web" / "data" / "icfes_import.json")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "data" / "cuadernillos_curados.json")
    args = ap.parse_args()

    raw = json.loads(args.input.read_text(encoding="utf-8"))
    db = raw.get("db") or {}
    modules: List[Dict[str, Any]] = list(db.get("modules") or [])
    sources: List[Dict[str, Any]] = list(db.get("sources") or [])
    questions: List[Dict[str, Any]] = list(db.get("questions") or [])
    meta = list(db.get("meta") or [{"key": "app", "version": 1}])

    by_mod_id = {m["id"]: m for m in modules}
    by_file: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for q in questions:
        fn = q.get("sourceFile") or "(sin archivo)"
        by_file[fn].append(q)

    module_order = ["Matemáticas", "Lectura Crítica", "Inglés", "Ciencias Naturales", "Sociales y Ciudadanas", "General"]

    def sort_key(fn: str) -> Tuple[int, str]:
        mname = ""
        for q in by_file.get(fn, []):
            mid = q.get("moduleId")
            mname = (by_mod_id.get(mid) or {}).get("name") or ""
            break
        try:
            idx = module_order.index(mname)
        except ValueError:
            idx = 99
        return (idx, fn)

    exported_at = int(time.time() * 1000)
    cuadernillos: List[Dict[str, Any]] = []

    for archivo in sorted(by_file.keys(), key=sort_key):
        bucket = by_file[archivo]
        bucket.sort(key=lambda x: int(x.get("sourcePos") or 0))
        mod_id = bucket[0].get("moduleId") if bucket else ""
        mod = by_mod_id.get(mod_id, {})
        mod_name = mod.get("name") or "General"

        advertencias: List[str] = []
        preguntas_out: List[Dict[str, Any]] = []
        for q in bucket:
            advertencias.extend(_analizar_pregunta(q))
            ch = list(q.get("choices") or [])
            ci = int(q.get("correctIndex") or 0)
            letter = _letra(ci) if 0 <= ci < len(ch) else None
            explain, retro = _build_retro_curada(mod_name, q.get("text") or "", ch, ci, letter)

            preguntas_out.append(
                {
                    "id": q.get("id"),
                    "moduleId": q.get("moduleId"),
                    "numeroEnCuadernillo": int(q.get("sourcePos") or 0),
                    "tema": q.get("topic"),
                    "dificultad": q.get("difficulty") or "medium",
                    "enunciado": q.get("text") or "",
                    "opciones": ch,
                    "indiceCorrecto": ci,
                    "respuestaLetra": letter,
                    "explicacion": explain,
                    "retroalimentacionPorOpcion": retro,
                }
            )

        n4 = sum(1 for p in preguntas_out if len(p.get("opciones") or []) == 4)
        cuadernillos.append(
            {
                "archivoPdf": archivo,
                "nombreModulo": mod_name,
                "moduleId": mod_id,
                "analisis": {
                    "totalPreguntas": len(preguntas_out),
                    "conCuatroOpciones": n4,
                    "advertencias": sorted(set(advertencias)),
                },
                "preguntas": preguntas_out,
            }
        )

    out_doc: Dict[str, Any] = {
        "format": "cuadernillos_curados_v1",
        "titulo": "Banco curado Saber 11 — organizado por cuadernillo",
        "descripcion": (
            "Contenido alineado al bundle icfes_import (mismos enunciados y respuesta oficial). "
            "La retroalimentación se reescribe para estudio; conviene revisar ítems marcados en analisis.advertencias."
        ),
        "origenDatos": "web/data/icfes_import.json (extracción previa de cuadernillos PDF; este archivo no parsea PDF).",
        "bundleRevision": int(raw.get("bundleRevision") or 0) + 1,
        "exportedAt": exported_at,
        "meta": meta,
        "modulos": modules,
        "fuentes": sources,
        "cuadernillos": cuadernillos,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out_doc, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OK: {len(cuadernillos)} cuadernillos, {len(questions)} preguntas -> {args.out}")


if __name__ == "__main__":
    main()
