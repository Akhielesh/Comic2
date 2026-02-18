export type StoryTemplate = {
    id: string;
    label: string;
    genre: string;
    tone: string;
    setting: string;
    characters: string;
    conflict: string;
    ending: string;
    length: "short" | "medium" | "long";
};

export const STORY_TEMPLATES: StoryTemplate[] = [
    {
        id: "cyber-noir",
        label: "Cyberpunk Noir",
        genre: "Cyberpunk Noir",
        tone: "Gritty, cinematic, neon-soaked",
        setting: "Neon‑lit megacity, rain‑soaked alleys, towering corporate spires",
        characters: "A cyber-enhanced private eye, a rogue android informant, a corrupt corporate executive",
        conflict: "A missing memory core that exposes a conspiracy at the highest levels",
        ending: "Bittersweet, truth revealed but at a heavy personal cost",
        length: "medium"
    },
    {
        id: "fantasy-kingdom",
        label: "Fantasy Kingdom",
        genre: "Epic Fantasy",
        tone: "Heroic, wondrous, magical",
        setting: "Ancient kingdom on floating islands above a sea of clouds",
        characters: "A young mage discovering their power, a stoic knight guardian, an exiled queen",
        conflict: "A dormant storm titan threatens to consume the sky realm",
        ending: "Hopeful, the alliance is restored and the realm saved",
        length: "long"
    },
    {
        id: "sci-fi-space",
        label: "Space Opera",
        genre: "Sci-Fi Space Opera",
        tone: "Grand, adventurous, high-stakes",
        setting: "A bustling space station on the edge of a black hole",
        characters: "A charming smuggler, a diplomatic alien ambassador, a defecting soldier",
        conflict: "A race against time to stop a supernova weapon from firing",
        ending: "Triumphant, the crew escapes just as the weapon is dismantled",
        length: "long"
    },
    {
        id: "superhero-origin",
        label: "Superhero Origin",
        genre: "Superhero",
        tone: "Inspiring, action-packed, emotional",
        setting: "Modern metropolis dealing with a sudden wave of crime",
        characters: "A reluctant teenager with new powers, a veteran mentor, a vengeful villain",
        conflict: "Mastering control of powers while protecting the city from destruction",
        ending: "The hero accepts their destiny and stands guard over the city",
        length: "medium"
    },
    {
        id: "detective-noir",
        label: "Classic Detective",
        genre: "Period Mystery",
        tone: "Moody, suspenseful, 1940s style",
        setting: "Foggy London streets, gaslight lamps, smoky jazz clubs",
        characters: "A weary detective, a femme fatale, a wrongfully accused jazz musician",
        conflict: "A stolen diamond necklace that everyone is willing to kill for",
        ending: "The true culprit is caught in a clever trap",
        length: "medium"
    },
    {
        id: "post-apoc",
        label: "Post-Apocalyptic",
        genre: "Survival Thriller",
        tone: "Desolate, intense, raw",
        setting: "Overgrown ruins of a city reclaimed by nature",
        characters: "A lone survivor with a map, a wild child, a ruthless scavenger leader",
        conflict: "A journey to the 'Green Zone', the last rumored safe haven",
        ending: "They find the haven, but it's not what they expected—it's something new to build",
        length: "long"
    },
    {
        id: "horror-mystery",
        label: "Horror Mystery",
        genre: "Gothic Horror",
        tone: "Suspenseful, atmospheric, chilling",
        setting: "Abandoned Victorian mansion on a storm-swept cliff",
        characters: "A paranormal investigator, a skeptical journalist, a spectral presence",
        conflict: "Disappearances linked to a sealed room in the house",
        ending: "Twist revelation — the investigator has been part of the mystery all along",
        length: "medium"
    },
    {
        id: "rom-com",
        label: "Modern Romance",
        genre: "Romantic Comedy",
        tone: "Lighthearted, witty, sweet",
        setting: "A busy publishing house in New York City",
        characters: "An organized editor, a chaotic writer, a meddling boss",
        conflict: "They have to co-write a bestseller in 30 days without killing each other",
        ending: "They realize the perfect ending was falling in love",
        length: "short"
    },
    {
        id: "slice-life",
        label: "Café Slice of Life",
        genre: "Slice of Life",
        tone: "Warm, cozy, comedic",
        setting: "Small coffee shop in a quiet university town",
        characters: "A barista who listens too much, a regular customer with a secret, an aspiring musician",
        conflict: "A local music contest deadline that brings everyone together",
        ending: "Optimistic, supportive community celebration",
        length: "short"
    },
    {
        id: "historical-samurai",
        label: "Samurai Drama",
        genre: "Historical Fiction",
        tone: "Honorable, serene, violent intensity",
        setting: "Feudal Japan, a village during cherry blossom season",
        characters: "A wandering ronin, a village elder, a bandit warlord",
        conflict: "Defending the village from a raid against overwhelming odds",
        ending: "A peaceful duel at sunset resolves the conflict with honor",
        length: "medium"
    }
];
