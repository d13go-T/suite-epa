/**
 * epa-projects.js (v2.2)
 * Gestor unificado de proyectos para la Suite EPA (Epanimeitor, Estopmouyon, Epanimeitor Pro).
 * - Persistencia automática en IndexedDB por aplicación (funciona 100% offline).
 * - Recuerda la ubicación del último archivo guardado en PC (FileSystemFileHandle en IndexedDB).
 * - Evita duplicados al reabrir el mismo archivo .epa / .estop desde disco.
 * - Métodos directos para barra superior: newProject(), openModal(), save(), saveAs().
 */
(function (global) {
  'use strict';

  const DB_NAME = 'epa_suite_projects_v1';
  const DB_VERSION = 2;
  const STORE_META = 'projects_meta';
  const STORE_DATA = 'projects_data';
  const STORE_HANDLES = 'project_handles';
  const DEFAULT_PROJECT_NAME = 'Animacion sin titulo';

  function openSuiteDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          const metaStore = db.createObjectStore(STORE_META, { keyPath: 'id' });
          metaStore.createIndex('appId', 'appId', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_DATA)) {
          db.createObjectStore(STORE_DATA, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_HANDLES)) {
          db.createObjectStore(STORE_HANDLES, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function sanitizeFilename(name) {
    const clean = (name || DEFAULT_PROJECT_NAME)
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\.(epa|estop|epapro|json)$/i, '')
      .trim();
    return clean || DEFAULT_PROJECT_NAME;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      if (!blob) return resolve('');
      if (typeof blob === 'string') return resolve(blob);
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function dataUrlToBlob(dataUrl) {
    if (!dataUrl) return null;
    if (dataUrl instanceof Blob) return dataUrl;
    const res = await fetch(dataUrl);
    return await res.blob();
  }

  class EpaProjectManager {
    constructor(config) {
      this.appId = config.appId;
      this.extension = (config.extension || 'epa').replace(/^\./, '');
      this.appTitle = config.appTitle || 'Suite EPA';
      this.getProjectState = config.getProjectState;
      this.applyProjectState = config.applyProjectState;
      this.createNewState = config.createNewState;
      this.serializeFile = config.serializeFile || null;
      this.deserializeFile = config.deserializeFile || null;
      this.onToast = config.onToast || ((msg) => console.log('[EPA Projects]', msg));
      this.onStateChange = config.onStateChange || (() => {});

      this.db = null;
      this.currentProjectId = null;
      this.currentProjectName = DEFAULT_PROJECT_NAME;
      this.fileHandle = null;
      this.hasSavedToFile = false;
      this.isDirty = false;
      this._saveTimer = null;
      this._modalEl = null;
      this._fileInputEl = null;
    }

    get lastIdStorageKey() {
      return `epa_last_project_${this.appId}`;
    }

    _notifyChange() {
      this.onStateChange({
        id: this.currentProjectId,
        name: this.currentProjectName,
        isDirty: this.isDirty,
        hasSavedToFile: this.hasSavedToFile,
        fileName: this.fileHandle?.name || null,
      });
    }

    async init() {
      this.db = await openSuiteDb();
      this._injectModal();

      const lastId = localStorage.getItem(this.lastIdStorageKey);
      if (lastId) {
        const loaded = await this.openFromDb(lastId, { silent: true });
        if (loaded) return loaded;
      }

      const existing = await this.listProjects();
      if (existing.length > 0) {
        const loaded = await this.openFromDb(existing[0].id, { silent: true });
        if (loaded) return loaded;
      }

      await this.startNewProject(DEFAULT_PROJECT_NAME, { silent: true });
      return true;
    }

    _generateId() {
      return `${this.appId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    }

    async _storeFileHandle(projectId, handle) {
      if (!this.db || !projectId) return;
      try {
        await new Promise((resolve) => {
          const tx = this.db.transaction([STORE_HANDLES], 'readwrite');
          if (handle) {
            tx.objectStore(STORE_HANDLES).put({ id: projectId, handle });
          } else {
            tx.objectStore(STORE_HANDLES).delete(projectId);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch (_) {}
    }

    async _loadFileHandle(projectId) {
      if (!this.db || !projectId) return null;
      try {
        return await new Promise((resolve) => {
          const tx = this.db.transaction([STORE_HANDLES], 'readonly');
          const req = tx.objectStore(STORE_HANDLES).get(projectId);
          req.onsuccess = () => resolve(req.result?.handle || null);
          req.onerror = () => resolve(null);
        });
      } catch (_) {
        return null;
      }
    }

    async _findExistingProjectIdForFile(file, handle, rawObj) {
      const existingProjects = await this.listProjects();
      if (existingProjects.length === 0) return null;

      // 1. Si hay FileSystemFileHandle, comparar por isSameEntry (ubicación exacta en disco)
      if (handle && typeof handle.isSameEntry === 'function') {
        for (const proj of existingProjects) {
          const storedHandle = await this._loadFileHandle(proj.id);
          if (storedHandle && typeof storedHandle.isSameEntry === 'function') {
            try {
              if (await storedHandle.isSameEntry(handle)) {
                return proj.id;
              }
            } catch (_) {}
          }
        }
      }

      // 2. Si el archivo incluye el projectId interno de la Suite EPA
      const embeddedId = rawObj?.projectId || rawObj?.id;
      if (embeddedId && existingProjects.some((p) => p.id === embeddedId)) {
        return embeddedId;
      }

      // 3. Coincidencia por nombre exacto de archivo en esta misma app
      if (file?.name) {
        const byFileName = existingProjects.find(
          (p) => p.fileName && p.fileName.toLowerCase() === file.name.toLowerCase()
        );
        if (byFileName) return byFileName.id;
      }

      return null;
    }

    _injectModal() {
      if (document.getElementById('epaProjectsModal')) {
        this._modalEl = document.getElementById('epaProjectsModal');
        this._fileInputEl = document.getElementById('epaProjectFileInput');
        return;
      }

      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.id = 'epaProjectsModal';
      backdrop.style.display = 'none';

      backdrop.innerHTML = `
        <div class="modal" style="width: min(560px, 94vw);">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding-bottom:10px; margin-bottom:14px; border-bottom:1px solid var(--border);">
            <h2 style="margin:0; padding:0; border:none;">Abrir proyecto · ${this.appTitle}</h2>
            <button type="button" class="btn btn-sm btn-ghost" id="epaProjCloseTop" aria-label="Cerrar" style="font-size:18px; line-height:1;">×</button>
          </div>

          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px;">
            <button type="button" class="btn btn-primary" id="epaProjBrowseBtn" style="flex:1; min-width:190px; justify-content:center;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
              <span>Buscar archivo (.${this.extension}) en equipo</span>
            </button>
            <button type="button" class="btn" id="epaProjNewFromModalBtn" style="justify-content:center;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span>Nuevo proyecto</span>
            </button>
          </div>

          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
            <span style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted);">
              Últimos proyectos guardados en este dispositivo
            </span>
            <span style="font-size:11px; color:var(--muted);" id="epaProjCountLabel"></span>
          </div>

          <div id="projectsList" style="max-height: 48vh; overflow-y: auto; padding-right: 2px;"></div>

          <div class="modal-actions">
            <button type="button" class="btn" id="epaProjCloseBtn">Cerrar</button>
          </div>
        </div>
      `;

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.id = 'epaProjectFileInput';
      fileInput.className = 'hidden-input';
      fileInput.accept = `.${this.extension},.json,application/json`;

      document.body.appendChild(backdrop);
      document.body.appendChild(fileInput);

      this._modalEl = backdrop;
      this._fileInputEl = fileInput;

      const close = () => this.closeModal();
      backdrop.querySelector('#epaProjCloseTop').addEventListener('click', close);
      backdrop.querySelector('#epaProjCloseBtn').addEventListener('click', close);
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
      });

      backdrop.querySelector('#epaProjBrowseBtn').addEventListener('click', () => {
        this.browseFileFromDisk();
      });

      backdrop.querySelector('#epaProjNewFromModalBtn').addEventListener('click', async () => {
        this.closeModal();
        await this.newProject();
      });

      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
          await this.importFromFile(file, null);
        }
        e.target.value = '';
      });
    }

    async openModal() {
      await this.saveNow();
      await this.renderProjectsGrid();
      this._modalEl.style.display = 'flex';
    }

    closeModal() {
      if (this._modalEl) {
        this._modalEl.style.display = 'none';
      }
    }

    async browseFileFromDisk() {
      if (typeof window.showOpenFilePicker === 'function') {
        try {
          const [handle] = await window.showOpenFilePicker({
            multiple: false,
            types: [
              {
                description: `Proyecto ${this.appTitle} (.${this.extension})`,
                accept: { 'application/octet-stream': [`.${this.extension}`, '.json'] },
              },
            ],
          });
          if (!handle) return false;
          const file = await handle.getFile();
          return await this.importFromFile(file, handle);
        } catch (err) {
          if (err && err.name === 'AbortError') return false;
        }
      }
      this._fileInputEl.click();
      return true;
    }

    scheduleAutoSave() {
      this.isDirty = true;
      this._notifyChange();
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => {
        this.saveNow().catch((err) => console.warn('Autoguardado IndexedDB:', err));
      }, 450);
    }

    async saveNow(overrideName = null, overrideFileName = null) {
      if (!this.db) return null;
      const snapshot = await this.getProjectState();
      if (!this.currentProjectId) {
        this.currentProjectId = snapshot.id || this._generateId();
      }
      const chosenName = overrideName || this.currentProjectName || snapshot.name || DEFAULT_PROJECT_NAME;
      const name = chosenName.trim() || DEFAULT_PROJECT_NAME;
      this.currentProjectName = name;

      let thumbUrlOrData = snapshot.thumb || '';
      if (thumbUrlOrData instanceof Blob) {
        thumbUrlOrData = await blobToDataUrl(thumbUrlOrData);
      }

      const now = Date.now();
      const existingMeta = await this._getMeta(this.currentProjectId);

      const meta = {
        id: this.currentProjectId,
        appId: this.appId,
        name,
        frameCount: snapshot.frameCount ?? 0,
        thumb: thumbUrlOrData,
        fileName: overrideFileName || this.fileHandle?.name || existingMeta?.fileName || null,
        createdAt: existingMeta?.createdAt || now,
        modifiedAt: now,
      };

      const dataRecord = {
        id: this.currentProjectId,
        appId: this.appId,
        payload: snapshot.payload,
      };

      await new Promise((resolve, reject) => {
        const tx = this.db.transaction([STORE_META, STORE_DATA], 'readwrite');
        tx.objectStore(STORE_META).put(meta);
        tx.objectStore(STORE_DATA).put(dataRecord);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      localStorage.setItem(this.lastIdStorageKey, this.currentProjectId);
      return meta;
    }

    _getMeta(id) {
      return new Promise((resolve) => {
        const tx = this.db.transaction([STORE_META], 'readonly');
        const req = tx.objectStore(STORE_META).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    }

    _getData(id) {
      return new Promise((resolve) => {
        const tx = this.db.transaction([STORE_DATA], 'readonly');
        const req = tx.objectStore(STORE_DATA).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    }

    async listProjects() {
      if (!this.db) return [];
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction([STORE_META], 'readonly');
        const idx = tx.objectStore(STORE_META).index('appId');
        const req = idx.getAll(IDBKeyRange.only(this.appId));
        req.onsuccess = () => {
          const items = req.result || [];
          items.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
          resolve(items);
        };
        req.onerror = () => reject(req.error);
      });
    }

    async openFromDb(id, options = {}) {
      const meta = await this._getMeta(id);
      const dataRec = await this._getData(id);
      if (!meta || !dataRec) return false;

      this.currentProjectId = meta.id;
      this.currentProjectName = meta.name || DEFAULT_PROJECT_NAME;
      this.fileHandle = await this._loadFileHandle(id);
      this.hasSavedToFile = Boolean(this.fileHandle || meta.fileName);
      this.isDirty = false;

      await this.applyProjectState(meta, dataRec.payload);

      meta.modifiedAt = Date.now();
      await new Promise((resolve) => {
        const tx = this.db.transaction([STORE_META], 'readwrite');
        tx.objectStore(STORE_META).put(meta);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });

      localStorage.setItem(this.lastIdStorageKey, this.currentProjectId);
      this._notifyChange();

      if (!options.silent) {
        this.onToast(`Proyecto abierto: ${this.currentProjectName}`);
      }
      return true;
    }

    async deleteFromDb(id) {
      await this._storeFileHandle(id, null);
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction([STORE_META, STORE_DATA], 'readwrite');
        tx.objectStore(STORE_META).delete(id);
        tx.objectStore(STORE_DATA).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      if (id === this.currentProjectId) {
        const remaining = await this.listProjects();
        if (remaining.length > 0) {
          await this.openFromDb(remaining[0].id, { silent: true });
        } else {
          await this.startNewProject(DEFAULT_PROJECT_NAME, { silent: true });
        }
      }
    }

    async newProject() {
      if (this.isDirty) {
        const ok = confirm('¿Empezar un proyecto nuevo? Los cambios sin guardar en archivo quedarán solo en el historial local.');
        if (!ok) return false;
      }
      await this.startNewProject(DEFAULT_PROJECT_NAME);
      return true;
    }

    async startNewProject(name = DEFAULT_PROJECT_NAME, options = {}) {
      const finalName = (name || DEFAULT_PROJECT_NAME).trim() || DEFAULT_PROJECT_NAME;
      this.currentProjectId = this._generateId();
      this.currentProjectName = finalName;
      this.fileHandle = null;
      this.hasSavedToFile = false;
      this.isDirty = false;

      await this.createNewState(finalName, this.currentProjectId);
      await this.saveNow(finalName);
      this._notifyChange();

      if (!options.silent) {
        this.onToast(`Nuevo proyecto: ${finalName}`);
      }
    }

    async _buildExportBlob(overrideName = null, overrideFileName = null) {
      const meta = await this.saveNow(overrideName, overrideFileName);
      const snapshot = await this.getProjectState();

      let fileContent;
      if (this.serializeFile) {
        fileContent = await this.serializeFile(meta, snapshot.payload);
      } else {
        fileContent = JSON.stringify({
          suite: 'EPA',
          appId: this.appId,
          projectId: this.currentProjectId,
          version: 1,
          name: this.currentProjectName,
          savedAt: new Date().toISOString(),
          payload: snapshot.payload,
        }, null, 2);
      }

      return fileContent instanceof Blob
        ? fileContent
        : new Blob([fileContent], { type: 'application/octet-stream' });
    }

    async _writeToHandle(handle, blob) {
      if (typeof handle.queryPermission === 'function') {
        let perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted' && typeof handle.requestPermission === 'function') {
          perm = await handle.requestPermission({ mode: 'readwrite' });
        }
        if (perm !== 'granted') return false;
      }
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    }

    async save() {
      if (this.fileHandle) {
        try {
          const blob = await this._buildExportBlob(this.currentProjectName, this.fileHandle.name);
          const written = await this._writeToHandle(this.fileHandle, blob);
          if (written) {
            this.hasSavedToFile = true;
            this.isDirty = false;
            await this.saveNow(this.currentProjectName, this.fileHandle.name);
            this._notifyChange();
            this.onToast(`Guardado: ${this.fileHandle.name}`);
            return true;
          }
        } catch (err) {
          console.warn('No se pudo sobrescribir el archivo anterior, abriendo Guardar como:', err);
          this.fileHandle = null;
        }
      }

      if (!this.hasSavedToFile) {
        return await this.saveAs();
      }

      const fileName = `${sanitizeFilename(this.currentProjectName)}.${this.extension}`;
      const blob = await this._buildExportBlob(this.currentProjectName, fileName);
      this._triggerBrowserDownload(blob, fileName);
      this.isDirty = false;
      await this.saveNow(this.currentProjectName, fileName);
      this._notifyChange();
      this.onToast(`Guardado: ${fileName}`);
      return true;
    }

    async saveAs() {
      const baseDefault = sanitizeFilename(this.currentProjectName || DEFAULT_PROJECT_NAME);

      if (typeof window.showSaveFilePicker === 'function') {
        try {
          const suggestedName = `${baseDefault}.${this.extension}`;
          const handle = await window.showSaveFilePicker({
            suggestedName,
            types: [
              {
                description: `Proyecto ${this.appTitle} (.${this.extension})`,
                accept: { 'application/octet-stream': [`.${this.extension}`] },
              },
            ],
          });

          const savedFileName = handle.name || suggestedName;
          this.currentProjectName = sanitizeFilename(savedFileName);
          this.fileHandle = handle;
          this._notifyChange();

          const blob = await this._buildExportBlob(this.currentProjectName, savedFileName);
          await this._writeToHandle(handle, blob);

          this.hasSavedToFile = true;
          this.isDirty = false;
          await this._storeFileHandle(this.currentProjectId, handle);
          await this.saveNow(this.currentProjectName, savedFileName);
          this._notifyChange();

          this.onToast(`Proyecto guardado: ${savedFileName}`);
          return true;
        } catch (err) {
          if (err && err.name === 'AbortError') return false;
          console.warn('Fallback a descarga estándar:', err);
        }
      }

      const typed = prompt('Nombre del proyecto:', baseDefault);
      if (typed === null) return false;

      this.currentProjectName = sanitizeFilename(typed);
      const fileName = `${this.currentProjectName}.${this.extension}`;
      this._notifyChange();

      const blob = await this._buildExportBlob(this.currentProjectName, fileName);
      this._triggerBrowserDownload(blob, fileName);

      this.hasSavedToFile = true;
      this.isDirty = false;
      await this.saveNow(this.currentProjectName, fileName);
      this._notifyChange();
      this.onToast(`Proyecto guardado: ${fileName}`);
      return true;
    }

    _triggerBrowserDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    async importFromFile(file, handle = null) {
      try {
        const text = await file.text();
        const rawObj = JSON.parse(text);
        const fileBaseName = sanitizeFilename(file.name);

        let parsed;
        if (this.deserializeFile) {
          parsed = await this.deserializeFile(rawObj, fileBaseName);
        } else {
          const payload = rawObj.payload || rawObj;
          parsed = {
            name: rawObj.name || fileBaseName || DEFAULT_PROJECT_NAME,
            payload,
          };
        }

        // Reutilizar el ID existente si el mismo archivo ya estaba en IndexedDB
        const matchedId = await this._findExistingProjectIdForFile(file, handle, rawObj);
        this.currentProjectId = matchedId || this._generateId();
        this.currentProjectName = (fileBaseName || parsed.name || DEFAULT_PROJECT_NAME).trim() || DEFAULT_PROJECT_NAME;
        this.fileHandle = handle || null;
        this.hasSavedToFile = true;
        this.isDirty = false;

        await this.applyProjectState(
          { id: this.currentProjectId, name: this.currentProjectName },
          parsed.payload
        );
        if (this.fileHandle) {
          await this._storeFileHandle(this.currentProjectId, this.fileHandle);
        }
        await this.saveNow(this.currentProjectName, file.name);
        this._notifyChange();
        this.closeModal();
        this.onToast(`Proyecto "${this.currentProjectName}" abierto`);
        return true;
      } catch (err) {
        alert('No se pudo abrir el archivo: ' + err.message);
        return false;
      }
    }

    async renderProjectsGrid() {
      if (!this._modalEl) return;
      const container = this._modalEl.querySelector('#projectsList');
      const countLabel = this._modalEl.querySelector('#epaProjCountLabel');
      const projects = await this.listProjects();

      if (countLabel) {
        countLabel.textContent = projects.length === 1 ? '1 proyecto' : `${projects.length} proyectos`;
      }

      container.innerHTML = '';
      if (projects.length === 0) {
        container.innerHTML = `
          <div style="color:var(--muted); font-size:13px; text-align:center; padding:24px; grid-column:1/-1;">
            No hay proyectos recientes en este dispositivo
          </div>`;
        return;
      }

      for (const p of projects) {
        const isCurrent = p.id === this.currentProjectId;
        const card = document.createElement('div');
        card.className = 'project-card';
        if (isCurrent) {
          card.style.borderColor = 'var(--accent)';
        }

        const thumbHtml = p.thumb
          ? `<img src="${p.thumb}" alt="">`
          : `<span style="font-size:11px;">Sin vista previa</span>`;

        const safeNameEl = document.createElement('div');
        safeNameEl.textContent = p.name || DEFAULT_PROJECT_NAME;

        const dateStr = p.modifiedAt ? new Date(p.modifiedAt).toLocaleDateString() : '';
        const framesText = `${p.frameCount || 0} ${p.frameCount === 1 ? 'cuadro' : 'cuadros'}`;
        const fileBadge = p.fileName
          ? `<div style="font-size:10px; color:var(--accent); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px;" title="${p.fileName}">📄 ${p.fileName}</div>`
          : '';

        card.innerHTML = `
          <div class="thumb-area" style="position:relative;">
            ${thumbHtml}
            ${isCurrent ? '<span style="position:absolute; top:5px; left:5px; background:var(--accent); color:#fff; font-size:9px; font-weight:700; padding:2px 6px; border-radius:999px;">ACTUAL</span>' : ''}
          </div>
          <div class="info">
            <div class="name" title="${safeNameEl.innerHTML}">${safeNameEl.innerHTML}</div>
            <div class="meta">${dateStr} · ${framesText}</div>
            ${fileBadge}
          </div>
          <div class="actions">
            <button type="button" data-act="open">${isCurrent ? 'Abierto' : 'Abrir'}</button>
            <button type="button" data-act="del" style="color:#dc2626;">Borrar</button>
          </div>
        `;

        card.querySelector('[data-act="open"]').addEventListener('click', async () => {
          if (!isCurrent) {
            await this.openFromDb(p.id);
          }
          this.closeModal();
        });

        card.querySelector('[data-act="del"]').addEventListener('click', async () => {
          if (confirm(`¿Eliminar "${p.name || DEFAULT_PROJECT_NAME}" de este dispositivo?`)) {
            await this.deleteFromDb(p.id);
            await this.renderProjectsGrid();
            this.onToast('Proyecto eliminado');
          }
        });

        container.appendChild(card);
      }
    }
  }

  global.EpaProjectManager = EpaProjectManager;
  global.EpaProjectUtils = {
    DEFAULT_PROJECT_NAME,
    sanitizeFilename,
    blobToDataUrl,
    dataUrlToBlob,
  };
})(window);