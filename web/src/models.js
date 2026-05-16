/** @typedef {"easy"|"medium"|"hard"} Difficulty */

/** @typedef {{id:string,name:string,createdAt:number}} Module */

/**
 * @typedef {Object} Question
 * @property {string} id
 * @property {string} moduleId
 * @property {Difficulty} difficulty
 * @property {string|null} topic
 * @property {string} text
 * @property {string[]} choices
 * @property {number} correctIndex
 * @property {string|null} explain
 * @property {string[]} optionFeedback
 * @property {string|null} imageDataUrl
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} box
 * @property {number} seenCount
 * @property {number} correctCount
 * @property {number} wrongCount
 * @property {number|null} nextDueAt
 * @property {number|null} lastAttemptAt
 */

/**
 * @typedef {Object} Attempt
 * @property {string} id
 * @property {string} questionId
 * @property {number} at
 * @property {string} day
 * @property {number|null} selectedIndex
 * @property {boolean|null} correct
 * @property {boolean} skipped
 */

export function defaultModules() {
  const now = Date.now();
  return [
    { id: crypto.randomUUID(), name: "Matemáticas", createdAt: now },
    { id: crypto.randomUUID(), name: "Ciencias Naturales", createdAt: now },
    { id: crypto.randomUUID(), name: "Lectura Crítica", createdAt: now },
    { id: crypto.randomUUID(), name: "Sociales y Ciudadanas", createdAt: now },
    { id: crypto.randomUUID(), name: "Inglés", createdAt: now },
  ];
}

export function normalizeModuleName(name) {
  const s = String(name ?? "").trim().replace(/\s+/g, " ");
  return s.length ? s : "";
}

export function nowIso() {
  return new Date().toISOString();
}

export function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Leitner-like schedule (ms)
export function nextDueForBox(box) {
  const hours = 60 * 60 * 1000;
  const days = 24 * hours;
  const schedule = {
    1: 0, // immediate review allowed
    2: 8 * hours,
    3: 1 * days,
    4: 3 * days,
    5: 7 * days,
    6: 14 * days,
    7: 30 * days,
  };
  return schedule[box] ?? 7 * days;
}

