
import dotenv from 'dotenv';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

// Load env vars
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config(); // fallback

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseKey = supabaseServiceRoleKey || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing VITE_SUPABASE_URL or keys (Service/Anon)');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false }
});

async function main() {
    const searchTerm = 'Tarkan';

    console.log(`Searching for project with name like "%${searchTerm}%"...`);

    const { data: projects, error } = await supabase
        .from('projects')
        .select('*')
        .ilike('name', `%${searchTerm}%`);

    if (error) {
        console.error('Error fetching projects:', error);
        return;
    }

    if (!projects || projects.length === 0) {
        console.log('No projects found.');
        return;
    }

    console.log(`Found ${projects.length} project(s). Analyzing the first one...`);
    const project = projects[0];
    const state = project.state;

    if (!state) {
        console.log("Project has no state.");
        return;
    }

    const output = {
        id: project.id,
        name: project.name,
        created_at: project.created_at,
        metadata: {
            style_prompt: state.stylePrompt,
            style_category: state.styleCategory,
            resolution: state.imageResolution,
            aspect_ratio: state.styleAspectRatio,
        },
        generation_steps: [] as any[]
    };

    // 1. Script/Story Context
    if (state.script || state.scenes) {
        output.generation_steps.push({
            step: "Story/Script",
            input_context: {
                user_input_script: state.script
            },
            output_context: {
                scenes: state.scenes?.map((s: any) => ({
                    id: s.id,
                    synopsis: s.synopsis,
                    setting: s.setting,
                    characters: s.characters
                }))
            }
        });
    }

    // 2. Character Generation (if any)
    if (state.characters && state.characters.length > 0) {
        output.generation_steps.push({
            step: "Character Definitions",
            input_context: "Extracted from script",
            output_context: state.characters.map((c: any) => ({
                id: c.id,
                name: c.name,
                description: c.description,
                image_id: c.imageId,
                image_url: c.imageUrl
            }))
        });
    }

    // 3. Panel Generation (The core visual generation)
    if (state.panels && state.panels.length > 0) {
        // Sort panels by scene and index if possible, currently just list
        state.panels.forEach((p: any, idx: number) => {
            output.generation_steps.push({
                step: `Panel ${idx + 1} Generation`,
                panel_id: p.id,
                scene_id: p.sceneId,
                input_context: {
                    description: p.description,
                    dialogue: p.dialogue,
                    prompt_used: p.prompt, // This is the actual prompt sent to image model
                    negative_prompt: "default negative prompt", // Placeholder if not stored
                    reference_images: p.continuity?.referenceImageIds || [],
                    layout: state.layoutType
                },
                output_context: {
                    image_id: p.imageId,
                    image_url: p.imageUrl,
                    timestamp: p.generatedAt // if available
                },
                metadata: {
                    // We might need to fetch logs or artifacts for detailed token usage if not in panel
                    // For now, we infer from what's in the panel object
                }
            });
        });
    }

    // 4. Check for Generation Artifacts (Detailed logs)
    if (state.generationArtifacts && state.generationArtifacts.length > 0) {
        output.generation_steps.push({
            step: "Detailed Generation Logs (Artifacts)",
            artifacts: state.generationArtifacts.map((a: any) => ({
                type: a.type,
                stage: a.stage,
                model: a.model,
                prompt: a.prompt,
                tokens: a.usage,
                timings: a.timings,
                cost: a.cost
            }))
        });
    }

    console.log(JSON.stringify(output, null, 2));
}

main().catch(console.error);
