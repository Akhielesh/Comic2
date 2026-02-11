import { Project, GenerationArtifact, ComicPanel, Character, Item, Location, StyleVariant, ProjectReport, TestLabRun, LearnProgress, ReaderState, UserProfile, Comment, Follow, AppNotification, Review } from "../types";
import { buildProjectReport } from "./reporting";
import { supabase } from "./supabase";

// --- Local Storage (IndexedDB) for Ephemeral Data (Tests, Learning, UI State) ---
const DB_NAME = "dreamstream_local_cache"; // Renamed to avoid confusion, though we can keep same name if we migrated data.
const DB_VERSION = 3;

const TEST_RUNS_STORE = "test_runs";
const TEST_IMAGES_STORE = "test_images";
const LEARN_PROGRESS_STORE = "learn_progress";
const READER_STATE_STORE = "reader_state";

// (Keeping IndexedDB logic for these specific stores)
const openDb = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
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
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || request.error);
  });
};

const loadStoreAll = async <T>(storeName: string): Promise<T[]> => {
  return runTransaction<T[]>(storeName, "readonly", (store) => store.getAll());
};

// --- Helper Utils ---

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

const parseDataUrl = (dataUrl: string) => {
  const [meta] = dataUrl.split(",");
  const mimeMatch = meta.match(/data:(.*?);base64/);
  return { mimeType: mimeMatch?.[1] || "image/png" };
};


// --- CLOUD STORAGE (Supabase) for Projects, Images, Artifacts ---

// 1. Projects
// --- Local Storage Key ---
const LOCAL_STORAGE_PROJECTS_KEY = 'dreamstream_projects';

// 1. Projects
export const saveProject = async (project: Project): Promise<void> => {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Guest Mode: Save to LocalStorage
    try {
      const existing = localStorage.getItem(LOCAL_STORAGE_PROJECTS_KEY);
      const projects: Project[] = existing ? JSON.parse(existing) : [];
      const index = projects.findIndex(p => p.id === project.id);
      if (index >= 0) {
        projects[index] = project;
      } else {
        projects.unshift(project);
      }
      localStorage.setItem(LOCAL_STORAGE_PROJECTS_KEY, JSON.stringify(projects));
      return;
    } catch (e) {
      console.error("Failed to save to localStorage", e);
      throw new Error("Failed to save project locally.");
    }
  }

  // Logged In: Save to Supabase
  // We split the "Project" object: High-level metadata goes to columns, State goes to JSONB
  const { id, name, coverImage, state, createdAt, updatedAt, isPublic } = project;

  const { error } = await supabase.from('projects').upsert({
    id,
    user_id: user.id,
    name,
    cover_image_url: coverImage,
    is_public: !!isPublic,
    state: state, // JSONB
    updated_at: new Date(updatedAt).toISOString(),
    created_at: new Date(createdAt).toISOString()
  });

  if (error) throw error;
};

export const deleteProject = async (projectId: string): Promise<void> => {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Guest Mode: Delete from LocalStorage
    const existing = localStorage.getItem(LOCAL_STORAGE_PROJECTS_KEY);
    if (existing) {
      const projects: Project[] = JSON.parse(existing);
      const filtered = projects.filter(p => p.id !== projectId);
      localStorage.setItem(LOCAL_STORAGE_PROJECTS_KEY, JSON.stringify(filtered));
    }
    return;
  }

  const { error } = await supabase.from('projects').delete().eq('id', projectId);
  if (error) throw error;
};

export const loadProjects = async (): Promise<Project[]> => {
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Guest Mode: Load from LocalStorage
    const existing = localStorage.getItem(LOCAL_STORAGE_PROJECTS_KEY);
    return existing ? JSON.parse(existing) : [];
  }

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('updated_at', { ascending: false });

  if (error) throw error;

  // Map DB representation back to Application Type
  return (data || []).map((row: any) => ({
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    coverImage: row.cover_image_url,
    state: row.state,
    isPublic: row.is_public
  }));
};

export const reloadProjects = async (): Promise<Project[]> => {
  return loadProjects();
};

export const getPublicProject = async (projectId: string): Promise<Project | null> => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('is_public', true) // Security check
    .single();

  if (error || !data) return null;

  return {
    id: data.id,
    name: data.name,
    createdAt: new Date(data.created_at).getTime(),
    updatedAt: new Date(data.updated_at).getTime(),
    coverImage: data.cover_image_url,
    state: data.state,
    isPublic: data.is_public
  };
};

export type PlanTier = 'free' | 'pro' | 'admin';

export interface UsageLimits {
  images_generated_count: number;
  max_images_allowed: number;
  has_byok: boolean;
  is_premium: boolean; // Computed or legacy
  plan_tier: PlanTier;
}

export const generateCoupon = async (): Promise<string | null> => {
  const code = Math.random().toString(36).substring(2, 10).toUpperCase();
  const { error } = await supabase.from('coupons').insert({ code });
  if (error) {
    console.error("Failed to generate coupon:", error);
    return null;
  }
  return code;
};

export const redeemCoupon = async (code: string): Promise<{ success: boolean; message: string }> => {
  const { data, error } = await supabase.rpc('redeem_coupon', { coupon_code: code });
  if (error) {
    console.error("Redemption failed:", error);
    return { success: false, message: "Invalid or expired code." }; // RPC error usually means constraint/logic failed
  }
  if (!data) {
    return { success: false, message: "Invalid or expired code." };
  }
  return { success: true, message: "Coupon redeemed! Welcome to Pro." };
};

export const loadCoupons = async (): Promise<any[]> => {
  const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false });
  if (error) return [];
  return data;
};

export const incrementViewCount = async (projectId: string) => {
  await supabase.rpc('increment_project_view', { p_id: projectId });
};

export const incrementLikeCount = async (projectId: string) => {
  await supabase.rpc('increment_project_like', { p_id: projectId });
};

// 2. Images (Cloud Storage)

const BUCKET_NAME = 'comic-assets';

export const saveImage = async (dataUrl: string): Promise<string> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("User not logged in");

  const id = crypto.randomUUID();
  const blob = dataUrlToBlob(dataUrl);
  const ext = blob.type.split('/')[1] || 'png';
  const filePath = `${user.id}/${id}.${ext}`;

  console.log('[DB] saveImage uploading to:', filePath);
  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(filePath, blob, {
      upsert: true,
      contentType: blob.type
    });

  if (error) {
    console.error('[DB] saveImage error:', error);
    // If bucket doesn't exist, this fails.
    if (error.message.includes("Bucket not found")) {
      throw new Error("Storage bucket 'comic-assets' not found. Please create it in Supabase Dashboard.");
    }
    throw error;
  }

  // Return the FULL path so getPublicUrl works
  return filePath;
};

export const getImageUrl = async (imageId: string): Promise<string | undefined> => {
  if (!imageId) return undefined;

  // FIX: Old images were saved with IDs missing extensions (e.g. "path/to/uuid")
  // but stored as "path/to/uuid.png".
  // If ID has no extension, assume .png to recover them.
  let finalPath = imageId;
  const filename = imageId.split('/').pop();
  if (filename && !filename.includes('.')) {
    finalPath = `${imageId}.png`;
  }

  // Check memory cache first (optional, but good for perf)
  const { data } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(finalPath);

  return data.publicUrl;
};

export const getImageDataUrl = async (imageId: string): Promise<string | undefined> => {
  if (!imageId) return undefined;

  // 1. Try Test Images Store first (Local Blob)
  const testRecord = await runTransaction<any>(TEST_IMAGES_STORE, "readonly", (store) => store.get(imageId));
  if (testRecord && testRecord.dataUrl) {
    return testRecord.dataUrl;
  }

  // 2. Try Supabase Storage (Cloud)
  // Logic: Fetch the blob from the public URL and convert to Base64
  const url = await getImageUrl(imageId);
  if (!url) return undefined;

  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn("Failed to fetch image data for gemini", e);
    return undefined;
  }
};

export const getTestImageDataUrl = getImageDataUrl;

// 3. Artifacts

export const saveArtifact = async (artifact: GenerationArtifact): Promise<void> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return; // Silent fail if not logged in?

  // Artifact has `projectId`.
  await supabase.from('artifacts').insert({
    user_id: user.id,
    project_id: artifact.projectId,
    data: artifact, // Store the whole JSON object
    created_at: new Date().toISOString()
  });
};

export const loadArtifactsForProject = async (projectId: string): Promise<GenerationArtifact[]> => {
  const { data } = await supabase
    .from('artifacts')
    .select('data')
    .eq('project_id', projectId);

  return (data || []).map((row: any) => row.data);
};


// --- Legacy / Ephemeral Implementation (IndexedDB) ---

export const saveTestRun = async (run: TestLabRun): Promise<void> => {
  await runTransaction(TEST_RUNS_STORE, "readwrite", (store) => store.put(run));
};

export const loadTestRuns = async (limit = 200): Promise<TestLabRun[]> => {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(TEST_RUNS_STORE, "readonly");
    const store = tx.objectStore(TEST_RUNS_STORE);
    const index = store.index("createdAt");
    const results: TestLabRun[] = [];
    index.openCursor(null, "prev").onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor && results.length < limit) {
        results.push(cursor.value as TestLabRun);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    tx.onerror = () => resolve([]);
  });
};

export const clearTestRuns = async (): Promise<void> => {
  await runTransaction(TEST_RUNS_STORE, "readwrite", (store) => store.clear());
  await runTransaction(TEST_IMAGES_STORE, "readwrite", (store) => store.clear());
};

// ... Keeping Test Images local for now to save bandwidth ...
export const saveTestImage = async (dataUrl: string): Promise<string> => {
  const id = crypto.randomUUID();
  const { mimeType } = parseDataUrl(dataUrl);
  const record = { id, dataUrl, mimeType, createdAt: Date.now() };
  await runTransaction(TEST_IMAGES_STORE, "readwrite", (store) => store.put(record));
  return id;
};

export const getTestImageUrl = async (imageId: string): Promise<string | undefined> => {
  const record = await runTransaction<any>(TEST_IMAGES_STORE, "readonly", (store) => store.get(imageId));
  if (!record) return undefined;
  return URL.createObjectURL(dataUrlToBlob(record.dataUrl));
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


// Stats are harder now (part cloud, part local).
// Simplified for MVP:
export const getDbStats = async (): Promise<{
  projects: number;
  images: number; // This is hard to count on storage without list call
  artifacts: number;
  testRuns?: number;
  testImages?: number;
  storage?: { usage: number; quota: number };
}> => {
  // Local stats
  const testRuns = await runTransaction(TEST_RUNS_STORE, "readonly", s => s.count());

  // Remote stats (Optional, might be slow)
  const { count: projects } = await supabase.from('projects').select('*', { count: 'exact', head: true });
  const { count: artifacts } = await supabase.from('artifacts').select('*', { count: 'exact', head: true });

  return {
    projects: projects || 0,
    images: 0, // Placeholder
    artifacts: artifacts || 0,
    testRuns: testRuns || 0,
    testImages: 0,
    storage: { usage: 0, quota: 0 }
  };
};

export const clearImageCache = () => {
  // No-op for cloud URLs usually, or revoke if we used objectURLs for test images
};

// --- Migration Utils ---

export const migrateLegacyData = async (): Promise<{ projects: number; errors: number }> => {
  const LEGACY_DB_NAME = "dreamstream_db"; // The old name before we switched to SaaS
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Must be logged in to migrate.");

  let migratedCount = 0;
  let errorCount = 0;

  try {
    // Open Legacy DB
    const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (!legacyDb.objectStoreNames.contains("projects")) {
      console.warn("No projects store found in legacy DB.");
      return { projects: 0, errors: 0 };
    }

    // Read all projects
    const tx = legacyDb.transaction("projects", "readonly");
    const store = tx.objectStore("projects");
    const request = store.getAll();

    const projects = await new Promise<Project[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    console.log(`Found ${projects.length} legacy projects to migrate.`);

    // Upload to Supabase
    for (const p of projects) {
      try {
        await saveProject(p);
        migratedCount++;
      } catch (err) {
        console.error(`Failed to migrate project ${p.id}:`, err);
        errorCount++;
      }
    }

    // Try to migrate artifacts if they exist
    // (Assuming they were stored in 'artifacts' or we just rely on loading them later? 
    // Actually artifacts were likely in proper store or sub-collection. 
    // If we skip them, projects might verify empty. 
    // Let's check for 'artifacts' store.)
    if (legacyDb.objectStoreNames.contains("artifacts")) {
      const aTx = legacyDb.transaction("artifacts", "readonly");
      const aStore = aTx.objectStore("artifacts");
      const aRequest = aStore.getAll();
      const artifacts = await new Promise<GenerationArtifact[]>((resolve) => {
        aRequest.onsuccess = () => resolve(aRequest.result);
        aRequest.onerror = () => resolve([]);
      });

      for (const a of artifacts) {
        try {
          await saveArtifact(a);
        } catch {
          // ignore artifact dupes
        }
      }
    }

    legacyDb.close();

  } catch (e) {
    console.error("Migration failed:", e);
    throw e;
  }

  return { projects: migratedCount, errors: errorCount };
};

// Stub for exportProject (Needs rewrite for cloud)
export const exportProject = async (projectId: string): Promise<any> => {
  try {
    const { data: project, error } = await supabase.from('projects').select('*').eq('id', projectId).single();
    if (error || !project) throw new Error("Project not found");

    const artifacts = await loadArtifactsForProject(projectId);

    // For MVP, we don't download all images to blob yet, but we return structure so UI doesn't crash.
    return { project, images: {}, artifacts };
  } catch (e) {
    console.error("Export failed:", e);
    return { project: undefined, images: {}, artifacts: [] };
  }
};

// --- USER PROFILES ---

export const getUserProfile = async (userId: string): Promise<UserProfile | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) return null;
  return data as UserProfile;
};

export const updateUserProfile = async (userId: string, updates: Partial<UserProfile>) => {
  const { error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId);

  if (error) throw error;
};

export const updateUserAvatar = async (userId: string, avatarUrl: string) => {
  return updateUserProfile(userId, { avatar_url: avatarUrl });
};

// --- CONTACT FORM ---
// --- CONTACT FORM ---
export const savePublicContactMessage = async (email: string, message: string) => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { error } = await supabase.from('contact_messages').insert({
    user_id: user.id,
    email,
    message
  });

  if (error) {
    console.error("Failed to save contact message", error);
    return false;
  }
  return true;
};
// --- COMMUNITY FEATURES (Phase 11) ---

export const addComment = async (projectId: string, text: string): Promise<Comment | null> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // 1. Fetch Project to get Owner
  const { data: project } = await supabase.from('projects').select('user_id').eq('id', projectId).single();

  const { data, error } = await supabase
    .from('comments')
    .insert({ project_id: projectId, user_id: user.id, text })
    .select('*, user:user_id(username, avatar_url)') // Join with profile
    .single();

  if (error) {
    console.error("Failed to add comment:", error);
    return null;
  }

  // 2. Notify Project Owner
  if (project && project.user_id !== user.id) {
    await createNotification(project.user_id, user.id, 'comment', projectId);
  }

  return data as Comment; // Needs casting if join types are tricky
};

export const getComments = async (projectId: string, currentUserId?: string): Promise<Comment[]> => {
  const { data, error } = await supabase
    .from('comments')
    .select('*, user:profiles!user_id(username, avatar_url)') // Explicit join on profiles table via user_id
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error("Failed to load comments:", error);
    return [];
  }

  let validComments = data.map((c: any) => ({
    ...c,
    user: c.user // 'user' field comes from the join alias
  }));

  // Fetch likes for current user if provided
  if (currentUserId && validComments.length > 0) {
    const commentIds = validComments.map((c: any) => c.id);
    const { data: likes } = await supabase
      .from('comment_likes')
      .select('comment_id')
      .eq('user_id', currentUserId)
      .in('comment_id', commentIds);

    const likedSet = new Set(likes?.map((l: any) => l.comment_id));
    validComments = validComments.map((c: any) => ({
      ...c,
      isLiked: likedSet.has(c.id)
    }));
  }

  return validComments as Comment[];
};

export const deleteComment = async (commentId: string): Promise<boolean> => {
  const { error } = await supabase.from('comments').delete().eq('id', commentId);
  return !error;
};

export const followUser = async (targetUserId: string): Promise<boolean> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { error } = await supabase
    .from('follows')
    .insert({ follower_id: user.id, following_id: targetUserId });

  if (error) return false;

  await createNotification(targetUserId, user.id, 'follow');
  return true;
};

export const unfollowUser = async (targetUserId: string): Promise<boolean> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { error } = await supabase
    .from('follows')
    .delete()
    .eq('follower_id', user.id)
    .eq('following_id', targetUserId);

  return !error;
};

export const isFollowing = async (targetUserId: string): Promise<boolean> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { data, error } = await supabase
    .from('follows')
    .select('*')
    .eq('follower_id', user.id)
    .eq('following_id', targetUserId)
    .single();

  return !!data && !error;
};

export const getFollowersCount = async (userId: string): Promise<number> => {
  const { count, error } = await supabase
    .from('follows')
    .select('*', { count: 'exact', head: true })
    .eq('following_id', userId);

  return count || 0;
};
export const getProfileByUsername = async (username: string): Promise<UserProfile | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('username', username) // Case insensitive lookup
    .single();

  if (error) return null;
  return data as UserProfile;
};

export const getPublicProjectsByUser = async (userId: string): Promise<Project[]> => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .eq('is_public', true)
    .order('created_at', { ascending: false });

  if (error) return [];

  return data.map(row => ({
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    coverImage: row.cover_image_url,
    state: row.state,
    isPublic: row.is_public,
    userId: row.user_id, // Ensure Project type has userId if needed, or we just use it for display
    likes: row.likes || 0,
    views: row.views || 0
  } as any)); // Casting mainly because Project type might not strictly match DB row fields perfectly without mapping
};

// --- Notifications ---

export const getNotifications = async (userId: string): Promise<AppNotification[]> => {
  const { data, error } = await supabase
    .from('notifications')
    .select(`
      *,
      actor:actor_id (username, avatar_url)
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return [];
  return data as any;
};

export const markNotificationRead = async (notificationId: string) => {
  await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId);
};

export const createNotification = async (
  userId: string,
  actorId: string,
  type: 'follow' | 'comment' | 'like',
  entityId?: string
) => {
  if (userId === actorId) return; // Don't notify self
  await supabase.from('notifications').insert({
    user_id: userId,
    actor_id: actorId,
    type,
    entity_id: entityId
  });
};

// --- Comment Likes ---

export const likeComment = async (commentId: string, userId: string): Promise<boolean> => {
  const { error } = await supabase
    .from('comment_likes')
    .insert({ comment_id: commentId, user_id: userId });

  return !error;
};

export const unlikeComment = async (commentId: string, userId: string): Promise<boolean> => {
  const { error } = await supabase
    .from('comment_likes')
    .delete()
    .eq('comment_id', commentId)
    .eq('user_id', userId);

  return !error;
};

export const getCommentLikes = async (commentIds: string[], userId?: string): Promise<Record<string, { count: number, hasLiked: boolean }>> => {
  // This is a bit complex efficiently. For now, we might just load it client side or assume small scale.
  // Better: Fetch all likes for these comments.

  // 1. Get counts
  const { data: counts } = await supabase
    .from('comment_likes')
    .select('comment_id');
  // .in('comment_id', commentIds) -> fetching all for these comments to count? noisy.

  // Actually, let's just use the `comments` view or similar if we had one.
  // For MVP, simplistic approach: 
  return {}; // Placeholder if we do individual fetching
};
// --- REVIEWS ---

export const submitReview = async (review: Omit<Review, 'id' | 'userId' | 'createdAt' | 'user'>): Promise<boolean> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const { error } = await supabase.from('reviews').insert({
    project_id: review.projectId,
    user_id: user.id,
    rating: review.rating,
    scores: review.scores, // JSONB
    text: review.text
  });

  if (error) {
    console.error("Failed to submit review:", error);
    return false;
  }
  return true;
};

export const getReviews = async (projectId: string): Promise<Review[]> => {
  const { data, error } = await supabase
    .from('reviews')
    .select(`
      *,
      user:user_id (username, avatar_url)
    `)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error("Failed to load reviews:", error);
    return [];
  }

  return (data || []).map((r: any) => ({
    id: r.id,
    projectId: r.project_id,
    userId: r.user_id,
    rating: r.rating,
    scores: r.scores,
    text: r.text,
    createdAt: new Date(r.created_at).getTime(),
    user: r.user
  }));
};
