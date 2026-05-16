import json
import re
import time
import uuid
from datetime import UTC, datetime
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from pypdf import PdfReader

_NS = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")


@dataclass
class ParsedQuestion:
    number: int
    text: str
    choices: List[str]
    correct_letter: Optional[str]


def _clean_lines(text: str) -> List[str]:
    lines = [ln.strip() for ln in (text or "").splitlines()]
    lines = [ln for ln in lines if ln]
    drop_prefixes = (
        "Cuadernillo de preguntas",
        "Prueba",
        "Saber 11",
        "www.icfes.gov.co",
        "Calle 26",
        "Líneas de atención",
        "Tabla de respuestas correctas",
        "Posición Respuesta correcta",
        "Posición",
    )
    cleaned: List[str] = []
    for ln in lines:
        if ln.startswith(drop_prefixes):
            continue
        if re.fullmatch(r"\d+(\s*\.)?", ln):
            continue
        cleaned.append(ln)
    return cleaned


def _extract_full_text(reader: PdfReader) -> str:
    parts: List[str] = []
    for p in reader.pages:
        parts.append(p.extract_text() or "")
    return "\n".join(parts)


def extract_full_text_pdf(path: Path) -> str:
    """
    Preferimos PyMuPDF (fitz): suele dar mejor orden de lectura y menos cortes
    que pypdf en cuadernillos de dos columnas.
    """
    try:
        import fitz  # type: ignore  # PyMuPDF

        doc = fitz.open(str(path))
        try:
            parts: List[str] = []
            for page in doc:
                parts.append(page.get_text("text") or "")
            return "\n".join(parts)
        finally:
            doc.close()
    except Exception:
        reader = PdfReader(str(path))
        return _extract_full_text(reader)


def normalize_extracted_text(s: str) -> str:
    if not s:
        return ""
    s = s.replace("\r", "\n").replace("\xad", "").replace("\u00a0", " ")
    s = re.sub(r"-\n(?=[a-záéíóúñA-ZÁÉÍÓÚÑ0-9])", "", s)
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s


_END_SENT = re.compile(r"[.?!:…\"']\s*$")


def _merge_stem_lines(stem: str) -> str:
    """Une líneas partidas por salto de página o columna cuando es continuación."""
    lines = [ln.strip() for ln in stem.splitlines() if ln.strip()]
    if not lines:
        return ""
    out: List[str] = [lines[0]]
    for ln in lines[1:]:
        prev = out[-1]
        if prev.endswith("-"):
            out[-1] = prev[:-1] + ln.lstrip()
            continue
        if re.match(r"^(Pregunta\s+\d+|RESPONDE\s+LAS\s+PREGUNTAS)", ln, re.I):
            out.append(ln)
            continue
        if not _END_SENT.search(prev) and ln[:1] and ln[0].islower():
            out[-1] = prev.rstrip() + " " + ln.lstrip()
        else:
            out.append(ln)
    return "\n".join(out)


def _normalize_table_linebreaks(stem: str) -> str:
    """Arreglos puntuales de saltos típicos del PDF en tablas Saber 11."""
    s = stem
    s = re.sub(r"Promedio año\s*\n\s*anterior", "Promedio año anterior", s, flags=re.I)
    s = re.sub(r"Promedio año\s*\n\s*actual", "Promedio año actual", s, flags=re.I)
    s = re.sub(
        r"Curso\s*\n\s*I\s*\n\s*II\s*\n\s*III\s*\n\s*IV",
        "Curso: I, II, III, IV",
        s,
        flags=re.I,
    )
    return s


def _fix_truncated_stem(stem: str) -> str:
    s = stem.rstrip()
    if re.search(r"Esta afirmación es\s*$", s, re.I):
        return s + " correcta?"
    return s


def _polish_stem(stem: str) -> str:
    s = (stem or "").replace("\u00a0", " ")
    s = _normalize_table_linebreaks(s)
    s = re.sub(r"[ \t]+", " ", s)
    s = _merge_stem_lines(s)
    s = _fix_truncated_stem(s)
    return s.strip()


def _polish_choice(c: str) -> str:
    s = (c or "").replace("\u00a0", " ")
    s = re.sub(r"-\n", "", s)
    s = re.sub(r"\s*\n\s*", " ", s).strip()
    s = re.sub(r" {2,}", " ", s)
    return s


def stable_module_id(module_name: str) -> str:
    return str(uuid.uuid5(_NS, "icfes-module|" + (module_name or "").strip().lower()))


def stable_question_id(pdf_basename: str, qnum: int) -> str:
    return str(uuid.uuid5(_NS, "icfes-q|" + pdf_basename.strip().lower() + "|" + str(int(qnum))))


def _strip_boilerplate_tail(s: str) -> str:
    if not s:
        return s
    cut = re.search(r"(?is)\n\s*Cuadernillo de preguntas\b", s)
    if cut:
        s = s[: cut.start()]
    cut2 = re.search(r"(?is)\n\s*RESPONDE\s+LAS\s+PREGUNTAS\b", s)
    if cut2:
        s = s[: cut2.start()]
    return s.strip()


def _parse_all_answer_tables(full_text: str) -> List[Dict[int, str]]:
    """
    Devuelve una lista ordenada de mapas {número_pregunta: letra}.
    Soporta varias tablas (p. ej. Inglés Examen 1 y Examen 2, ambas 1..25).
    """
    starts = [m.start() for m in re.finditer(r"(?i)tabla de respuestas correctas", full_text)]
    if not starts:
        return [_parse_answer_table_fallback(full_text)]

    tables: List[Dict[int, str]] = []
    for i, st in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(full_text)
        chunk = full_text[st:end]
        tbl: Dict[int, str] = {}
        for m in re.finditer(r"(?m)^\s*(\d{1,3})\s+([A-H])\s*$", chunk):
            tbl[int(m.group(1))] = m.group(2)
        for m in re.finditer(r"(?m)^\s*(\d{1,3})\s+([A-H])\s+[A-Za-z].*$", chunk):
            tbl.setdefault(int(m.group(1)), m.group(2))
        if tbl:
            tables.append(tbl)

    return tables if tables else [_parse_answer_table_fallback(full_text)]


def _parse_answer_table_fallback(full_text: str) -> Dict[int, str]:
    answers: Dict[int, str] = {}
    idx = full_text.lower().rfind("tabla de respuestas correctas")
    tail = full_text[idx:] if idx != -1 else full_text
    for m in re.finditer(r"(?m)^\s*(\d{1,3})\s+([A-H])\s*$", tail):
        answers[int(m.group(1))] = m.group(2)
    for m in re.finditer(r"(?m)^\s*(\d{1,3})\s+([A-H])\s+[A-Za-z].*$", tail):
        answers.setdefault(int(m.group(1)), m.group(2))
    return answers


def _parse_icfes_multiline_answer_table(full_text: str, module: str = "") -> Dict[int, str]:
    """
    Tabla Saber 11 (Lectura, Ciencias, Matemáticas): posición en línea sola,
    afirmación en varias líneas (si aplica) y letra en línea sola.
    Matemáticas: número y letra suelen ir consecutivos.
    """
    out: Dict[int, str] = {}
    idx = full_text.lower().rfind("tabla de respuestas correctas")
    if idx == -1:
        return out
    tail = full_text[idx : idx + 28000]
    lines = [ln.strip() for ln in tail.splitlines()]
    skip_tokens = {
        "tabla de respuestas correctas",
        "posición",
        "posicion",
        "afirmación",
        "afirmacion",
        "respuesta",
        "correcta",
        "cuadernillo de preguntas",
        "prueba lectura crítica",
        "prueba lectura critica",
        "prueba ciencias naturales",
        "prueba matemáticas",
        "prueba matematicas",
        ".",
    }
    skip_line_re = re.compile(
        r"^(pre\s*)?a[12]$|^a2$|^b1$|^b2$|^\.$|^www\.|^calle\s+26|^líneas\s+de",
        re.I,
    )
    cur_n: Optional[int] = None
    i = 0
    while i < len(lines):
        ln = lines[i]
        low = ln.lower()
        if not ln:
            i += 1
            continue
        if low in skip_tokens or low.startswith("prueba ") or skip_line_re.match(ln):
            i += 1
            continue
        if re.fullmatch(r"\d{1,2}", ln):
            v = int(ln)
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            nxt = lines[j].strip() if j < len(lines) else ""
            nxt_low = nxt.lower()
            if nxt_low in ("posición", "posicion", "."):
                i += 1
                continue
            if re.fullmatch(r"[A-H]", nxt, re.I) and 1 <= v <= 55:
                out[v] = nxt.upper()
                i = j + 1
                cur_n = None
                continue
            if 1 <= v <= 55:
                cur_n = v
            i += 1
            continue
        if cur_n is not None and re.fullmatch(r"[A-H]", ln, re.I):
            out[cur_n] = ln.upper()
            cur_n = None
            i += 1
            continue
        i += 1
    return out


def _parse_english_exam_answer_tables(full_text: str) -> Dict[int, str]:
    """Inglés: dos tablas (Examen 1 → 1–25, Examen 2 → 26–50)."""
    out: Dict[int, str] = {}
    headers = list(
        re.finditer(r"(?i)tabla de respuestas correctas\s*(?:-\s*examen\s*(\d+))?", full_text)
    )
    if not headers:
        return out
    for hi, hm in enumerate(headers):
        exam_m = hm.group(1)
        offset = 25 if exam_m == "2" else 0
        start = hm.end()
        end = headers[hi + 1].start() if hi + 1 < len(headers) else len(full_text)
        chunk = full_text[start:end]
        lines = [ln.strip() for ln in chunk.splitlines() if ln.strip()]
        skip = {
            "posición",
            "posicion",
            "respuesta",
            "correcta",
            "dificultad",
            "cuadernillo de preguntas",
        }
        i = 0
        while i < len(lines):
            ln = lines[i]
            low = ln.lower()
            if low in skip or low.startswith("prueba ingl"):
                i += 1
                continue
            if re.fullmatch(r"\d{1,2}", ln):
                n = int(ln)
                j = i + 1
                while j < len(lines):
                    cand = lines[j].strip()
                    if re.fullmatch(r"[A-H]", cand, re.I):
                        if 1 <= n <= 25:
                            out[offset + n] = cand.upper()
                        i = j + 1
                        break
                    if re.fullmatch(r"\d{1,2}", cand):
                        break
                    j += 1
                else:
                    i += 1
                continue
            i += 1
    return out


def _resolve_answers(full_text: str, module: str) -> Dict[int, str]:
    if module == "Inglés":
        eng = _parse_english_exam_answer_tables(full_text)
        if len(eng) >= 40:
            return eng
    if module in ("Lectura Crítica", "Ciencias Naturales", "Matemáticas"):
        icfes = _parse_icfes_multiline_answer_table(full_text, module)
        if len(icfes) >= 35:
            return icfes
    tables = _parse_all_answer_tables(full_text)
    merged: Dict[int, str] = {}
    for tbl in tables:
        merged.update(tbl)
    if not merged:
        merged = _parse_answer_table_fallback(full_text)
    return merged


_RESPONDE_HDR = re.compile(
    r"(?mi)^\s*RESPONDE\s+"
    r"(?:LAS\s+PREGUNTAS\s+(\d{1,2})\s+(?:A|Y)\s+(\d{1,2})|LA\s+PREGUNTA\s+(\d{1,2}))\b[^\n]*$"
)


def _clean_passage_body(body: str) -> str:
    body = re.split(r"(?i)\n\s*Cuadernillo de preguntas\b", body)[0].strip()
    body = re.sub(
        r"(?is)^\s*(?:de\s+acuerdo[^\n]*\n|con\s+la\s+siguiente\s+información\s*\n|"
        r"con\s+la\s+siguiente\s+informacion\s*\n|con\s+el\s+siguiente\s+contexto\s*\n|"
        r"información\s*\n|informacion\s*\n)+",
        "",
        body,
    ).strip()
    body_lines: List[str] = []
    for raw in body.splitlines():
        t = raw.strip()
        tl = t.lower()
        if not t:
            continue
        if tl.startswith("cuadernillo de preguntas") or tl.startswith("prueba lectura"):
            break
        if re.match(r"^pregunta\s+\d", tl):
            continue
        if re.fullmatch(r"\d{1,2}", t) and body_lines and len(t) <= 2:
            continue
        body_lines.append(t)
    return "\n".join(body_lines).strip()


def _lectura_extract_passages(full_text: str) -> Dict[int, str]:
    """Texto base por bloque RESPONDE … hasta Pregunta N."""
    passages: Dict[int, str] = {}
    for m in _RESPONDE_HDR.finditer(full_text):
        if m.group(3):
            a = b = int(m.group(3))
        else:
            a, b = int(m.group(1)), int(m.group(2))
        if a > b or b - a > 30:
            continue
        start = m.end()
        sub = full_text[start:]
        pm = re.search(rf"(?mi)^\s*Pregunta\s+{a}\s*$", sub)
        if not pm:
            pm = re.search(rf"(?mi)^\s*Pregunta\s+{a}\s+", sub)
        body = sub[: pm.start()].strip() if pm else sub[:4000].strip()
        passage = _clean_passage_body(body)
        if len(passage) < 20:
            continue
        for q in range(a, b + 1):
            passages[q] = passage
    return passages


def _extract_trailing_passage_from_block(block: str) -> str:
    """
    En algunos PDF el relato queda después de las opciones (columnas).
    """
    cut = re.search(r"(?i)\n\s*Cuadernillo de preguntas\b", block)
    tail = block[cut.start() :] if cut else block
    cut2 = re.search(r"(?i)\n\s*RESPONDE\s+", tail)
    if cut2:
        tail = tail[: cut2.start()]
    lines = [ln.strip() for ln in tail.splitlines() if ln.strip()]
    skip_prefix = ("http", "www.", "tomado de", "recuperado", "literatura")
    kept: List[str] = []
    for ln in lines:
        low = ln.lower()
        if low.startswith(skip_prefix) or re.fullmatch(r"\d{1,2}", ln):
            continue
        if re.match(r"^[A-D]\.\s", ln):
            continue
        if len(ln) > 25 and not re.match(r"^¿", ln):
            kept.append(ln)
    return "\n".join(kept).strip()


def _needs_trailing_passage(stem: str) -> bool:
    t = (stem or "").lower()
    return any(
        k in t
        for k in (
            "historieta",
            "caricatura",
            "infografía",
            "infografia",
            "fragmento del texto",
            "en el texto",
            "según el texto",
            "según la infografía",
            "de acuerdo con el texto",
            "último párrafo",
            "ultimo parrafo",
        )
    )


_PASSAGE_SEP = "\n\n────────────────────\n\n"


def _english_extract_passages(section: str) -> Dict[int, str]:
    passages: Dict[int, str] = {}
    for m in re.finditer(
        r"(?mi)^\s*RESPONDE\s+"
        r"(?:LAS\s+PREGUNTAS\s+(\d{1,2})\s+(?:A|Y)\s+(\d{1,2})|LA\s+PREGUNTA\s+(\d{1,2}))\b[^\n]*$",
        section,
    ):
        if m.group(3):
            a = b = int(m.group(3))
        else:
            a, b = int(m.group(1)), int(m.group(2))
        sub = section[m.end() :]
        qm = re.search(r"(?m)^\s*\d{1,2}\.\s+", sub)
        if not qm:
            continue
        body = _clean_passage_body(sub[: qm.start()])
        if len(body) < 15:
            continue
        for q in range(a, b + 1):
            passages[q] = body
    return passages


def _split_questions(full_text: str) -> List[Tuple[int, str]]:
    text = re.sub(r"[ \t]+\n", "\n", full_text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    matches = list(re.finditer(r"(?m)^\s*Pregunta\s+(\d{1,3})\s*$", text))
    out: List[Tuple[int, str]] = []
    for i, m in enumerate(matches):
        qn = int(m.group(1))
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[start:end].strip()
        out.append((qn, block))
    return out


def _split_questions_english_section(sec: str) -> List[Tuple[int, str, Optional[List[str]]]]:
    text = re.sub(r"[ \t]+\n", "\n", sec)
    text = re.sub(r"\n{3,}", "\n\n", text)

    def extract_bank(sec_text: str) -> Optional[List[str]]:
        bank: List[str] = []
        for m in re.finditer(r"(?m)^\s*([A-H])\.\s+(.*)$", sec_text):
            bank.append(m.group(2).strip())
        if len(bank) >= 4:
            return bank
        return None

    out: List[Tuple[int, str, Optional[List[str]]]] = []
    sec_matches = list(re.finditer(r"(?mi)^\s*RESPONDE\s+LAS\s+PREGUNTAS\s+(\d{1,2})\s+A\s+(\d{1,2}).*$", text))
    if not sec_matches:
        sec_matches = [re.match(r"^", text)]  # type: ignore

    for i, sm in enumerate(sec_matches):
        start = sm.end()
        end = sec_matches[i + 1].start() if i + 1 < len(sec_matches) else len(text)
        chunk = text[start:end].strip()
        bank = extract_bank(chunk)
        qms = list(re.finditer(r"(?m)^\s*(\d{1,2})\.\s+", chunk))
        for j, qm in enumerate(qms):
            qn = int(qm.group(1))
            qs = qm.start()
            qe = qms[j + 1].start() if j + 1 < len(qms) else len(chunk)
            block = chunk[qs:qe].strip()
            out.append((qn, block, bank))
    return out


def _parse_choices(block: str) -> Tuple[str, List[str]]:
    m = re.search(r"(?m)^\s*A\.\s+", block)
    if not m:
        stem, choices = _parse_inline_letter_choices(block)
        return stem, choices

    stem = block[: m.start()].strip()
    opts_text = block[m.start() :].strip()
    pieces = re.split(r"(?m)^\s*([A-E])\.\s+", opts_text)
    choices: List[str] = []
    for j in range(1, len(pieces), 2):
        content = pieces[j + 1].strip()
        if content.lower().startswith("tabla de respuestas"):
            break
        content = _strip_boilerplate_tail(content)
        content = re.sub(r"\n{2,}", "\n", content).strip()
        choices.append(content)
    return stem, choices


def _parse_choices_any(block: str) -> Tuple[str, List[str]]:
    m = re.search(r"(?m)^\s*A\.\s+", block)
    if not m:
        stem, choices = _parse_inline_letter_choices(block)
        return stem, choices

    stem = block[: m.start()].strip()
    opts_text = block[m.start() :].strip()
    pieces = re.split(r"(?m)^\s*([A-H])\.\s+", opts_text)
    choices: List[str] = []
    for j in range(1, len(pieces), 2):
        content = pieces[j + 1].strip()
        content = _strip_boilerplate_tail(content)
        content = re.sub(r"\n{2,}", "\n", content).strip()
        choices.append(content)
    return stem, choices


def _split_inline_letter_choices(rest: str) -> List[str]:
    marks = list(re.finditer(r"(?:^|\s)([A-H])\.\s+", rest))
    if len(marks) < 2:
        return []
    choices: List[str] = []
    for i, mk in enumerate(marks):
        start = mk.end()
        end = marks[i + 1].start() if i + 1 < len(marks) else len(rest)
        choices.append(rest[start:end].strip())
    return choices


def _parse_inline_letter_choices(block: str) -> Tuple[str, List[str]]:
    """
    Caso frecuente en Inglés: '9. A.    much  B.    more  C.    most' en una sola línea.
    """
    lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
    if not lines:
        return "", []

    last = lines[-1]
    mnum = re.match(r"^(\d{1,2})\.\s*(.+)$", last)
    if not mnum:
        return block.strip(), []

    num_line = mnum.group(1)
    rest_last = mnum.group(2).strip()
    if not re.search(r"(?:^|\s)[A-H]\.\s+", rest_last):
        return block.strip(), []

    choices = _split_inline_letter_choices(rest_last)
    if len(choices) < 2:
        return block.strip(), []

    stem_lines = lines[:-1]
    if stem_lines:
        stem = "\n".join(stem_lines).strip()
    else:
        stem = f"Pregunta {num_line}"

    return stem, choices


def _dedupe_english_blocks(items: List[Tuple[int, str, Optional[List[str]]]]) -> List[Tuple[int, str, Optional[List[str]]]]:
    """
    Conserva un solo bloque por número (1..25), priorizando el más largo y sin basura de ejemplo.
    """
    best: Dict[int, Tuple[int, str, Optional[List[str]]]] = {}

    for qn, block, bank in items:
        if qn <= 0:
            continue
        if re.search(r"(?i)respuesta:\s*0\.", block):
            continue
        b = _strip_boilerplate_tail(block)
        if "Cuadernillo de preguntas" in b:
            b = b.split("Cuadernillo de preguntas")[0].strip()
        b = re.sub(r"(?is)\n\s*Respuesta:\s*.*$", "", b).strip()

        prev = best.get(qn)
        score = len(b)
        if prev is None:
            best[qn] = (qn, b, bank)
            continue
        prev_score = len(prev[1])
        if score > prev_score:
            best[qn] = (qn, b, bank)

    uniq = sorted(best.items(), key=lambda kv: kv[0])
    return [t for _, t in uniq]


def _english_questions_region(full_text: str) -> str:
    idx = full_text.find("Tabla de respuestas correctas")
    return full_text[:idx] if idx != -1 else full_text


def _split_english_exams(region: str) -> Tuple[str, str]:
    m = re.search(r"Prueba Ingl.{0,40}Examen\s+2", region, flags=re.IGNORECASE)
    if not m:
        return region, ""
    return region[: m.start()], region[m.start() :]


def _infer_topic_math(text: str) -> Optional[str]:
    t = text.lower()
    rules = [
        ("Porcentaje", ["porcentaje", "%", "descuento", "aumento"]),
        ("Razones y proporciones", ["propor", "razón", "regla de tres", "escala"]),
        ("Estadística", ["promedio", "media", "mediana", "moda", "tabla", "frecuencia"]),
        ("Probabilidad", ["probabilidad", "azar", "evento", "posible", "dado", "moneda"]),
        (
            "Geometría",
            ["triáng", "círc", "radio", "diámetro", "área", "perímetro", "volumen", "ángulo", "políg", "paralel", "recta"],
        ),
        ("Funciones", ["función", "f(x)", "gráfica", "dominio", "rango"]),
        ("Álgebra", ["ecuación", "expresión", "factor", "despeje", "sistema"]),
        ("Aritmética", ["suma", "resta", "multip", "divide", "entero", "fracción", "decimal"]),
    ]
    for topic, keys in rules:
        if any(k in t for k in keys):
            return topic
    return None


def _infer_topic_reading(text: str) -> Optional[str]:
    t = text.lower()
    rules = [
        ("Inferencia", ["infer", "implic", "sugiere", "podría concluir"]),
        ("Vocabulario en contexto", ["significa", "sinónimo", "sentido de", "refiere"]),
        ("Estructura del texto", ["título", "párrafo", "organiza", "función del"]),
        ("Relación entre ideas", ["compara", "contrasta", "relación", "conecta"]),
        ("Propósito del autor", ["propósito", "intención", "objetivo", "busca"]),
    ]
    for topic, keys in rules:
        if any(k in t for k in keys):
            return topic
    return "Comprensión lectora"


def _infer_topic_science(text: str) -> Optional[str]:
    t = text.lower()
    rules = [
        ("Biología", ["célula", "adn", "gen", "ecosistema", "fotosíntesis", "evolución", "cuerpo", "órgano"]),
        ("Física", ["velocidad", "fuerza", "energía", "movimiento", "onda", "electric", "presión", "calor"]),
        ("Química", ["mol", "átomo", "enlace", "reacción", "ácido", "ph", "oxid", "solución"]),
    ]
    for topic, keys in rules:
        if any(k in t for k in keys):
            return topic
    return "Ciencias integradas"


def _infer_difficulty_by_position(qn: int, max_q: int) -> str:
    if max_q <= 0:
        return "medium"
    p = qn / max_q
    if p <= 0.33:
        return "easy"
    if p <= 0.75:
        return "medium"
    return "hard"


def _module_name_from_filename(name: str) -> str:
    n = name.lower()
    if "matematic" in n:
        return "Matemáticas"
    if "lectura" in n:
        return "Lectura Crítica"
    if "ingles" in n or "ingl" in n:
        return "Inglés"
    if "ciencias" in n:
        return "Ciencias Naturales"
    if "social" in n:
        return "Sociales y Ciudadanas"
    return "General"


def _letter_to_index(letter: Optional[str], n: int) -> int:
    if not letter:
        return 0
    idx = ord(letter.upper()) - ord("A")
    if idx < 0 or idx >= n:
        return 0
    return idx


def _build_feedback(
    module_name: str,
    stem: str,
    choices: List[str],
    correct_index: int,
    correct_letter: Optional[str],
) -> Tuple[str, List[str]]:
    n = len(choices)
    letters = [chr(ord("A") + i) for i in range(n)]
    L = (correct_letter or "").strip().upper() or letters[correct_index]
    hook = (stem or "").strip().split("\n")[0].strip()
    if len(hook) > 200:
        hook = hook[:199].rstrip() + "…"

    explain = (
        f"Respuesta correcta: {L}. En {module_name} se te pide cerrar el razonamiento a partir del enunciado "
        f"(«{hook}»). La opción {L} es la que mejor encaja: no contradice los datos ni la consigna."
    )

    wrong_hints = [
        "Atiende a un detalle parcial pero no responde exactamente lo que se pregunta.",
        "Mezcla datos o ideas ciertas con una conclusión que no se desprende del enunciado.",
        "Confunde comparaciones (totales, promedios, mayorías, extremos) sin verificar la consigna exacta.",
        "Exige información o pasos que el ejercicio no pide para decidir.",
    ]
    wi = 0
    fb: List[str] = []
    for i, txt in enumerate(choices):
        clip = (txt or "").replace("\n", " ").strip()
        if len(clip) > 220:
            clip = clip[:219].rstrip() + "…"
        if i == correct_index:
            fb.append(
                f"Sí ({letters[i]}). {clip} — es coherente con la pregunta y con la evidencia disponible."
            )
        else:
            hint = wrong_hints[wi % len(wrong_hints)]
            wi += 1
            short = clip[:140] + ("…" if len(clip) > 140 else "")
            fb.append(f"No ({letters[i]}). {short} — {hint} Compara con la línea de razonamiento de ({L}).")
    return explain, fb


def parse_pdf(path: Path, full_text: Optional[str] = None) -> Tuple[str, List[ParsedQuestion]]:
    if full_text is None:
        full_text = normalize_extracted_text(extract_full_text_pdf(path))
    else:
        full_text = normalize_extracted_text(full_text)
    module = _module_name_from_filename(path.name)

    if module == "Inglés":
        answers_all = _resolve_answers(full_text, module)
        region = _english_questions_region(full_text)
        ex1_txt, ex2_txt = _split_english_exams(region)

        parsed: List[ParsedQuestion] = []
        exam_chunks: List[Tuple[str, int]] = []
        if ex1_txt.strip():
            exam_chunks.append((ex1_txt, 0))
        if ex2_txt.strip():
            exam_chunks.append((ex2_txt, 25))

        for chunk, offset in exam_chunks:
            passages = _english_extract_passages(chunk)
            raw = _split_questions_english_section(chunk)
            deduped = _dedupe_english_blocks(raw)
            for qn, block, bank in deduped:
                stem, choices = _parse_choices_any(block)
                if (not choices or len(choices) < 2) and bank:
                    stem = re.sub(r"(?m)^\s*\d{1,2}\.\s+", "", stem).strip()
                    choices = bank[:]
                stem = _strip_boilerplate_tail(stem)
                stem_lines = _clean_lines(stem)
                stem_clean = _polish_stem("\n".join(stem_lines).strip())
                choice_clean = [_polish_choice("\n".join(_clean_lines(c)).strip()) for c in choices]
                global_n = offset + qn
                pre = passages.get(qn, "").strip()
                if pre:
                    stem_clean = pre + _PASSAGE_SEP + stem_clean
                correct = answers_all.get(global_n) or answers_all.get(qn)
                parsed.append(
                    ParsedQuestion(number=global_n, text=stem_clean, choices=choice_clean, correct_letter=correct)
                )

        return module, parsed

    answers = _resolve_answers(full_text, module)
    passages: Dict[int, str] = {}
    if module == "Lectura Crítica":
        passages = _lectura_extract_passages(full_text)

    qblocks = _split_questions(full_text)
    parsed: List[ParsedQuestion] = []
    for qn, block in qblocks:
        stem, choices = _parse_choices(block)
        stem = _strip_boilerplate_tail(stem)
        stem_lines = _clean_lines(stem)
        stem_clean = _polish_stem("\n".join(stem_lines).strip())
        choice_clean = [_polish_choice("\n".join(_clean_lines(c)).strip()) for c in choices]
        pre = passages.get(qn, "").strip()
        if not pre and module == "Lectura Crítica" and _needs_trailing_passage(stem_clean):
            pre = _extract_trailing_passage_from_block(block)
        if pre:
            stem_clean = pre + _PASSAGE_SEP + stem_clean
        correct = answers.get(qn)
        parsed.append(ParsedQuestion(number=qn, text=stem_clean, choices=choice_clean, correct_letter=correct))

    return module, parsed


def build_import_json(pdf_paths: List[Path]) -> dict:
    now = int(time.time() * 1000)
    modules_by_name: Dict[str, dict] = {}
    questions: List[dict] = []
    sources: List[dict] = []

    for pdf in pdf_paths:
        module_name, parsed = parse_pdf(pdf)
        if module_name not in modules_by_name:
            modules_by_name[module_name] = {"id": str(uuid.uuid4()), "name": module_name, "createdAt": now}
        module_id = modules_by_name[module_name]["id"]

        sources.append(
            {
                "id": str(uuid.uuid4()),
                "type": "pdf",
                "name": pdf.name,
                "mime": "application/pdf",
                "size": pdf.stat().st_size,
                "createdAt": now,
            }
        )

        max_q = max((q.number for q in parsed), default=0)
        for q in parsed:
            if not q.choices or len(q.choices) < 2:
                continue
            correct_index = _letter_to_index(q.correct_letter, len(q.choices))

            topic = None
            if module_name == "Matemáticas":
                topic = _infer_topic_math(q.text)
            elif module_name == "Lectura Crítica":
                topic = _infer_topic_reading(q.text)
            elif module_name == "Ciencias Naturales":
                topic = _infer_topic_science(q.text)
            elif module_name == "Inglés":
                topic = "Inglés (cuadernillo)" if max_q > 25 else "Inglés"

            difficulty = _infer_difficulty_by_position(q.number, max_q)
            explain, option_fb = _build_feedback(module_name, q.text, q.choices, correct_index, q.correct_letter)

            questions.append(
                {
                    "id": str(uuid.uuid4()),
                    "moduleId": module_id,
                    "difficulty": difficulty,
                    "topic": topic,
                    "text": q.text,
                    "choices": q.choices,
                    "correctIndex": correct_index,
                    "explain": explain,
                    "optionFeedback": option_fb,
                    "imageDataUrl": None,
                    "sourceFile": pdf.name,
                    "sourcePos": q.number,
                    "createdAt": now,
                    "updatedAt": now,
                    "box": 1,
                    "seenCount": 0,
                    "correctCount": 0,
                    "wrongCount": 0,
                    "nextDueAt": None,
                    "lastAttemptAt": None,
                }
            )

    modules = list(modules_by_name.values())
    return {
        "bundleRevision": 2,
        "exportedAt": now,
        "db": {
            "meta": [{"key": "app", "version": 1, "bootstrappedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z")}],
            "modules": modules,
            "sources": sources,
            "questions": questions,
            "attempts": [],
        },
    }


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", help="Carpeta con PDFs")
    ap.add_argument("--pdfs", nargs="*", help="Rutas directas a PDFs")
    ap.add_argument("--out", required=True, help="Ruta JSON de salida")
    args = ap.parse_args()

    pdfs: List[Path] = []
    if args.pdfs:
        pdfs = [Path(p) for p in args.pdfs]
    elif args.input_dir:
        inp = Path(args.input_dir)
        pdfs = sorted([p for p in inp.glob("*.pdf") if p.is_file()])
    else:
        raise SystemExit("Usa --input-dir o --pdfs")

    missing = [str(p) for p in pdfs if not p.is_file()]
    if missing:
        raise SystemExit("No existen: " + ", ".join(missing))
    if not pdfs:
        raise SystemExit("No encontré PDFs.")

    dump = build_import_json(pdfs)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(dump, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OK: {len(pdfs)} PDFs -> {len(dump['db']['questions'])} preguntas en {args.out}")


if __name__ == "__main__":
    main()
