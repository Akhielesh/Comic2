
// Simple AES-GCM encryption using Web Crypto API
// We use a fixed salt/password for this MVP to derive a key, 
// In a real prod app, you might want a per-user salt or rely on a server-side secret.
// For this "Client-Encrypt-to-DB" model, we'll use a hardcoded app secret mixed with user ID if possible, 
// or just a static secret for simplicity in this MVP iteration.

const APP_SECRET = 'dreamstream-comic-studio-secret-key-v1';

async function getKey() {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(APP_SECRET),
        { name: "PBKDF2" },
        false,
        ["deriveBits", "deriveKey"]
    );

    return window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: enc.encode("dreamstream-salt"),
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

export const encryptKey = async (plainText: string): Promise<{ encrypted: string; iv: string }> => {
    const key = await getKey();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();

    const encrypted = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        enc.encode(plainText)
    );

    const encryptedArray = Array.from(new Uint8Array(encrypted));
    const ivArray = Array.from(iv);

    return {
        encrypted: btoa(String.fromCharCode.apply(null, encryptedArray)),
        iv: btoa(String.fromCharCode.apply(null, ivArray))
    };
};

export const decryptKey = async (encryptedBase64: string, ivBase64: string): Promise<string> => {
    const key = await getKey();
    const iv = Uint8Array.from(atob(ivBase64), c => c.charCodeAt(0));
    const encrypted = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

    try {
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            key,
            encrypted
        );

        const dec = new TextDecoder();
        return dec.decode(decrypted);
    } catch (e) {
        console.error("Decryption failed", e);
        return "";
    }
};
