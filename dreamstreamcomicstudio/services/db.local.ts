import { Project, GenerationArtifact, ComicPanel, Character, Item, Location, StyleVariant, ProjectReport, LearnProgress, ReaderState } from "../types";
import { buildProjectReport } from "./reporting";

const DB_NAME = "dreamstream_comic_studio";
const DB_VERSION = 3;

const PROJECTS_STORE = "projects";
const IMAGES_STORE = "images";
const ARTIFACTS_STORE = "artifacts";
const TEST_RUNS_STORE = "test_runs";
const TEST_IMAGES_STORE = "test_images";
const LEARN_PROGRESS_STORE = "learn_progress";
const READER_STATE_STORE = "reader_state";

type ImageRecord = {
  id: string;
  dataUrl: string;
  mimeType: string;
  createdAt: number;
};

type ArtifactRecord = GenerationArtifact;

const imageUrlCache = new Map<string, string>();
const testImageUrlCache = new Map<string, string>();

const openDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(IMAGES_STORE)) {
        db.createObjectStore(IMAGES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(ARTIFACTS_STORE)) {
        const store = db.createObjectStore(ARTIFACTS_STORE, { keyPath: "id" });
        store.createIndex("projectId", "projectId", { unique: false });
      }
      if (!db.objectStoreNames.contains(TEST_RUNS_STORE)) {
        const store = db.createObjectStore(TEST_RUNS_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(TEST_IMAGES_STORE)) {
        db.createObjectStore(TEST_IMAGES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(LEARN_PROGRESS_STORE)) {
        db.createObjectStore(LEARN_PROGRESS_STORE, { keyPath: "moduleId" });
      }
      if (!db.objectStoreNames.contains(READER_STATE_STORE)) {
        db.createObjectStore(READER_STATE_STORE, { keyPath: "projectId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const runTransaction = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = fn(store);
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || request.error);
    tx.onabort = () => reject(tx.error || request.error);
  });
};

const parseDataUrl = (dataUrl: string) => {
  const [meta] = dataUrl.split(",");
  const mimeMatch = meta.match(/data:(.*?);base64/);
  return {
    mimeType: mimeMatch?.[1] || "image/png",
  };
};

const dataUrlToBlob = (dataUrl: string): Blob => {
  const [meta, base64] = dataUrl.split(",");
  const mimeMatch = meta.match(/data:(.*?);base64/);
  const mimeType = mimeMatch?.[1] || "image/png";
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

const sanitizeProjectForStorage = (project: Project): Project => {
  const cloned = structuredClone(project);
  const stripEntity = (entity: Character | Item | Location) => {
    delete (entity as any).imageUrl;
    delete (entity as any).referenceImageUrls;
    delete (entity as any).referenceImages;
  };
  const stripPanel = (panel: ComicPanel) => {
    delete (panel as any).imageUrl;
    delete (panel as any).imageUrlHistory;
  };
  const stripVariant = (variant: StyleVariant) => {
    delete (variant as any).imageUrl;
  };

  cloned.state.characters.forEach(stripEntity);
  cloned.state.items.forEach(stripEntity);
  cloned.state.locations.forEach(stripEntity);
  cloned.state.panels.forEach(stripPanel);
  cloned.state.styleVariants.forEach(stripVariant);
  delete (cloned.state as any).coverImageUrl;
  delete (cloned.state as any).coverTemplateImageUrl;
  return cloned;
};

export const saveProject = async (project: Project): Promise<void> => {
  await runTransaction(PROJECTS_STORE, "readwrite", (store) => store.put(sanitizeProjectForStorage(project)));
};

export const deleteProject = async (projectId: string): Promise<void> => {
  await runTransaction(PROJECTS_STORE, "readwrite", (store) => store.delete(projectId));
};

export const loadProjects = async (): Promise<Project[]> => {
  return runTransaction<Project[]>(PROJECTS_STORE, "readonly", (store) => store.getAll());
};

export const reloadProjects = async (): Promise<Project[]> => {
  return loadProjects();
};

const loadStoreAll = async <T>(storeName: string): Promise<T[]> => {
  return runTransaction<T[]>(storeName, "readonly", (store) => store.getAll());
};

export const saveLearnProgress = async (progress: LearnProgress): Promise<void> => {
  await runTransaction(LEARN_PROGRESS_STORE, "readwrite", (store) => store.put(progress));
};

export const loadLearnProgress = async (): Promise<LearnProgress[]> => {
  return loadStoreAll<LearnProgress>(LEARN_PROGRESS_STORE);
};

export const saveReaderState = async (state: ReaderState): Promise<void> => {
  await runTransaction(READER_STATE_STORE, "readwrite", (store) => store.put(state));
};

export const loadReaderState = async (projectId: string): Promise<ReaderState | undefined> => {
  return runTransaction<ReaderState | undefined>(
    READER_STATE_STORE,
    "readonly",
    (store) => store.get(projectId)
  );
};

export const clearImageCache = () => {
  if (typeof URL !== "undefined" && URL.revokeObjectURL) {
    imageUrlCache.forEach((url) => URL.revokeObjectURL(url));
    testImageUrlCache.forEach((url) => URL.revokeObjectURL(url));
  }
  imageUrlCache.clear();
  testImageUrlCache.clear();
};

export const getDbStats = async (): Promise<{
  projects: number;
  images: number;
  artifacts: number;
  testRuns?: number;
  testImages?: number;
  storage?: { usage?: number; quota?: number };
}> => {
  const db = await openDb();
  const countStore = (storeName: string) =>
    new Promise<number>((resolve) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });

  const [projects, images, artifacts, testRuns, testImages] = await Promise.all([
    countStore(PROJECTS_STORE),
    countStore(IMAGES_STORE),
    countStore(ARTIFACTS_STORE),
    countStore(TEST_RUNS_STORE),
    countStore(TEST_IMAGES_STORE)
  ]);

  let storage: { usage?: number; quota?: number } | undefined;
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      storage = { usage: estimate.usage, quota: estimate.quota };
    } catch {
      storage = undefined;
    }
  }

  return { projects, images, artifacts, testRuns, testImages, storage };
};

export const saveImage = async (dataUrl: string): Promise<string> => {
  const id = crypto.randomUUID();
  const { mimeType } = parseDataUrl(dataUrl);
  const record: ImageRecord = {
    id,
    dataUrl,
    mimeType,
    createdAt: Date.now(),
  };
  try {
    await runTransaction(IMAGES_STORE, "readwrite", (store) => store.put(record));
  } catch (e: any) {
    if (e.name === 'QuotaExceededError') {
      throw new Error("Storage full. Please clear some browser data or delete old projects.");
    }
    throw e;
  }
  return id;
};

export const saveTestImage = async (dataUrl: string): Promise<string> => {
  const id = crypto.randomUUID();
  const { mimeType } = parseDataUrl(dataUrl);
  const record: ImageRecord = {
    id,
    dataUrl,
    mimeType,
    createdAt: Date.now(),
  };
  try {
    await runTransaction(TEST_IMAGES_STORE, "readwrite", (store) => store.put(record));
  } catch (e: any) {
    if (e.name === 'QuotaExceededError') {
      throw new Error("Storage full. Please clear some browser data or delete old projects.");
    }
    throw e;
  }
  return id;
};

export const getImageDataUrl = async (imageId: string): Promise<string | undefined> => {
  const record = await runTransaction<ImageRecord | undefined>(
    IMAGES_STORE,
    "readonly",
    (store) => store.get(imageId)
  );
  return record?.dataUrl;
};

export const getTestImageDataUrl = async (imageId: string): Promise<string | undefined> => {
  const record = await runTransaction<ImageRecord | undefined>(
    TEST_IMAGES_STORE,
    "readonly",
    (store) => store.get(imageId)
  );
  return record?.dataUrl;
};

export const getImageUrl = async (imageId: string): Promise<string | undefined> => {
  if (!imageId) return undefined;
  const cached = imageUrlCache.get(imageId);
  if (cached) return cached;
  const dataUrl = await getImageDataUrl(imageId);
  if (!dataUrl) return undefined;
  const blob = dataUrlToBlob(dataUrl);
  const url = URL.createObjectURL(blob);
  imageUrlCache.set(imageId, url);
  return url;
};

export const getTestImageUrl = async (imageId: string): Promise<string | undefined> => {
  if (!imageId) return undefined;
  const cached = testImageUrlCache.get(imageId);
  if (cached) return cached;
  const dataUrl = await getTestImageDataUrl(imageId);
  if (!dataUrl) return undefined;
  const blob = dataUrlToBlob(dataUrl);
  const url = URL.createObjectURL(blob);
  testImageUrlCache.set(imageId, url);
  return url;
};

export const saveArtifact = async (artifact: ArtifactRecord): Promise<void> => {
  await runTransaction(ARTIFACTS_STORE, "readwrite", (store) => store.put(artifact));
};

export const loadArtifactsForProject = async (projectId: string): Promise<ArtifactRecord[]> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ARTIFACTS_STORE, "readonly");
    const store = tx.objectStore(ARTIFACTS_STORE);
    const index = store.index("projectId");
    const request = index.getAll(projectId);
    request.onsuccess = () => resolve(request.result as ArtifactRecord[]);
    request.onerror = () => reject(request.error);
  });
};

const addImageId = (set: Set<string>, id?: string) => {
  if (id) set.add(id);
};

const collectImageIdsFromEntities = (entities: Array<Character | Item | Location>, set: Set<string>) => {
  entities.forEach((entity) => {
    addImageId(set, entity.imageId);
    entity.referenceImageIds?.forEach((refId) => addImageId(set, refId));
  });
};

const collectImageIdsFromPanels = (panels: ComicPanel[], set: Set<string>) => {
  panels.forEach((panel) => {
    addImageId(set, panel.imageId);
    panel.imageIdHistory?.forEach((id) => addImageId(set, id));
  });
};

const collectImageIdsFromStyles = (variants: StyleVariant[], set: Set<string>) => {
  variants.forEach((variant) => {
    addImageId(set, variant.imageId);
  });
};

export const exportProject = async (
  projectId: string
): Promise<{ project?: Project; images: Record<string, string>; artifacts: ArtifactRecord[]; report?: ProjectReport }> => {
  const projects = await loadProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    return { project: undefined, images: {}, artifacts: [], report: undefined };
  }

  const artifacts = await loadArtifactsForProject(projectId);

  const imageIds = new Set<string>();
  collectImageIdsFromEntities(project.state.characters, imageIds);
  collectImageIdsFromEntities(project.state.items, imageIds);
  collectImageIdsFromEntities(project.state.locations, imageIds);
  collectImageIdsFromPanels(project.state.panels, imageIds);
  collectImageIdsFromStyles(project.state.styleVariants, imageIds);
  addImageId(imageIds, project.state.coverImageId);
  addImageId(imageIds, project.state.coverTemplateImageId);
  Object.keys(project.state.imageTags || {}).forEach((id) => addImageId(imageIds, id));
  artifacts.forEach((artifact) => {
    addImageId(imageIds, artifact.outputImageId);
    (artifact.inputImageIds || []).forEach((id) => addImageId(imageIds, id));
  });

  const images: Record<string, string> = {};
  await Promise.all(
    Array.from(imageIds).map(async (id) => {
      const dataUrl = await getImageDataUrl(id);
      if (dataUrl) images[id] = dataUrl;
    })
  );

  const report = await buildProjectReport(project, artifacts, images, project.state.pricingConfig);

  return {
    project: sanitizeProjectForStorage(project),
    images,
    artifacts,
    report
  };
};
