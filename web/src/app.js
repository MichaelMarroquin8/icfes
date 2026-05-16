import { openAppDb } from "./db.js";
import { defaultModules, normalizeModuleName, nowIso, startOfTodayIso } from "./models.js";
import { createDebouncedBackupWriter, readLocalBackup } from "./storage_backup.js";
import {
  byId,
  downloadJson,
  fileToDataUrl,
  formatDateTime,
  renderChoiceEditor,
  renderOptionFeedbackEditor,
  setActiveTab,
  toast,
} from "./ui.js";

const APP_VERSION = 2;

/** @typedef {import("./models.js").Module} Module */
/** @typedef {import("./models.js").Question} Question */
/** @typedef {import("./models.js").Attempt} Attempt */

const state = {
  db: null,
  activeTab: "home",
  selectedQuestionId: null,
  currentQuestion: null,
  currentSelectedChoice: null,
  scheduleLocalBackup: null,
};

async function main() {
  state.db = await openAppDb();
  state.scheduleLocalBackup = createDebouncedBackupWriter({
    getDump: async () => state.db.exportLite(),
    delayMs: 1200,
  });
  await ensureBootstrap();
  wireTabs();
  await wireModulesUI();
  await refreshStudyTopics();
  wireStudy();
  wirePlan();
  wireHome();
  wireLibrary();
  wireProgress();
  wireSettings();

  setActiveTab("home");
  await refreshAll();
}

async function ensureBootstrap() {
  const meta = await state.db.meta.get("app");
  if (meta?.version === APP_VERSION) {
    // Still ensure bundled data + module integrity on every run.
    await tryAutoImportBundledQuestions();
    await state.db.modules.mergeDuplicatesByName();
    let modulesQuick = await state.db.modules.getAll();
    if (modulesQuick.length === 0) {
      for (const m of defaultModules()) await state.db.modules.put(m);
      await state.db.modules.mergeDuplicatesByName();
    }
    return;
  }

  let modules = await state.db.modules.getAll();
  const questionsCount = (await state.db.questions.countsByModule(null)).total;

  // Always try to ensure the bundled questions are present (without duplicates).
  await tryAutoImportBundledQuestions();
  modules = await state.db.modules.getAll();

  // Recovery: if DB is empty but localStorage has a backup, offer restore.
  if (modules.length === 0 && questionsCount === 0) {
    const backup = readLocalBackup();
    if (backup?.db?.modules?.length || backup?.db?.questions?.length) {
      const ok = confirm("Encontré un respaldo local (localStorage). ¿Quieres restaurarlo ahora? (Recomendado)");
      if (ok) {
        await state.db.importAll(backup);
        modules = await state.db.modules.getAll();
      }
    }
  }

  if (modules.length === 0) {
    for (const m of defaultModules()) await state.db.modules.put(m);
  }

  // Make sure duplicate module names don't split questions.
  await state.db.modules.mergeDuplicatesByName();

  await state.db.meta.put({ key: "app", version: APP_VERSION, bootstrappedAt: nowIso() });
  state.scheduleLocalBackup?.();
}

/**
 * Convierte `cuadernillos_curados.json` (agrupado por PDF) al formato de `ensureBundled`.
 * @param {any} cur
 */
function bundleFromCurated(cur) {
  const exportedAt = cur.exportedAt ?? Date.now();
  const questions = [];
  for (const cu of cur.cuadernillos ?? []) {
    for (const p of cu.preguntas ?? []) {
      questions.push({
        id: p.id,
        moduleId: p.moduleId ?? cu.moduleId,
        difficulty: p.dificultad ?? "medium",
        topic: p.tema ?? null,
        text: p.enunciado ?? "",
        choices: p.opciones ?? [],
        correctIndex: p.indiceCorrecto ?? 0,
        explain: p.explicacion ?? "",
        optionFeedback: p.retroalimentacionPorOpcion ?? [],
        imageDataUrl: null,
        sourceFile: cu.archivoPdf,
        sourcePos: p.numeroEnCuadernillo,
        createdAt: exportedAt,
        updatedAt: exportedAt,
        box: 1,
        seenCount: 0,
        correctCount: 0,
        wrongCount: 0,
        nextDueAt: null,
        lastAttemptAt: null,
      });
    }
  }
  return {
    bundleRevision: cur.bundleRevision ?? 2,
    exportedAt,
    db: {
      meta: cur.meta ?? [],
      modules: cur.modulos ?? [],
      sources: cur.fuentes ?? [],
      questions,
    },
  };
}

/**
 * Fusiona los JSON por cuadernillo (manifest + varios archivos).
 * @param {any[]} docs
 */
function bundleFromCuadernilloJsonDocs(docs) {
  const modulesMap = new Map();
  const questions = [];
  let exportedAt = 0;
  for (const doc of docs) {
    if (doc?.format !== "cuadernillo_json_v1") continue;
    const t = doc.exportedAt ?? 0;
    if (t > exportedAt) exportedAt = t;
    const mid = doc.moduleId;
    if (!mid || !doc.moduloNombre) continue;
    modulesMap.set(mid, { id: mid, name: doc.moduloNombre, createdAt: doc.exportedAt ?? exportedAt });
    for (const p of doc.preguntas ?? []) {
      questions.push({
        id: p.id,
        moduleId: mid,
        difficulty: p.dificultad ?? "medium",
        topic: p.tema ?? null,
        text: p.enunciado ?? "",
        choices: p.opciones ?? [],
        correctIndex: p.indiceCorrecto ?? 0,
        explain: p.explicacionGeneral ?? "",
        optionFeedback: p.feedbackPorOpcion ?? [],
        imageDataUrl: null,
        sourceFile: doc.archivoPdf,
        sourcePos: p.numero,
        createdAt: doc.exportedAt ?? exportedAt,
        updatedAt: doc.exportedAt ?? exportedAt,
        box: 1,
        seenCount: 0,
        correctCount: 0,
        wrongCount: 0,
        nextDueAt: null,
        lastAttemptAt: null,
      });
    }
  }
  const now = exportedAt || Date.now();
  return {
    bundleRevision: 6,
    exportedAt: now,
    db: {
      meta: [{ key: "app", version: 1, bootstrappedAt: new Date(now).toISOString() }],
      modules: [...modulesMap.values()],
      sources: [],
      questions,
    },
  };
}

async function tryAutoImportBundledQuestions() {
  try {
    const manRes = await fetch("./data/cuadernillos/manifest.json", { cache: "no-store" });
    if (manRes.ok) {
      const man = await manRes.json();
      if (man?.format === "cuadernillos_manifest_v1" && Array.isArray(man.archivos) && man.archivos.length) {
        const docs = [];
        for (const e of man.archivos) {
          const r = await fetch(e.url, { cache: "no-store" });
          if (!r.ok) continue;
          const doc = await r.json();
          docs.push(doc);
        }
        const fromManifest = docs.filter((d) => d?.format === "cuadernillo_json_v1");
        if (fromManifest.length === man.archivos.length && fromManifest.length) {
          const data = bundleFromCuadernilloJsonDocs(fromManifest);
          if (data?.db?.questions?.length) {
            const added = await state.db.questions.ensureBundled(data);
            await state.db.modules.mergeDuplicatesByName();
            if (added > 0) state.scheduleLocalBackup?.();
            return true;
          }
        }
      }
    }

    const urls = ["./data/cuadernillos_curados.json", "./data/icfes_import.json"];
    let data = null;
    for (const url of urls) {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const j = await res.json();
      if (j?.format === "cuadernillos_curados_v1") {
        data = bundleFromCurated(j);
        break;
      }
      if (j?.db?.questions?.length) {
        data = j;
        break;
      }
    }
    if (!data?.db?.questions?.length) return false;
    const added = await state.db.questions.ensureBundled(data);
    await state.db.modules.mergeDuplicatesByName();
    if (added > 0) state.scheduleLocalBackup?.();
    return true;
  } catch (e) {
    console.warn("Auto-import falló:", e);
    return false;
  }
}

function wireTabs() {
  const buttons = Array.from(document.querySelectorAll(".tabbtn"));
  for (const btn of buttons) {
    btn.addEventListener("click", async () => {
      const tab = btn.getAttribute("data-tab");
      if (tab === "home" && document.getElementById("study-module")?.value) {
        const hm = document.getElementById("home-module");
        if (hm) hm.value = byId("study-module").value;
      }
      setActiveTab(tab);
      try {
        await refreshAll();
      } catch (e) {
        console.error("[Icfes] refreshAll", e);
      }
    });
  }
}

async function wireModulesUI() {
  const selects = [
    byId("home-module"),
    byId("study-module"),
    byId("f-module"),
    byId("q-filter-module"),
    byId("p-module"),
    byId("plan-module"),
  ];

  async function loadModules() {
    let modules = await state.db.modules.getAll();
    for (const select of selects) {
      const current = select.value;
      select.innerHTML = "";
      const allOption = document.createElement("option");
      allOption.value = "";
      allOption.textContent = "Todos";
      if (select.id !== "f-module" && select.id !== "study-module" && select.id !== "home-module")
        select.appendChild(allOption);

      for (const m of modules) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name;
        select.appendChild(opt);
      }

      if (select.id === "home-module") {
        const first = select.firstElementChild;
        const allAreas = document.createElement("option");
        allAreas.value = "";
        allAreas.textContent = "Todas las áreas";
        select.insertBefore(allAreas, first);
      }

      if (current && Array.from(select.options).some((o) => o.value === current)) select.value = current;
    }

    const hm = byId("home-module");
    if (hm && !hm.value && hm.querySelector('option[value=""]')) hm.value = "";

    if (!byId("study-module").value) {
      byId("study-module").value = modules[0]?.id || "";
    }
    if (!byId("f-module").value) byId("f-module").value = modules[0]?.id ?? "";
    if (!byId("p-module").value) byId("p-module").value = "";
  }

  await loadModules();

  const modCount = (await state.db.modules.getAll()).length;
  if (modCount === 0) {
    for (const m of defaultModules()) await state.db.modules.put(m);
    await loadModules();
  }

  // Expose to other areas
  state.reloadModules = loadModules;
}

async function refreshAll() {
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      console.error(`[Icfes] ${name}`, e);
    }
  };
  await step("módulos", refreshModuleList);
  await step("biblioteca", refreshQuestionList);
  await step("fuentes", refreshSourcesList);
  await step("plan", refreshPlan);
  await step("progreso", refreshProgress);
  await step("inicio", refreshHome);
  await step("estudio", refreshStudyStatus);
  await step("temas", refreshStudyTopics);
  await step("contexto", refreshStudyRepasoContext);
}

async function refreshHome() {
  const root = document.getElementById("home-topics");
  const hm = document.getElementById("home-module");
  const goWhole = document.getElementById("home-go-module");
  if (!root || !hm) return;

  const filterId = hm.value;
  const modules = await state.db.modules.getAll();
  if (!modules.length) {
    root.innerHTML = `<p class="muted">No hay áreas todavía.</p>`;
    if (goWhole) goWhole.hidden = true;
    return;
  }

  const list = filterId ? modules.filter((m) => m.id === filterId) : modules;
  if (filterId && list.length === 0) {
    root.innerHTML = `<p class="muted">Área no encontrada.</p>`;
    if (goWhole) goWhole.hidden = true;
    return;
  }

  root.innerHTML = "";
  let anyTopics = false;

  for (const mod of list) {
    const stats = await state.db.progress.getTopicPlan({ moduleId: mod.id, now: Date.now() });
    if (!stats.route.length) {
      if (filterId) {
        root.innerHTML = `<p class="muted">Aún no hay temas etiquetados en <strong>${escapeAttr(mod.name ?? "esta área")}</strong>. Puedes cargar el cuadernillo o crear ítems en Biblioteca.</p>`;
        if (goWhole) goWhole.hidden = false;
        return;
      }
      continue;
    }

    anyTopics = true;
    const block = document.createElement("section");
    block.className = "home-module-block";
    const blockTitle = document.createElement("h2");
    blockTitle.className = "home-module-block-title";
    blockTitle.textContent = mod.name || "Área";
    block.appendChild(blockTitle);

    const grid = document.createElement("div");
    grid.className = "home-topic-grid";
    block.appendChild(grid);

    for (const row of stats.route) {
      const card = document.createElement("article");
      card.className = "home-topic-card";

      const strength =
        row.masteryPct >= 70 ? "Vas bien" : row.masteryPct >= 35 ? "En progreso" : "Prioridad para reforzar";

      card.innerHTML = `
        <div class="home-topic-head">
          <h3 class="home-topic-name"></h3>
          <span class="home-topic-badge"></span>
        </div>
        <p class="home-topic-detail muted"></p>
        <button type="button" class="primary home-topic-repaso">Repaso</button>
      `;

      card.querySelector(".home-topic-name").textContent = row.topic;
      card.querySelector(".home-topic-badge").textContent = strength;
      card.querySelector(".home-topic-detail").textContent = `Dominio aproximado ${row.masteryPct}% en este tema.`;

      const mid = mod.id;
      card.querySelector(".home-topic-repaso").addEventListener("click", async () => {
        byId("study-module").value = mid;
        await refreshStudyTopics();
        byId("study-topic").value = row.topic;
        byId("study-mode").value = "progressive";
        await refreshStudyRepasoContext();
        setActiveTab("study");
        await refreshAll();
        await pickAndShowNextQuestion();
      });

      grid.appendChild(card);
    }

    root.appendChild(block);
  }

  if (!anyTopics) {
    root.innerHTML = `<p class="muted">Aún no hay temas etiquetados. Puedes cargar el cuadernillo o crear ítems en Biblioteca.</p>`;
  }

  if (goWhole) goWhole.hidden = !filterId;
}

function escapeAttr(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function refreshStudyRepasoContext() {
  const el = document.getElementById("study-repaso-context");
  if (!el) return;
  const moduleId = byId("study-module").value;
  const topic = byId("study-topic").value?.trim() || "";
  const mod = await state.db.modules.get(moduleId);
  const parts = [mod?.name ?? "Área"];
  parts.push(topic || "Todos los temas");
  el.textContent = parts.join(" · ");
}

function wireHome() {
  byId("home-module").addEventListener("change", async () => {
    await refreshHome();
  });

  byId("home-go-module").addEventListener("click", async () => {
    const moduleId = byId("home-module").value;
    if (!moduleId) return toast("Elige un área.");
    byId("study-module").value = moduleId;
    await refreshStudyTopics();
    byId("study-topic").value = "";
    byId("study-mode").value = "progressive";
    await refreshStudyRepasoContext();
    setActiveTab("study");
    await refreshAll();
    await pickAndShowNextQuestion();
  });

  byId("study-back-home").addEventListener("click", async () => {
    byId("home-module").value = byId("study-module").value;
    setActiveTab("home");
    await refreshAll();
  });
}

// -------------------- Study --------------------

function wireStudy() {
    byId("study-module").addEventListener("change", async () => {
      await refreshStudyTopics();
      await refreshStudyStatus();
      await refreshStudyRepasoContext();
    });
    byId("study-topic").addEventListener("change", async () => {
      await refreshStudyStatus();
      await refreshStudyRepasoContext();
    });

  byId("study-next").addEventListener("click", async () => {
    await pickAndShowNextQuestion();
  });

  byId("skip-question").addEventListener("click", async () => {
    if (!state.currentQuestion) return;
    await recordAttempt({ questionId: state.currentQuestion.id, selectedIndex: null, correct: null, skipped: true });
    await pickAndShowNextQuestion();
  });

  byId("submit-answer").addEventListener("click", async () => {
    if (!state.currentQuestion) return;
    if (state.currentSelectedChoice == null) return;

    const q = state.currentQuestion;
    const isCorrect = state.currentSelectedChoice === q.correctIndex;
    await recordAttempt({
      questionId: q.id,
      selectedIndex: state.currentSelectedChoice,
      correct: isCorrect,
      skipped: false,
    });
    await showFeedback(q, state.currentSelectedChoice, isCorrect);
  });

  byId("fb-continue").addEventListener("click", async () => {
    hideFeedback();
    await pickAndShowNextQuestion();
  });

  byId("fb-edit").addEventListener("click", async () => {
    if (!state.currentQuestion) return;
    setActiveTab("library");
    state.selectedQuestionId = state.currentQuestion.id;
    await refreshAll();
    await loadQuestionIntoEditor(state.currentQuestion.id);
  });
}

async function refreshStudyStatus() {
  const moduleId = byId("study-module").value;
  const counts = await state.db.questions.countsByModule(moduleId);
  const empty = byId("study-empty");
  const card = byId("study-card");

  if (counts.total === 0) {
    empty.hidden = false;
    card.hidden = true;
    byId("feedback-card").hidden = true;
    byId("study-empty-lead").textContent =
      "No hay preguntas en este módulo. Cambia de módulo o revisa Biblioteca / Ajustes.";
    return;
  }
  empty.hidden = true;
}

async function refreshStudyTopics() {
  const moduleId = byId("study-module").value || null;
  const select = byId("study-topic");
  const prev = select.value;
  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "Todos";
  select.appendChild(all);

  const topics = moduleId ? await state.db.questions.listTopics(moduleId) : [];
  for (const t of topics) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    select.appendChild(opt);
  }
  if (moduleId) {
    const qs = await state.db.questions.search({ q: "", moduleId, limit: 500 });
    if (qs.some((q) => !(q.topic ?? "").trim()) && !topics.includes("Sin tema")) {
      const opt = document.createElement("option");
      opt.value = "Sin tema";
      opt.textContent = "Sin tema";
      select.appendChild(opt);
    }
  }
  const allowed = new Set(Array.from(select.options, (o) => o.value));
  if (prev && allowed.has(prev)) select.value = prev;
}

const PASSAGE_SEP = "\n\n────────────────────\n\n";

function renderQuestionBody(text) {
  const raw = text ?? "";
  const parts = raw.split(PASSAGE_SEP);
  const passageWrap = byId("q-passage-wrap");
  const passageEl = byId("q-passage");
  const stemEl = byId("q-stem");
  if (parts.length >= 2 && parts[0].trim()) {
    passageEl.textContent = parts[0].trim();
    passageWrap.hidden = false;
    stemEl.textContent = parts.slice(1).join(PASSAGE_SEP).trim();
  } else {
    passageWrap.hidden = true;
    passageEl.textContent = "";
    stemEl.textContent = raw;
  }
}

async function pickAndShowNextQuestion() {
  hideFeedback();
  const moduleId = byId("study-module").value;
  const mode = byId("study-mode").value; // progressive | review | new | mix
  const topic = byId("study-topic").value || null;

  const q = await state.db.questions.pickNext({ moduleId, mode, topic, now: Date.now() });
  if (!q) {
    state.currentQuestion = null;
    byId("study-card").hidden = true;
    byId("study-empty").hidden = false;
    byId("study-empty-lead").textContent = topic
      ? "No hay preguntas con ese tema. Abre «Filtros» y elige «Todos» en Tema."
      : "No hay preguntas con este módulo o modo. Prueba otro módulo, otro modo o recarga (F5).";
    return;
  }

  state.currentQuestion = q;
  state.currentSelectedChoice = null;

  renderQuestionBody(q.text);

  const media = byId("q-media");
  if (q.imageDataUrl) {
    byId("q-image").src = q.imageDataUrl;
    media.hidden = false;
  } else {
    media.hidden = true;
  }

  renderChoices(q);
  byId("study-card").hidden = false;
  byId("study-empty").hidden = true;
  byId("study-empty-lead").innerHTML =
    'Pulsa <strong>Siguiente pregunta</strong> para otra, o <strong>← Volver a temas</strong> para cambiar de tema.';
  await refreshStudyRepasoContext();
  if (window.matchMedia("(max-width: 768px)").matches) {
    document.getElementById("study-stage")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderChoices(q) {
  const choicesRoot = byId("q-choices");
  choicesRoot.innerHTML = "";
  byId("submit-answer").disabled = true;

  q.choices.forEach((choiceText, idx) => {
    const label = document.createElement("label");
    label.className = "choice study-choice";
    label.tabIndex = 0;

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "choice";
    input.value = String(idx);
    input.addEventListener("change", () => {
      state.currentSelectedChoice = idx;
      byId("submit-answer").disabled = false;
    });

    label.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.checked = true;
        input.dispatchEvent(new Event("change"));
      }
    });

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "c-title";
    title.textContent = String.fromCharCode(65 + idx);
    const text = document.createElement("div");
    text.className = "c-body";
    text.textContent = choiceText;

    body.appendChild(title);
    body.appendChild(text);
    label.appendChild(input);
    label.appendChild(body);
    choicesRoot.appendChild(label);
  });
}

async function recordAttempt({ questionId, selectedIndex, correct, skipped }) {
  /** @type {Attempt} */
  const attempt = {
    id: crypto.randomUUID(),
    questionId,
    at: Date.now(),
    day: startOfTodayIso(),
    selectedIndex,
    correct,
    skipped,
  };
  await state.db.attempts.add(attempt);
  await state.db.questions.applyAttemptResult(questionId, { correct, skipped, at: attempt.at });
  state.scheduleLocalBackup?.();
}

function optFb(q, idx) {
  return String(q.optionFeedback?.[idx] ?? "").trim();
}

async function showFeedback(q, selectedIndex, isCorrect) {
  byId("study-card").hidden = true;

  const fb = byId("feedback-card");
  fb.hidden = false;

  const correctLetter = String.fromCharCode(65 + q.correctIndex);
  const selectedLetter = String.fromCharCode(65 + selectedIndex);

  const badge = byId("fb-badge");
  const line = byId("fb-line");
  const blocks = byId("fb-blocks");
  blocks.innerHTML = "";

  if (isCorrect) {
    badge.textContent = "Correcto";
    badge.className = "study-fb-badge study-fb-badge--ok";
    line.textContent = `Respuesta adecuada: ${correctLetter}.`;
    const hint = optFb(q, q.correctIndex) || q.explain?.trim() || "";
    if (hint) {
      const div = document.createElement("div");
      div.className = "study-fb-block";
      div.textContent = hint;
      blocks.appendChild(div);
    }
    return;
  }

  badge.textContent = "Incorrecto";
  badge.className = "study-fb-badge study-fb-badge--bad";
  line.textContent = `Elegiste ${selectedLetter}. La correcta es ${correctLetter}.`;

  const wrongWhy =
    optFb(q, selectedIndex) ||
    `Revisa por qué ${selectedLetter} no encaja con lo que pide el enunciado (datos, palabras clave o matices).`;
  const rightWhy =
    optFb(q, q.correctIndex) ||
    q.explain?.trim() ||
    `La opción ${correctLetter} es la que mejor cumple la consigna.`;

  const w = document.createElement("div");
  w.className = "study-fb-block";
  const wl = document.createElement("span");
  wl.className = "study-fb-label";
  wl.textContent = "Tu opción";
  const wt = document.createElement("div");
  wt.className = "study-fb-text";
  wt.textContent = wrongWhy;
  w.appendChild(wl);
  w.appendChild(wt);
  blocks.appendChild(w);

  const r = document.createElement("div");
  r.className = "study-fb-block";
  const rl = document.createElement("span");
  rl.className = "study-fb-label";
  rl.textContent = `Por qué ${correctLetter}`;
  const rt = document.createElement("div");
  rt.className = "study-fb-text";
  rt.textContent = rightWhy;
  r.appendChild(rl);
  r.appendChild(rt);
  blocks.appendChild(r);
}

function hideFeedback() {
  byId("feedback-card").hidden = true;
}

function difficultyLabel(d) {
  if (d === "easy") return "Fácil";
  if (d === "hard") return "Difícil";
  return "Media";
}

// -------------------- Library --------------------

function wireLibrary() {
  byId("add-question").addEventListener("click", async () => {
    state.selectedQuestionId = null;
    clearEditor();
  });

  byId("import-sources").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    await importSourcesFromFiles(files);
    e.target.value = "";
  });
  byId("src-filter").addEventListener("change", async () => refreshSourcesList());
  byId("src-clear").addEventListener("click", async () => {
    const ok = confirm("¿Eliminar todas las fuentes importadas (PDF/imágenes)?");
    if (!ok) return;
    await state.db.sources.clear();
    state.scheduleLocalBackup?.();
    await refreshSourcesList();
    toast("Fuentes eliminadas.");
  });

  byId("seed-sample").addEventListener("click", async () => {
    const created = await state.db.questions.seedSamples();
    toast(`Listo: ${created} preguntas de ejemplo.`);
    state.scheduleLocalBackup?.();
    await refreshAll();
  });

  byId("q-search").addEventListener("input", async () => {
    await refreshQuestionList();
  });
  byId("q-filter-module").addEventListener("change", async () => {
    await refreshQuestionList();
  });

  byId("new-question").addEventListener("click", () => {
    state.selectedQuestionId = null;
    clearEditor();
  });

  byId("delete-question").addEventListener("click", async () => {
    if (!state.selectedQuestionId) return;
    const ok = confirm("¿Eliminar esta pregunta? Esto también elimina su historial de intentos.");
    if (!ok) return;
    await state.db.questions.delete(state.selectedQuestionId);
    state.scheduleLocalBackup?.();
    state.selectedQuestionId = null;
    clearEditor();
    await refreshAll();
    toast("Pregunta eliminada.");
  });

  byId("f-image").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    byId("f-image").dataset.dataUrl = dataUrl;
    updateEditorImagePreview();
    toast("Imagen cargada (se guardará al guardar la pregunta).");
  });

  byId("q-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await saveEditorQuestion();
  });

  initEditorChoiceControls();
}

function initEditorChoiceControls() {
  const root = byId("f-choices");
  const initial = ["", "", "", ""];
  renderChoiceEditor(root, initial, () => syncOptionFeedbackAndCorrect());
  renderOptionFeedbackEditor(byId("f-option-feedback"), initial.length);
  refreshCorrectSelect();
}

function readEditorChoices() {
  const inputs = Array.from(byId("f-choices").querySelectorAll("textarea[data-choice]"));
  return inputs.map((t) => t.value.trim());
}

function readEditorOptionFeedback() {
  const inputs = Array.from(byId("f-option-feedback").querySelectorAll("textarea[data-optfb]"));
  return inputs.map((t) => t.value.trim());
}

function refreshCorrectSelect() {
  const correct = byId("f-correct");
  const prev = correct.value;
  const choices = readEditorChoices();
  correct.innerHTML = "";
  choices.forEach((_, idx) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = String.fromCharCode(65 + idx);
    correct.appendChild(opt);
  });
  if (prev) correct.value = prev;
}

function syncOptionFeedbackAndCorrect() {
  const choices = readEditorChoices();
  const currentFeedback = readEditorOptionFeedback();
  renderOptionFeedbackEditor(byId("f-option-feedback"), choices.length, currentFeedback);
  refreshCorrectSelect();
}

function clearEditor() {
  byId("editor-title").textContent = "Editor";
  byId("editor-status").textContent = "";
  byId("delete-question").disabled = true;

  byId("f-text").value = "";
  byId("f-topic").value = "";
  byId("f-explain").value = "";
  byId("f-image").value = "";
  delete byId("f-image").dataset.dataUrl;
  updateEditorImagePreview();

  initEditorChoiceControls();
  refreshCorrectSelect();
}

async function loadQuestionIntoEditor(id) {
  const q = await state.db.questions.get(id);
  if (!q) return;
  state.selectedQuestionId = q.id;
  byId("editor-title").textContent = `Editor • ${q.id.slice(0, 8)}`;
  byId("delete-question").disabled = false;
  byId("editor-status").textContent = `Creada: ${formatDateTime(q.createdAt)} • Actualizada: ${formatDateTime(q.updatedAt)}`;

  byId("f-module").value = q.moduleId;
  byId("f-difficulty").value = q.difficulty;
  byId("f-text").value = q.text;
  byId("f-topic").value = q.topic ?? "";
  byId("f-explain").value = q.explain ?? "";

  const root = byId("f-choices");
  renderChoiceEditor(root, q.choices, () => syncOptionFeedbackAndCorrect());
  syncOptionFeedbackAndCorrect();
  byId("f-correct").value = String(q.correctIndex);

  renderOptionFeedbackEditor(byId("f-option-feedback"), q.choices.length, q.optionFeedback ?? []);
  if (q.imageDataUrl) byId("f-image").dataset.dataUrl = q.imageDataUrl;
  updateEditorImagePreview();
}

async function saveEditorQuestion() {
  const moduleId = byId("f-module").value;
  const difficulty = byId("f-difficulty").value;
  const text = byId("f-text").value.trim();
  const topic = byId("f-topic").value.trim();
  const explain = byId("f-explain").value.trim();
  const choices = readEditorChoices();

  if (!moduleId) return toast("Crea o selecciona un módulo.");
  if (!text) return toast("Escribe el enunciado de la pregunta.");
  if (choices.some((c) => !c)) return toast("Completa todas las opciones (A, B, C, D...).");

  const correctIndex = Number(byId("f-correct").value);
  const optionFeedback = readEditorOptionFeedback();
  const imageDataUrl = byId("f-image").dataset.dataUrl ?? null;

  const now = Date.now();

  /** @type {Question} */
  const q = {
    id: state.selectedQuestionId ?? crypto.randomUUID(),
    moduleId,
    difficulty,
    topic: topic || null,
    text,
    choices,
    correctIndex,
    explain: explain || null,
    optionFeedback,
    imageDataUrl,
    createdAt: state.selectedQuestionId ? (await state.db.questions.get(state.selectedQuestionId))?.createdAt ?? now : now,
    updatedAt: now,
    // progress
    box: state.selectedQuestionId ? (await state.db.questions.get(state.selectedQuestionId))?.box ?? 1 : 1,
    seenCount: state.selectedQuestionId ? (await state.db.questions.get(state.selectedQuestionId))?.seenCount ?? 0 : 0,
    correctCount: state.selectedQuestionId ? (await state.db.questions.get(state.selectedQuestionId))?.correctCount ?? 0 : 0,
    wrongCount: state.selectedQuestionId ? (await state.db.questions.get(state.selectedQuestionId))?.wrongCount ?? 0 : 0,
    nextDueAt: state.selectedQuestionId ? (await state.db.questions.get(state.selectedQuestionId))?.nextDueAt ?? null : null,
    lastAttemptAt: state.selectedQuestionId ? (await state.db.questions.get(state.selectedQuestionId))?.lastAttemptAt ?? null : null,
  };

  await state.db.questions.put(q);
  state.scheduleLocalBackup?.();
  state.selectedQuestionId = q.id;
  byId("delete-question").disabled = false;
  byId("editor-title").textContent = `Editor • ${q.id.slice(0, 8)}`;
  byId("editor-status").textContent = `Actualizada: ${formatDateTime(q.updatedAt)}`;
  toast("Guardado.");
  await refreshQuestionList();
  await refreshStudyStatus();
}

async function refreshQuestionList() {
  const root = byId("q-list");
  if (!root) return;

  const q = byId("q-search").value.trim();
  const moduleId = byId("q-filter-module").value;
  const items = await state.db.questions.search({ q, moduleId, limit: 200 });

  root.innerHTML = "";
  if (items.length === 0) {
    const div = document.createElement("div");
    div.className = "muted";
    div.textContent = "No hay preguntas todavía. Crea una en el editor.";
    root.appendChild(div);
    return;
  }

  for (const item of items) {
    const module = await state.db.modules.get(item.moduleId);
    const li = document.createElement("div");
    li.className = "list-item";
    li.innerHTML = `
      <div>
        <div class="title"></div>
        <div class="sub"></div>
      </div>
      <div class="meta"></div>
    `;
    li.querySelector(".title").textContent = item.text.slice(0, 90) + (item.text.length > 90 ? "â€¦" : "");
    li.querySelector(".sub").textContent = `${module?.name ?? "Módulo"} • ${difficultyLabel(item.difficulty)} • Nivel ${item.box ?? 1}`;

    const meta = li.querySelector(".meta");
    if (item.seenCount === 0) meta.appendChild(pill("Nueva", "pill subtle"));
    if (item.nextDueAt && item.nextDueAt <= Date.now()) meta.appendChild(pill("Vencida", "pill warn"));
    meta.appendChild(pill(item.topic ? item.topic : "Sin tema", "pill subtle"));

    li.addEventListener("click", async () => {
      await loadQuestionIntoEditor(item.id);
    });
    root.appendChild(li);
  }
}

function pill(text, className) {
  const p = document.createElement("div");
  p.className = className;
  p.textContent = text;
  return p;
}

// -------------------- Sources (PDF / images) --------------------

async function importSourcesFromFiles(files) {
  const sources = [];
  const now = Date.now();

  for (const f of files) {
    const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
    const isImage = f.type.startsWith("image/");
    if (!isPdf && !isImage) continue;

    const id = crypto.randomUUID();
    if (isImage) {
      const dataUrl = await fileToDataUrl(f);
      sources.push({
        id,
        type: "image",
        name: f.name,
        mime: f.type,
        size: f.size,
        createdAt: now,
        dataUrl,
      });
    } else {
      sources.push({
        id,
        type: "pdf",
        name: f.name,
        mime: f.type || "application/pdf",
        size: f.size,
        createdAt: now,
        blob: f,
      });
    }
  }

  if (sources.length === 0) return toast("No encontré PDFs o imágenes en esa selección.");
  await state.db.sources.addMany(sources);
  state.scheduleLocalBackup?.();
  toast(`Importado: ${sources.length} archivo(s).`);
  await refreshSourcesList();
}

async function refreshSourcesList() {
  const root = document.getElementById("src-list");
  if (!root) return;
  const type = byId("src-filter").value || null;
  const items = await state.db.sources.list({ type, limit: 200 });
  root.innerHTML = "";
  if (items.length === 0) {
    const div = document.createElement("div");
    div.className = "muted";
    div.textContent = "Sin fuentes todavía. Importa capturas o PDFs para crear preguntas más rápido.";
    root.appendChild(div);
    return;
  }

  for (const src of items) {
    const li = document.createElement("div");
    li.className = "list-item";
    li.innerHTML = `
      <div>
        <div class="title"></div>
        <div class="sub"></div>
      </div>
      <div class="meta"></div>
    `;
    li.querySelector(".title").textContent = src.name;
    li.querySelector(".sub").textContent = `${src.type.toUpperCase()} • ${formatBytes(src.size)} • ${formatDateTime(src.createdAt)}`;

    const meta = li.querySelector(".meta");
    meta.appendChild(pill(src.type === "pdf" ? "PDF" : "Imagen", "pill subtle"));

    if (src.type === "image") {
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "primary";
      useBtn.textContent = "Usar";
      useBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await startQuestionFromImageSource(src);
      });
      meta.appendChild(useBtn);
    } else {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "Abrir";
      openBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await openPdfSource(src.id);
      });
      meta.appendChild(openBtn);
    }

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "X";
    del.title = "Eliminar";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await state.db.sources.delete(src.id);
      state.scheduleLocalBackup?.();
      await refreshSourcesList();
    });
    meta.appendChild(del);

    li.addEventListener("click", async () => {
      if (src.type === "image") await startQuestionFromImageSource(src);
      else await openPdfSource(src.id);
    });
    root.appendChild(li);
  }
}

async function startQuestionFromImageSource(src) {
  state.selectedQuestionId = null;
  clearEditor();
  byId("f-text").value = `Basada en: ${src.name}\n\n`;
  byId("f-image").dataset.dataUrl = src.dataUrl;
  toast("Imagen lista en el editor. Completa el enunciado y opciones.");
}

async function openPdfSource(id) {
  const src = await state.db.sources.get(id);
  if (!src?.blob) return toast("No pude abrir el PDF (no encontrado).");
  const url = URL.createObjectURL(src.blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function formatBytes(n) {
  const v = Number(n ?? 0);
  if (v < 1024) return `${v} B`;
  const kb = v / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function updateEditorImagePreview() {
  const input = document.getElementById("f-image");
  const wrap = document.getElementById("f-image-preview");
  if (!input || !wrap) return;
  const dataUrl = input.dataset.dataUrl ?? null;
  if (!dataUrl) {
    wrap.hidden = true;
    return;
  }
  const img = byId("f-image-preview-img");
  img.src = dataUrl;
  wrap.hidden = false;
}

// -------------------- Progress --------------------

function wireProgress() {
  byId("p-refresh").addEventListener("click", async () => {
    await refreshProgress();
  });
}

async function refreshProgress() {
  const moduleId = byId("p-module").value || null;
  const stats = await state.db.progress.getStats({ moduleId, now: Date.now() });

  byId("kpi-today").textContent = String(stats.todayAttempts);
  byId("kpi-today-sub").textContent = `${stats.todayCorrect} correctas • ${stats.todayWrong} incorrectas • ${stats.todaySkipped} saltadas`;

  byId("kpi-mastery").textContent = `${stats.masteryPct}%`;
  byId("kpi-mastery-sub").textContent = `${stats.learned} dominadas • ${stats.total} totales`;

  byId("kpi-due").textContent = String(stats.dueNow);
  byId("kpi-due-sub").textContent = `Vencidas ahora • ${stats.newCount} nuevas`;

  const detail = byId("p-detail");
  detail.innerHTML = "";
  for (const row of stats.byModule) {
    const li = document.createElement("div");
    li.className = "list-item";
    li.innerHTML = `
      <div>
        <div class="title"></div>
        <div class="sub"></div>
      </div>
      <div class="meta"></div>
    `;
    li.querySelector(".title").textContent = row.moduleName;
    li.querySelector(".sub").textContent = `${row.total} preguntas • ${row.newCount} nuevas • ${row.dueNow} vencidas`;
    const meta = li.querySelector(".meta");
    meta.appendChild(pill(`Dominio ${row.masteryPct}%`, "pill subtle"));
    detail.appendChild(li);
  }
}

// -------------------- Settings --------------------

function wireSettings() {
  byId("m-add").addEventListener("click", async () => {
    const name = normalizeModuleName(byId("m-name").value);
    if (!name) return toast("Escribe un nombre de módulo.");
    const mod = { id: crypto.randomUUID(), name, createdAt: Date.now() };
    await state.db.modules.put(mod);
    state.scheduleLocalBackup?.();
    byId("m-name").value = "";
    await state.reloadModules();
    await refreshModuleList();
    toast("Módulo agregado.");
  });

  byId("export-data").addEventListener("click", async () => {
    const dump = await state.db.exportAll();
    downloadJson(dump, `icfes-backup-${new Date().toISOString().slice(0, 10)}.json`);
    byId("backup-status").textContent = `Exportado: ${formatDateTime(Date.now())}`;
  });

  byId("import-data").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const data = JSON.parse(text);
    await state.db.importAll(data);
    state.scheduleLocalBackup?.();
    byId("backup-status").textContent = `Importado: ${formatDateTime(Date.now())}`;
    toast("Importación lista.");
    await refreshAll();
    e.target.value = "";
  });

  byId("reset-data").addEventListener("click", async () => {
    const ok = confirm("¿Borrar TODO? Esto elimina módulos, preguntas y progreso.");
    if (!ok) return;
    await state.db.reset();
    window.location.reload();
  });
}

async function refreshModuleList() {
  const root = byId("m-list");
  if (!root) return;
  let modules = await state.db.modules.getAll();
  root.innerHTML = "";
  for (const m of modules) {
    const li = document.createElement("div");
    li.className = "list-item";
    li.innerHTML = `
      <div>
        <div class="title"></div>
        <div class="sub"></div>
      </div>
      <div class="meta"></div>
    `;
    li.querySelector(".title").textContent = m.name;
    li.querySelector(".sub").textContent = `Creado: ${formatDateTime(m.createdAt)}`;
    const meta = li.querySelector(".meta");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "danger";
    btn.textContent = "Eliminar";
    btn.addEventListener("click", async () => {
      const ok = confirm(`¿Eliminar el módulo "${m.name}"? (También borra sus preguntas e intentos)`);
      if (!ok) return;
      await state.db.modules.deleteCascade(m.id);
      state.scheduleLocalBackup?.();
      await state.reloadModules();
      await refreshAll();
      toast("Módulo eliminado.");
    });
    meta.appendChild(btn);
    root.appendChild(li);
  }
}

// -------------------- Plan --------------------

function wirePlan() {
  byId("plan-refresh").addEventListener("click", async () => refreshPlan());
  byId("plan-module").addEventListener("change", async () => refreshPlan());

  byId("plan-start-topic").addEventListener("click", async () => {
    const topic = byId("plan-start-topic").dataset.topic || "";
    const moduleId = byId("plan-module").value;
    if (!moduleId) return;
    setActiveTab("study");
    byId("study-module").value = moduleId;
    await refreshStudyTopics();
    byId("study-topic").value = topic;
    byId("study-mode").value = "new";
    await pickAndShowNextQuestion();
  });

  byId("plan-start-mix").addEventListener("click", async () => {
    const moduleId = byId("plan-module").value;
    setActiveTab("study");
    byId("study-module").value = moduleId;
    await refreshStudyTopics();
    byId("study-topic").value = "";
    byId("study-mode").value = "mix";
    await pickAndShowNextQuestion();
  });
}

async function refreshPlan() {
  const root = document.getElementById("plan-route");
  if (!root) return;

  const moduleId = byId("plan-module").value || null;
  const stats = await state.db.progress.getTopicPlan({ moduleId, now: Date.now() });

  byId("plan-next-title").textContent = stats.nextTopic || "Sin temas";
  byId("plan-next-sub").textContent = stats.nextTopic
    ? `Enfócate aquí primero. Meta sugerida: 25 preguntas hoy.`
    : `No hay preguntas con tema aún en este módulo.`;

  byId("plan-start-topic").disabled = !stats.nextTopic;
  byId("plan-start-topic").dataset.topic = stats.nextTopic || "";

  root.innerHTML = "";
  for (const row of stats.route) {
    const li = document.createElement("div");
    li.className = "list-item";
    li.innerHTML = `
      <div>
        <div class="title"></div>
        <div class="sub"></div>
      </div>
      <div class="meta"></div>
    `;
    li.querySelector(".title").textContent = row.topic;
    li.querySelector(".sub").textContent = `${row.total} preguntas • Dominio ${row.masteryPct}% • Nuevas ${row.newCount} • Vencidas ${row.dueNow}`;
    const meta = li.querySelector(".meta");
    meta.appendChild(pill(row.masteryPct >= 70 ? "Fuerte" : row.masteryPct >= 35 ? "Medio" : "Débil", "pill subtle"));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "primary";
    btn.textContent = "Estudiar";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      setActiveTab("study");
      byId("study-module").value = stats.moduleId;
      await refreshStudyTopics();
      byId("study-topic").value = row.topic;
      byId("study-mode").value = "new";
      await pickAndShowNextQuestion();
    });
    meta.appendChild(btn);
    root.appendChild(li);
  }

  await renderStructuredPlan({ moduleId: stats.moduleId });
}

async function renderStructuredPlan({ moduleId }) {
  const list = document.getElementById("plan-structured");
  const sub = document.getElementById("plan-structured-sub");
  if (!list || !sub) return;

  const modules = await state.db.modules.getAll();
  const mod = modules.find((m) => m.id === moduleId) ?? modules[0];
  if (!mod) {
    sub.textContent = "Sin módulos.";
    list.innerHTML = "";
    return;
  }

  // Default recommendation: 25 preguntas/día, 5 días/semana, 4 semanas.
  const perDay = 25;
  const daysPerWeek = 5;
  const weeks = 4;

  const allStats = await state.db.progress.getStats({ moduleId: mod.id, now: Date.now() });
  const remaining = Math.max(0, allStats.total - allStats.learned);

  sub.textContent = `Meta: ${perDay} preguntas/día • ${daysPerWeek} días/semana • ${weeks} semanas. Pendientes en ${mod.name}: ${remaining}.`;

  list.innerHTML = "";

  // Build a simple weekly structure by difficulty stages (easy -> medium -> hard) using the topic route order.
  const route = (await state.db.progress.getTopicPlan({ moduleId: mod.id, now: Date.now() })).route;
  const topics = route.map((r) => r.topic);
  const blocks = [];
  if (topics.length) {
    const chunk = Math.max(1, Math.ceil(topics.length / weeks));
    for (let w = 0; w < weeks; w++) {
      blocks.push({ week: w + 1, topics: topics.slice(w * chunk, (w + 1) * chunk) });
    }
  } else {
    blocks.push({ week: 1, topics: ["(sin temas)"] });
  }

  for (const b of blocks) {
    const li = document.createElement("div");
    li.className = "list-item";
    const topicLine = b.topics.length ? b.topics.join(" • ") : "—";
    li.innerHTML = `
      <div>
        <div class="title">Semana ${b.week}</div>
        <div class="sub"></div>
      </div>
      <div class="meta"></div>
    `;
    li.querySelector(".sub").textContent = `Enfoque: ${topicLine}`;
    const meta = li.querySelector(".meta");
    meta.appendChild(pill(`Día: ${perDay}`, "pill subtle"));
    meta.appendChild(pill(`Total: ${perDay * daysPerWeek}`, "pill subtle"));
    list.appendChild(li);
  }
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById("boot-error");
  if (el) {
    el.hidden = false;
    el.textContent =
      "No se pudo iniciar la app. Detalle: " + (err && err.message ? err.message : String(err)) +
      ". Abre la consola (F12) y recarga con Ctrl+F5. Si sigue igual: Ajustes → Borrar todo.";
  }
  alert("Error iniciando la app. Revisa la consola (F12).");
});
