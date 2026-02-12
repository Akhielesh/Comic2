export type TestTemplate = {
  id: string;
  label: string;
  script: string;
  stylePrompt: string;
  synopsis: string;
  setting: string;
  characters: string;
  items: string;
  location: string;
  coverPrompt: string;
};

export const TEST_TEMPLATES: TestTemplate[] = [
  {
    id: "cyber-noir",
    label: "Cyberpunk Noir",
    script: `Scene 1: A neon city in the rain. DETECTIVE K stands on a rooftop scanning a hologram.
Scene 2: Inside a smoky noodle bar. VIVIAN slides a datapad across the counter.
VIVIAN: "You're looking for the ghost in the machine, aren't you?"
K: "I'm just looking for dinner."`,
    stylePrompt: "cyberpunk noir, high contrast, neon haze, cinematic lighting",
    synopsis: "A detective follows a digital ghost through a neon city.",
    setting: "Neon megacity, rainy night",
    characters: "Detective K (cyborg), Vivian (mysterious informant)",
    items: "Datapad, holographic billboard",
    location: "Rooftop and noodle bar",
    coverPrompt: "A lone detective under neon rain, holographic billboards towering"
  },
  {
    id: "fantasy-kingdom",
    label: "Fantasy Kingdom",
    script: `Scene 1: A floating castle above a storm. A young mage clutches a glowing relic.
Scene 2: The knight guardian blocks a bridge as lightning cracks.
MAGE: "If we fail, the sky will fall."
KNIGHT: "Then we hold the line."`,
    stylePrompt: "epic fantasy illustration, ornate armor, dramatic clouds, painterly",
    synopsis: "A mage and knight defend a floating kingdom from a storm titan.",
    setting: "Floating islands above a storm",
    characters: "Young mage, knight guardian",
    items: "Glowing relic, storm-forged bridge",
    location: "Castle bridge",
    coverPrompt: "Heroic mage and knight on a bridge above a storm"
  },
  {
    id: "slice-life",
    label: "Slice of Life",
    script: `Scene 1: Morning at a quiet cafe. MIA wipes down a table.
Scene 2: JAY arrives with a guitar case.
JAY: "Got time for a song?"
MIA: "Only if you buy a latte."`,
    stylePrompt: "soft pastel, cozy cafe, warm lighting, slice of life",
    synopsis: "Two friends prepare for a music contest in a small cafe.",
    setting: "Cozy small-town cafe",
    characters: "Mia (barista), Jay (musician)",
    items: "Guitar case, latte art",
    location: "Cafe counter",
    coverPrompt: "Warm cafe interior with two friends laughing"
  },
  {
    id: "space-opera",
    label: "Space Opera",
    script: `Scene 1: A battleship drifts near a shattered moon.
Scene 2: CAPTAIN RAE addresses the crew.
RAE: "We jump now, or we never go home."
CREW: "For the fleet!"`,
    stylePrompt: "space opera, cinematic sci-fi, massive ships, luminous nebula",
    synopsis: "A captain leads a desperate jump through enemy space.",
    setting: "Orbit of a shattered moon",
    characters: "Captain Rae, crew",
    items: "Starship console, jump drive",
    location: "Bridge of a battleship",
    coverPrompt: "Starship silhouetted against a glowing nebula"
  },
  {
    id: "western",
    label: "Western Duel",
    script: `Scene 1: Dusty main street at noon. Two rivals face off.
Scene 2: A tumbleweed passes as the sheriff watches.
RIVAL: "This ends today."
SHERIFF: "Make it quick."`,
    stylePrompt: "classic western, high noon lighting, cinematic dust",
    synopsis: "A duel in a frontier town decides the sheriff's fate.",
    setting: "Old frontier town",
    characters: "Sheriff, rival gunslinger",
    items: "Revolver, badge",
    location: "Main street",
    coverPrompt: "Two gunslingers under the blazing sun"
  },
  {
    id: "mystery",
    label: "Coastal Mystery",
    script: `Scene 1: A lighthouse blinks over stormy seas.
Scene 2: ELLA finds a hidden journal in the keeper's quarters.
ELLA: "Someone was here last night."
KEEPER: "No one comes to this rock."`,
    stylePrompt: "moody coastal mystery, fog, lantern light, painterly",
    synopsis: "A journalist uncovers secrets in a lonely lighthouse.",
    setting: "Foggy coastline at night",
    characters: "Ella (journalist), lighthouse keeper",
    items: "Old journal, lantern",
    location: "Lighthouse quarters",
    coverPrompt: "Lighthouse beam cutting through fog with a lone figure"
  }
];
