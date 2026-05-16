const LS_KEY = "icfes_local_backup_v1";

export function readLocalBackup() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeLocalBackup(data) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function clearLocalBackup() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    // ignore
  }
}

export function createDebouncedBackupWriter({ getDump, delayMs = 1200 }) {
  let timer = null;
  return function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try {
        const dump = await getDump();
        writeLocalBackup(dump);
      } catch {
        // ignore
      }
    }, delayMs);
  };
}

