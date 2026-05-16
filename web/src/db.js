import { nextDueForBox, startOfTodayIso } from "./models.js";

const DB_NAME = "icfes-study-db";
const DB_VERSION = 2;

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openIdb() {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    if (!db.objectStoreNames.contains("modules")) db.createObjectStore("modules", { keyPath: "id" });

    if (!db.objectStoreNames.contains("sources")) {
      const src = db.createObjectStore("sources", { keyPath: "id" });
      src.createIndex("byType", "type", { unique: false });
      src.createIndex("byCreated", "createdAt", { unique: false });
    }

    if (!db.objectStoreNames.contains("questions")) {
      const qs = db.createObjectStore("questions", { keyPath: "id" });
      qs.createIndex("byModule", "moduleId", { unique: false });
      qs.createIndex("byDue", "nextDueAt", { unique: false });
      qs.createIndex("byUpdated", "updatedAt", { unique: false });
    }

    if (!db.objectStoreNames.contains("attempts")) {
      const at = db.createObjectStore("attempts", { keyPath: "id" });
      at.createIndex("byQuestion", "questionId", { unique: false });
      at.createIndex("byDay", "day", { unique: false });
      at.createIndex("byAt", "at", { unique: false });
    }
  };
  return promisifyRequest(req);
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function store(tx, name) {
  return tx.objectStore(name);
}

export async function openAppDb() {
  const db = await openIdb();

  const api = {
    meta: {
      async get(key) {
        const tx = db.transaction("meta", "readonly");
        return promisifyRequest(store(tx, "meta").get(key));
      },
      async put(value) {
        const tx = db.transaction("meta", "readwrite");
        store(tx, "meta").put(value);
        await txDone(tx);
      },
    },

    modules: {
      async getAll() {
        const tx = db.transaction("modules", "readonly");
        return promisifyRequest(store(tx, "modules").getAll());
      },
      async get(id) {
        const tx = db.transaction("modules", "readonly");
        return promisifyRequest(store(tx, "modules").get(id));
      },
      async put(module) {
        const tx = db.transaction("modules", "readwrite");
        store(tx, "modules").put(module);
        await txDone(tx);
      },
      async deleteCascade(moduleId) {
        const tx = db.transaction(["modules", "questions", "attempts"], "readwrite");
        store(tx, "modules").delete(moduleId);

        const qIndex = store(tx, "questions").index("byModule");
        const qIds = [];
        await new Promise((resolve, reject) => {
          const cursorReq = qIndex.openCursor(IDBKeyRange.only(moduleId));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return resolve();
            qIds.push(cursor.value.id);
            cursor.delete();
            cursor.continue();
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });

        const attemptIndex = store(tx, "attempts").index("byQuestion");
        for (const qid of qIds) {
          // delete attempts for each question
          await new Promise((resolve, reject) => {
            const cursorReq = attemptIndex.openCursor(IDBKeyRange.only(qid));
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (!cursor) return resolve();
              cursor.delete();
              cursor.continue();
            };
            cursorReq.onerror = () => reject(cursorReq.error);
          });
        }

        await txDone(tx);
      },

      async mergeDuplicatesByName() {
        const tx = db.transaction(["modules", "questions"], "readwrite");
        const ms = await promisifyRequest(store(tx, "modules").getAll());
        const byName = new Map();
        for (const m of ms) {
          const key = String(m.name ?? "").trim().toLowerCase();
          if (!key) continue;
          if (!byName.has(key)) byName.set(key, []);
          byName.get(key).push(m);
        }
        const qsStore = store(tx, "questions");
        const allQs = await promisifyRequest(qsStore.getAll());

        for (const [_, mods] of byName.entries()) {
          if (mods.length <= 1) continue;
          mods.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
          const keep = mods[0];
          const drop = mods.slice(1);
          const dropIds = new Set(drop.map((d) => d.id));
          for (const q of allQs) {
            if (dropIds.has(q.moduleId)) {
              q.moduleId = keep.id;
              q.updatedAt = Date.now();
              qsStore.put(q);
            }
          }
          for (const d of drop) store(tx, "modules").delete(d.id);
        }
        await txDone(tx);
      },
    },

    sources: {
      async addMany(sources) {
        const tx = db.transaction("sources", "readwrite");
        const st = store(tx, "sources");
        for (const s of sources) st.put(s);
        await txDone(tx);
      },
      async list({ type = null, limit = 200 } = {}) {
        const tx = db.transaction("sources", "readonly");
        const st = store(tx, "sources");
        const all = type
          ? await promisifyRequest(st.index("byType").getAll(IDBKeyRange.only(type)))
          : await promisifyRequest(st.getAll());
        all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        return all.slice(0, limit);
      },
      async get(id) {
        const tx = db.transaction("sources", "readonly");
        return promisifyRequest(store(tx, "sources").get(id));
      },
      async delete(id) {
        const tx = db.transaction("sources", "readwrite");
        store(tx, "sources").delete(id);
        await txDone(tx);
      },
      async clear() {
        const tx = db.transaction("sources", "readwrite");
        store(tx, "sources").clear();
        await txDone(tx);
      },
    },

    questions: {
      async get(id) {
        const tx = db.transaction("questions", "readonly");
        return promisifyRequest(store(tx, "questions").get(id));
      },
      async put(q) {
        const tx = db.transaction("questions", "readwrite");
        store(tx, "questions").put(q);
        await txDone(tx);
      },
      async delete(id) {
        const tx = db.transaction(["questions", "attempts"], "readwrite");
        store(tx, "questions").delete(id);
        const attemptIndex = store(tx, "attempts").index("byQuestion");
        await new Promise((resolve, reject) => {
          const cursorReq = attemptIndex.openCursor(IDBKeyRange.only(id));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return resolve();
            cursor.delete();
            cursor.continue();
          };
          cursorReq.onerror = () => reject(cursorReq.error);
        });
        await txDone(tx);
      },
      async search({ q, moduleId, limit }) {
        const tx = db.transaction("questions", "readonly");
        const all = moduleId
          ? await promisifyRequest(store(tx, "questions").index("byModule").getAll(IDBKeyRange.only(moduleId)))
          : await promisifyRequest(store(tx, "questions").getAll());
        const needle = String(q ?? "").trim().toLowerCase();
        const filtered = needle
          ? all.filter((x) => (x.text + " " + (x.topic ?? "")).toLowerCase().includes(needle))
          : all;
        filtered.sort((a, b) => b.updatedAt - a.updatedAt);
        return filtered.slice(0, limit ?? 200);
      },
      async countsByModule(moduleId) {
        const tx = db.transaction("questions", "readonly");
        const all = moduleId
          ? await promisifyRequest(store(tx, "questions").index("byModule").getAll(IDBKeyRange.only(moduleId)))
          : await promisifyRequest(store(tx, "questions").getAll());
        return { total: all.length };
      },

      async pickNext({ moduleId, mode, now, topic = null }) {
        const tx = db.transaction("questions", "readonly");
        const all = moduleId
          ? await promisifyRequest(store(tx, "questions").index("byModule").getAll(IDBKeyRange.only(moduleId)))
          : await promisifyRequest(store(tx, "questions").getAll());

        const topicNorm = topic?.trim() || null;
        const pool = topicNorm
          ? topicNorm === "Sin tema"
            ? all.filter((q) => !(q.topic ?? "").trim())
            : all.filter((q) => (q.topic ?? "").trim() === topicNorm)
          : all;

        const due = pool.filter((q) => q.nextDueAt != null && q.nextDueAt <= now);
        const fresh = pool.filter((q) => (q.seenCount ?? 0) === 0);
        const other = pool.filter((q) => (q.seenCount ?? 0) > 0 && !(q.nextDueAt != null && q.nextDueAt <= now));

        const pickRandom = (arr) => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);
        const bySourcePos = (a, b) => {
          const af = String(a.sourceFile ?? "");
          const bf = String(b.sourceFile ?? "");
          if (af !== bf) return af.localeCompare(bf);
          const ap = Number(a.sourcePos ?? 1e9);
          const bp = Number(b.sourcePos ?? 1e9);
          if (ap !== bp) return ap - bp;
          return (a.createdAt ?? 0) - (b.createdAt ?? 0);
        };
        const diffRank = (d) => (d === "easy" ? 0 : d === "medium" ? 1 : 2);
        const pickFreshProgressive = (arr) => {
          if (!arr.length) return null;
          const easy = arr.filter((q) => q.difficulty === "easy").sort(bySourcePos);
          const med = arr.filter((q) => q.difficulty === "medium").sort(bySourcePos);
          const hard = arr.filter((q) => q.difficulty === "hard").sort(bySourcePos);
          return easy[0] ?? med[0] ?? hard[0] ?? arr.sort(bySourcePos)[0];
        };
        /** Orden estricto del cuadernillo: archivo → número → dificultad. */
        const pickProgressiveLinear = (arr) => {
          if (!arr.length) return null;
          const sorted = arr.slice().sort((a, b) => {
            const c = bySourcePos(a, b);
            if (c !== 0) return c;
            return diffRank(a.difficulty) - diffRank(b.difficulty);
          });
          return sorted[0];
        };
        const pickLeastRecent = (arr) => {
          if (!arr.length) return null;
          const sorted = arr.slice().sort((a, b) => (a.lastAttemptAt ?? 0) - (b.lastAttemptAt ?? 0));
          return sorted[0];
        };
        if (mode === "review") {
          return pickLeastRecent(due) ?? pickLeastRecent(other) ?? pickFreshProgressive(fresh);
        }
        if (mode === "new") {
          return pickFreshProgressive(fresh) ?? pickLeastRecent(due) ?? pickLeastRecent(other);
        }
        if (mode === "progressive") {
          return (
            pickProgressiveLinear(fresh) ??
            pickLeastRecent(due) ??
            pickProgressiveLinear(other) ??
            pickLeastRecent(other)
          );
        }
        // mix
        const buckets = [];
        if (due.length) buckets.push({ arr: due, w: 0.55 });
        if (fresh.length) buckets.push({ arr: fresh, w: 0.30 });
        if (other.length) buckets.push({ arr: other, w: 0.15 });
        const r = Math.random();
        let acc = 0;
        const totalW = buckets.reduce((s, b) => s + b.w, 0) || 1;
        for (const b of buckets) {
          acc += b.w / totalW;
          if (r <= acc) return pickRandom(b.arr);
        }
        return pickLeastRecent(due) ?? pickFreshProgressive(fresh) ?? pickLeastRecent(other);
      },

      async listTopics(moduleId) {
        const tx = db.transaction("questions", "readonly");
        const all = moduleId
          ? await promisifyRequest(store(tx, "questions").index("byModule").getAll(IDBKeyRange.only(moduleId)))
          : await promisifyRequest(store(tx, "questions").getAll());
        const set = new Set();
        for (const q of all) {
          const t = (q.topic ?? "").trim();
          if (t) set.add(t);
        }
        return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
      },

      async applyAttemptResult(questionId, { correct, skipped, at }) {
        const tx = db.transaction("questions", "readwrite");
        const st = store(tx, "questions");
        const q = await promisifyRequest(st.get(questionId));
        if (!q) return;

        q.seenCount = (q.seenCount ?? 0) + 1;
        q.lastAttemptAt = at;

        if (skipped) {
          // leave scheduling unchanged, but if it was new set due soon
          if (!q.nextDueAt) q.nextDueAt = at + 10 * 60 * 1000;
          st.put(q);
          await txDone(tx);
          return;
        }

        if (correct === true) {
          q.correctCount = (q.correctCount ?? 0) + 1;
          q.box = Math.min(7, Math.max(1, (q.box ?? 1) + 1));
          q.nextDueAt = at + nextDueForBox(q.box);
        } else if (correct === false) {
          q.wrongCount = (q.wrongCount ?? 0) + 1;
          q.box = 1;
          q.nextDueAt = at + 30 * 60 * 1000; // soon retry
        }

        st.put(q);
        await txDone(tx);
      },

      async seedSamples() {
        const tx = db.transaction(["modules", "questions"], "readwrite");
        const modules = await promisifyRequest(store(tx, "modules").getAll());
        if (modules.length === 0) return 0;
        const modMath = modules.find((m) => m.name.toLowerCase().includes("matem")) ?? modules[0];

        const now = Date.now();
        const items = [
          {
            moduleId: modMath.id,
            difficulty: "easy",
            topic: "Proporciones",
            text: "Si 3 cuadernos cuestan $12.000, ¿cuánto cuestan 5 cuadernos al mismo precio unitario?",
            choices: ["$15.000", "$18.000", "$20.000", "$24.000"],
            correctIndex: 2,
            explain: "Precio unitario: 12.000 / 3 = 4.000. Entonces 5 * 4.000 = 20.000.",
            optionFeedback: [
              "A: 15.000 sería 3.75 cuadernos a 4.000. Falta.",
              "B: 18.000 corresponde a 4.5 cuadernos. Error de proporción.",
              "C: Esta es la correcta: 5 × 4.000 = 20.000.",
              "D: 24.000 sería 6 cuadernos. Exceso.",
            ],
          },
          {
            moduleId: modMath.id,
            difficulty: "medium",
            topic: "Álgebra",
            text: "Resuelve: 2x - 5 = 9",
            choices: ["x = 2", "x = 4", "x = 7", "x = -2"],
            correctIndex: 2,
            explain: "Suma 5 a ambos lados: 2x = 14. Divide entre 2: x = 7.",
            optionFeedback: [
              "A: Si x=2, 2x-5 = -1, no 9.",
              "B: Si x=4, 2x-5 = 3, no 9.",
              "C: Esta es la correcta: x=7.",
              "D: Si x=-2, 2x-5 = -9.",
            ],
          },
        ];

        let created = 0;
        for (const it of items) {
          const q = {
            id: crypto.randomUUID(),
            moduleId: it.moduleId,
            difficulty: it.difficulty,
            topic: it.topic,
            text: it.text,
            choices: it.choices,
            correctIndex: it.correctIndex,
            explain: it.explain,
            optionFeedback: it.optionFeedback,
            imageDataUrl: null,
            createdAt: now,
            updatedAt: now,
            box: 1,
            seenCount: 0,
            correctCount: 0,
            wrongCount: 0,
            nextDueAt: null,
            lastAttemptAt: null,
          };
          store(tx, "questions").put(q);
          created++;
        }
        await txDone(tx);
        return created;
      },

      async ensureBundled(data) {
        if (!data?.db?.questions?.length) return 0;
        const incoming = data.db.questions;
        const tx = db.transaction(["questions", "modules"], "readwrite");
        const qsStore = store(tx, "questions");
        const modStore = store(tx, "modules");
        const existing = await promisifyRequest(qsStore.getAll());

        // Los moduleId del JSON deben existir en "modules"; si no, el selector apunta a otros UUID y parece "sin preguntas".
        for (const m of data.db.modules ?? []) {
          modStore.put(m);
        }

        const legacyKey = (q) => `${q.sourceFile ?? ""}|${q.sourcePos ?? ""}|${(q.text ?? "").slice(0, 40)}`;
        const stableKey = (q) =>
          q.sourceFile != null && q.sourcePos != null ? `${q.sourceFile}|${q.sourcePos}` : null;

        const byStable = new Map();
        for (const q of existing) {
          const sk = stableKey(q);
          if (sk) byStable.set(sk, q);
        }

        const modules = await promisifyRequest(modStore.getAll());
        const byName = new Map(modules.map((m) => [String(m.name ?? "").trim().toLowerCase(), m.id]));

        let changed = 0;
        for (const q of incoming) {
          const mid = q.moduleId;
          const incomingModuleName = data.db.modules?.find?.((m) => m.id === mid)?.name;
          if (incomingModuleName) {
            const mapped = byName.get(String(incomingModuleName).trim().toLowerCase());
            if (mapped) q.moduleId = mapped;
          }

          const sk = stableKey(q);
          const prev = sk ? byStable.get(sk) : null;
          if (prev) {
            const merged = {
              ...q,
              id: prev.id,
              box: prev.box ?? 1,
              seenCount: prev.seenCount ?? 0,
              correctCount: prev.correctCount ?? 0,
              wrongCount: prev.wrongCount ?? 0,
              nextDueAt: prev.nextDueAt ?? null,
              lastAttemptAt: prev.lastAttemptAt ?? null,
              createdAt: prev.createdAt ?? q.createdAt,
              updatedAt: Date.now(),
            };
            qsStore.put(merged);
            changed++;
            continue;
          }

          if (!sk) {
            const lk = legacyKey(q);
            if (existing.some((ex) => legacyKey(ex) === lk)) continue;
          }

          qsStore.put(q);
          if (sk) byStable.set(sk, q);
          existing.push(q);
          changed++;
        }
        await txDone(tx);
        return changed;
      },
    },

    attempts: {
      async add(attempt) {
        const tx = db.transaction("attempts", "readwrite");
        store(tx, "attempts").put(attempt);
        await txDone(tx);
      },
    },

    progress: {
      async getStats({ moduleId, now }) {
        const tx = db.transaction(["modules", "questions", "attempts"], "readonly");
        const modules = await promisifyRequest(store(tx, "modules").getAll());
        const questions = moduleId
          ? await promisifyRequest(store(tx, "questions").index("byModule").getAll(IDBKeyRange.only(moduleId)))
          : await promisifyRequest(store(tx, "questions").getAll());

        const today = startOfTodayIso();
        const attemptsToday = await promisifyRequest(store(tx, "attempts").index("byDay").getAll(IDBKeyRange.only(today)));
        const attemptsTodayFiltered = moduleId
          ? attemptsToday.filter((a) => questions.some((q) => q.id === a.questionId))
          : attemptsToday;

        const todayAttempts = attemptsTodayFiltered.length;
        const todayCorrect = attemptsTodayFiltered.filter((a) => a.correct === true).length;
        const todayWrong = attemptsTodayFiltered.filter((a) => a.correct === false).length;
        const todaySkipped = attemptsTodayFiltered.filter((a) => a.skipped === true).length;

        const dueNow = questions.filter((q) => q.nextDueAt != null && q.nextDueAt <= now).length;
        const newCount = questions.filter((q) => (q.seenCount ?? 0) === 0).length;
        const learned = questions.filter((q) => (q.box ?? 1) >= 4).length;
        const total = questions.length;
        const masteryPct = total ? Math.round((learned / total) * 100) : 0;

        const byModule = [];
        for (const m of modules) {
          if (moduleId && m.id !== moduleId) continue;
          const qs = questions.filter((q) => q.moduleId === m.id);
          const totalM = qs.length;
          const newM = qs.filter((q) => (q.seenCount ?? 0) === 0).length;
          const dueM = qs.filter((q) => q.nextDueAt != null && q.nextDueAt <= now).length;
          const learnedM = qs.filter((q) => (q.box ?? 1) >= 4).length;
          const masteryM = totalM ? Math.round((learnedM / totalM) * 100) : 0;
          byModule.push({ moduleId: m.id, moduleName: m.name, total: totalM, newCount: newM, dueNow: dueM, masteryPct: masteryM });
        }
        byModule.sort((a, b) => b.total - a.total);

        return {
          todayAttempts,
          todayCorrect,
          todayWrong,
          todaySkipped,
          dueNow,
          newCount,
          learned,
          total,
          masteryPct,
          byModule,
        };
      },

      async getTopicPlan({ moduleId, now }) {
        const tx = db.transaction(["modules", "questions"], "readonly");
        const modules = await promisifyRequest(store(tx, "modules").getAll());
        const effectiveModuleId = moduleId || modules[0]?.id || null;
        if (!effectiveModuleId) return { moduleId: null, nextTopic: null, route: [] };

        const questions = await promisifyRequest(
          store(tx, "questions").index("byModule").getAll(IDBKeyRange.only(effectiveModuleId))
        );

        const byTopic = new Map();
        for (const q of questions) {
          const t = (q.topic ?? "").trim() || "Sin tema";
          if (!byTopic.has(t)) byTopic.set(t, []);
          byTopic.get(t).push(q);
        }

        const route = [];
        for (const [topic, qs] of byTopic.entries()) {
          const total = qs.length;
          const dueNow = qs.filter((q) => q.nextDueAt != null && q.nextDueAt <= now).length;
          const newCount = qs.filter((q) => (q.seenCount ?? 0) === 0).length;
          const learned = qs.filter((q) => (q.box ?? 1) >= 4).length;
          const masteryPct = total ? Math.round((learned / total) * 100) : 0;
          route.push({ topic, total, dueNow, newCount, masteryPct });
        }

        // "Debil primero": low mastery, then more due/new to get momentum.
        route.sort((a, b) => {
          if (a.topic === "Sin tema" && b.topic !== "Sin tema") return 1;
          if (b.topic === "Sin tema" && a.topic !== "Sin tema") return -1;
          if (a.masteryPct !== b.masteryPct) return a.masteryPct - b.masteryPct;
          if (a.dueNow !== b.dueNow) return b.dueNow - a.dueNow;
          if (a.newCount !== b.newCount) return b.newCount - a.newCount;
          return b.total - a.total;
        });

        const nextTopic = route.find((r) => r.topic !== "Sin tema")?.topic ?? route[0]?.topic ?? null;
        return { moduleId: effectiveModuleId, nextTopic, route };
      },
    },

    async exportAll() {
      const tx = db.transaction(["meta", "modules", "sources", "questions", "attempts"], "readonly");
      const meta = await promisifyRequest(store(tx, "meta").getAll());
      const modules = await promisifyRequest(store(tx, "modules").getAll());
      const sources = await promisifyRequest(store(tx, "sources").getAll());
      const questions = await promisifyRequest(store(tx, "questions").getAll());
      const attempts = await promisifyRequest(store(tx, "attempts").getAll());
      return { exportedAt: Date.now(), db: { meta, modules, sources, questions, attempts } };
    },

    async exportLite() {
      // A smaller snapshot intended for localStorage fallback.
      const tx = db.transaction(["meta", "modules", "questions", "attempts"], "readonly");
      const meta = await promisifyRequest(store(tx, "meta").getAll());
      const modules = await promisifyRequest(store(tx, "modules").getAll());
      const questions = await promisifyRequest(store(tx, "questions").getAll());
      const attemptsAll = await promisifyRequest(store(tx, "attempts").getAll());
      // keep last N attempts only (size control)
      attemptsAll.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      const attempts = attemptsAll.slice(0, 300);
      return { exportedAt: Date.now(), lite: true, db: { meta, modules, questions, attempts } };
    },

    async importAll(data) {
      if (!data?.db) throw new Error("Archivo inválido.");
      const tx = db.transaction(["meta", "modules", "sources", "questions", "attempts"], "readwrite");
      for (const row of data.db.meta ?? []) store(tx, "meta").put(row);
      for (const row of data.db.modules ?? []) store(tx, "modules").put(row);
      for (const row of data.db.sources ?? []) store(tx, "sources").put(row);
      for (const row of data.db.questions ?? []) store(tx, "questions").put(row);
      for (const row of data.db.attempts ?? []) store(tx, "attempts").put(row);
      await txDone(tx);
    },

    async reset() {
      db.close();
      await new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("No se pudo borrar (DB bloqueada). Cierra otras pestañas abiertas."));
      });
    },
  };

  return api;
}
