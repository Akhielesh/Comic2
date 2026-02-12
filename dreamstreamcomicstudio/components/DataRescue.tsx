import React, { useState, useEffect } from 'react';
import { Project } from '../types';
import { saveProject } from '../services/db';
import { Loader2, Database, AlertTriangle, CheckCircle } from 'lucide-react';

export const DataRescue: React.FC = () => {
    const [localCount, setLocalCount] = useState<number>(0);
    const [legacyDbCount, setLegacyDbCount] = useState<number>(0);
    const [migrating, setMigrating] = useState(false);
    const [result, setResult] = useState<string | null>(null);

    useEffect(() => {
        checkLocalData();
    }, []);

    const checkLocalData = async () => {
        // 1. Check LocalStorage
        const ls = localStorage.getItem('dreamstream_projects');
        if (ls) {
            try {
                const parsed = JSON.parse(ls);
                if (Array.isArray(parsed)) setLocalCount(parsed.length);
            } catch (e) {
                console.error("LS Parse Error", e);
            }
        }

        // 2. Check Legacy IndexedDB
        try {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open('dreamstream_db');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                req.onupgradeneeded = () => reject("DB not found"); // If upgrade needed, it didn't exist
            });

            if (db.objectStoreNames.contains('projects')) {
                const tx = db.transaction('projects', 'readonly');
                const store = tx.objectStore('projects');
                const countReq = store.count();
                countReq.onsuccess = () => setLegacyDbCount(countReq.result);
            }
            db.close();
        } catch (e) {
            // Ignore if not found
        }
    };

    const performMigration = async () => {
        setMigrating(true);
        setResult(null);
        let count = 0;
        let errors = 0;

        try {
            // Migrate LocalStorage
            const ls = localStorage.getItem('dreamstream_projects');
            if (ls) {
                const projects = JSON.parse(ls) as Project[];
                for (const p of projects) {
                    try {
                        await saveProject(p);
                        count++;
                    } catch (e) {
                        console.error("Failed to save LS project", p.id, e);
                        errors++;
                    }
                }
            }

            // Migrate IndexedDB
            if (legacyDbCount > 0) {
                const db = await new Promise<IDBDatabase>((resolve, reject) => {
                    const req = indexedDB.open('dreamstream_db');
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                if (db.objectStoreNames.contains('projects')) {
                    const tx = db.transaction('projects', 'readonly');
                    const projects = await new Promise<Project[]>((resolve) => {
                        tx.objectStore('projects').getAll().onsuccess = (e) => resolve((e.target as any).result);
                    });
                    for (const p of projects) {
                        try {
                            await saveProject(p);
                            count++;
                        } catch (e) {
                            console.error("Failed to save IDB project", p.id, e);
                            errors++;
                        }
                    }
                }
            }

            setResult(`Recovered ${count} projects. ${errors > 0 ? `${errors} failed.` : ''} Please reload.`);
        } catch (e: any) {
            setResult(`Error: ${e.message}`);
        } finally {
            setMigrating(false);
        }
    };

    if (localCount === 0 && legacyDbCount === 0) return null;

    return (
        <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-md my-4">
            <div className="flex items-center gap-3">
                <Database className="text-amber-600" />
                <div>
                    <h3 className="font-bold text-amber-800">Local Data Detected</h3>
                    <p className="text-sm text-amber-700">
                        Found {localCount + legacyDbCount} projects on this device that might not be synced.
                    </p>
                </div>
                <button
                    onClick={performMigration}
                    disabled={migrating}
                    className="ml-auto bg-amber-600 text-white px-4 py-2 rounded-lg hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2"
                >
                    {migrating ? <Loader2 className="animate-spin w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                    {migrating ? 'Syncing...' : 'Rescue Data'}
                </button>
            </div>
            {result && (
                <div className="mt-2 text-sm font-medium flex items-center gap-2 text-green-700">
                    <CheckCircle className="w-4 h-4" />
                    {result}
                </div>
            )}
        </div>
    );
};
