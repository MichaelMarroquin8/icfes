# Icfes • Plataforma de estudio (local)

Esta es una app web estática que guarda módulos, preguntas y progreso en tu navegador (IndexedDB) y además deja un
respaldo ligero en `localStorage` para recuperación básica.

## Cómo abrir

- Opción A (recomendado): inicia un servidor local y abre la URL.
  - En PowerShell: `py -m http.server 5173` dentro de `web/`
  - Luego abre: `http://localhost:5173`
- Opción B: abre `web/index.html` directo (puede funcionar, pero algunos navegadores limitan almacenamiento en `file://`).

## Respaldo (para que “no se pierda nunca”)

- En **Ajustes → Respaldo** usa **Exportar** y guarda el `.json` en tu PC.
- Si cambias de navegador/PC, usa **Importar** para restaurar todo.

## PDFs / Screenshots

El navegador no puede “leer una carpeta” de Windows automáticamente por seguridad.

Para usar tus PDFs o capturas:
- Ve a **Biblioteca → Importar archivos** y selecciona PDFs o imágenes.
- En **Fuentes**, puedes:
  - **Imagen → Usar**: pre-carga la captura en el editor para crear la pregunta.
  - **PDF → Abrir**: abre el PDF para copiar/pegar el enunciado.

## Importación automática (sin seleccionar archivos en el navegador)

Si tienes PDFs en tu PC, puedes generar `web/data/icfes_import.json` y luego importarlo desde la app:

- Generar JSON (desde la raíz del repo): `.\.venv\Scripts\python tools\import_icfes_pdfs.py --input-dir "C:\Users\micha\Pictures\Screenshots" --out web\data\icfes_import.json`
- En la app: **Ajustes → Importar PDFs ICFES**
