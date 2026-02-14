import { supabase } from "./supabase";
import { Character, CharacterLibraryItem } from "../types";

export const saveCharacterToLibrary = async (character: Character): Promise<CharacterLibraryItem> => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("User not logged in");

    const libraryItem = {
        user_id: user.id,
        name: character.name,
        description: character.description,
        bio: character.bio,
        image_url: character.imageUrl,
        reference_image_ids: character.referenceImageIds || [],
        created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
        .from('character_library')
        .insert(libraryItem)
        .select()
        .single();

    if (error) {
        console.error("Failed to save character to library:", error);
        throw error;
    }

    return mapLibraryItem(data);
};

export const getLibraryCharacters = async (): Promise<CharacterLibraryItem[]> => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];

    const { data, error } = await supabase
        .from('character_library')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

    if (error) {
        // Gracefully handle missing table by returning empty array (dev mode fallback)
        if (error.code === '42P01') { // undefined_table
            console.warn("Character Library table missing. Please run migration.");
            return [];
        }
        console.error("Failed to fetch library characters:", error);
        throw error;
    }

    return (data || []).map(mapLibraryItem);
};

export const deleteCharacterFromLibrary = async (id: string): Promise<void> => {
    const { error } = await supabase
        .from('character_library')
        .delete()
        .eq('id', id);

    if (error) throw error;
};

const mapLibraryItem = (row: any): CharacterLibraryItem => ({
    id: row.id,
    name: row.name,
    description: row.description,
    bio: row.bio,
    imageUrl: row.image_url,
    imageId: undefined, // Library items don't track ephemeral imageId
    referenceImageIds: row.reference_image_ids || [],
    userId: row.user_id,
    createdAt: row.created_at
});
