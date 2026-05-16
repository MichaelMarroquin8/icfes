export function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento no encontrado: ${id}`);
  return el;
}

export function setActiveTab(tab) {
  const buttons = Array.from(document.querySelectorAll(".tabbtn"));
  for (const btn of buttons) {
    const t = btn.getAttribute("data-tab");
    btn.setAttribute("aria-selected", t === tab ? "true" : "false");
  }
  const panels = Array.from(document.querySelectorAll("[data-tabpanel]"));
  for (const p of panels) {
    p.hidden = p.getAttribute("data-tabpanel") !== tab;
  }
}

export function toast(text) {
  // Minimal toast: reuse alert-style but non-blocking
  const id = "__toast";
  let t = document.getElementById(id);
  if (!t) {
    t = document.createElement("div");
    t.id = id;
    t.style.position = "fixed";
    t.style.bottom = "16px";
    t.style.left = "16px";
    t.style.right = "16px";
    t.style.maxWidth = "980px";
    t.style.margin = "0 auto";
    t.style.padding = "12px 14px";
    t.style.borderRadius = "14px";
    t.style.border = "1px solid rgba(255,255,255,.12)";
    t.style.background = "rgba(0,0,0,.55)";
    t.style.backdropFilter = "blur(10px)";
    t.style.color = "white";
    t.style.boxShadow = "0 10px 30px rgba(0,0,0,.35)";
    t.style.zIndex = "999";
    t.style.opacity = "0";
    t.style.transition = "opacity .15s ease";
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.style.opacity = "1";
  clearTimeout(t.__timer);
  t.__timer = setTimeout(() => {
    t.style.opacity = "0";
  }, 2200);
}

export function formatDateTime(ts) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return String(ts);
  }
}

export function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function renderChoiceEditor(root, choices, onChange) {
  root.innerHTML = "";
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const list = Array.isArray(choices) && choices.length >= 2 ? choices.slice() : ["", "", "", ""];

  list.forEach((text, idx) => {
    const row = document.createElement("div");
    row.className = "choice-row";
    row.innerHTML = `
      <div class="tag">${letters[idx]}</div>
      <label class="field" style="min-width:auto">
        <span>Opción ${letters[idx]}</span>
        <textarea rows="2" data-choice="${idx}" required></textarea>
      </label>
    `;
    row.querySelector("textarea").value = text ?? "";
    row.querySelector("textarea").addEventListener("input", () => onChange?.());
    root.appendChild(row);
  });

  const controls = document.createElement("div");
  controls.className = "row";
  controls.innerHTML = `
    <button type="button" id="choice-add">Agregar opción</button>
    <button type="button" id="choice-remove">Quitar última</button>
  `;
  controls.querySelector("#choice-add").addEventListener("click", () => {
    const current = Array.from(root.querySelectorAll("textarea[data-choice]")).map((t) => t.value);
    if (current.length >= 6) return toast("Máximo 6 opciones por ahora.");
    current.push("");
    renderChoiceEditor(root, current, onChange);
    onChange?.();
  });
  controls.querySelector("#choice-remove").addEventListener("click", () => {
    const current = Array.from(root.querySelectorAll("textarea[data-choice]")).map((t) => t.value);
    if (current.length <= 2) return toast("Mínimo 2 opciones.");
    current.pop();
    renderChoiceEditor(root, current, onChange);
    onChange?.();
  });
  root.appendChild(controls);
}

export function renderOptionFeedbackEditor(root, numOptions, initial = []) {
  root.innerHTML = "";
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  for (let i = 0; i < numOptions; i++) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.style.minWidth = "auto";
    wrap.innerHTML = `
      <span>Por qué ${letters[i]} está bien/mal</span>
      <textarea rows="2" data-optfb="${i}"></textarea>
    `;
    const t = wrap.querySelector("textarea");
    t.value = initial[i] ?? "";
    root.appendChild(wrap);
  }
}

