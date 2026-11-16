import { samplePageUrl, SAMPLE_COVER_URL, type SampleLook } from './sampleArt';

/** Public, bundled editions: these are complete Studio samples, never private project records. */
export const NEW_SAMPLE_IDS = ['rain-for-a-rooftop', 'midnight-parcel', 'the-unclaimed-umbrella', 'hello-europa', 'a-small-giant'] as const;
export type SampleStory = (typeof NEW_SAMPLE_IDS)[number] | 'paper-boat' | 'last-tram';
export interface SamplePage {
  src: string;
  srcSet?: string;
  width: number;
  height: number;
  panels: number;
  description: string;
  transcript: readonly string[];
}
export interface SampleComic {
  id: SampleStory;
  title: string;
  style: string;
  synopsis: string;
  pages: readonly SamplePage[];
  cover?: string;
  featured?: boolean;
}
const ROOT = '/assets/comic-sample';
const page = (slug: string, n: number, width: number, height: number, panels: number, description: string, transcript: readonly string[]): SamplePage => ({
  src: `${ROOT}/${slug}-page-${n}-1200.webp`,
  srcSet: `${ROOT}/${slug}-page-${n}-480.webp 480w, ${ROOT}/${slug}-page-${n}-768.webp 768w, ${ROOT}/${slug}-page-${n}-1200.webp 1200w`,
  width, height, panels, description, transcript
});

export const SAMPLE_COMICS: readonly SampleComic[] = [
  { id: 'rain-for-a-rooftop', title: 'Rain for a Rooftop', style: 'Watercolor', synopsis: 'A rooftop gardener finds a little hope in the rain.', featured: true,
    pages: [page('rain-for-a-rooftop', 1, 1200, 1499, 4, 'A gardener catches rain in an old umbrella and revives a rooftop flower.', [
      'A gardener in a yellow raincoat finds a wilted rooftop plant.', 'They turn an old blue umbrella upside down to collect the rain.',
      'They tip the umbrella’s water into the same chipped flowerpot.', 'Later, sunshine lights a pink blossom while the gardener smiles.'
    ])] },
  { id: 'midnight-parcel', title: 'Midnight Parcel', style: 'Manga', synopsis: 'One courier, one cake, and a birthday worth the detour.', featured: true,
    pages: [page('midnight-parcel', 1, 1200, 1800, 6, 'A bicycle courier saves a birthday cake and delivers it to an elderly recipient.', [
      'A bicycle courier carries a cake through the city at night.', 'A cat darts across the bicycle’s path.', 'The courier swerves.',
      'The cake is caught before it falls.', 'The courier reaches the birthday recipient.', 'A small delivery becomes a warm birthday celebration.'
    ])] },
  { id: 'the-unclaimed-umbrella', title: 'The Unclaimed Umbrella', style: 'Noir ink', synopsis: 'A rainy alley. An abandoned umbrella. An unexpected case.', featured: true,
    pages: [page('the-unclaimed-umbrella', 1, 1200, 1600, 3, 'A detective discovers a kitten under an umbrella and brings it home.', [
      'A detective spots an abandoned umbrella in a rain-soaked alley.', 'Underneath it, a small kitten waits out the storm.',
      'At the detective’s warm home, the kitten sleeps in a familiar hat.'
    ])] },
  { id: 'hello-europa', title: 'Hello, Europa', style: 'Retro science fiction', synopsis: 'A distant signal leads to an unlikely companion.', featured: true,
    pages: [page('hello-europa', 1, 1200, 800, 5, 'An astronaut rescues a stranded rover, and they watch Jupiter rise together.', [
      'An astronaut follows a distress signal across Europa.', 'A little rover is trapped in the ice.', 'The astronaut pulls it free.',
      'A power cable brings the rover back to life.', 'Together, the astronaut and rover watch Jupiter rise.'
    ])] },
  { id: 'a-small-giant', title: 'A Small Giant', style: 'Cut-paper storybook', synopsis: 'A tiny mouse discovers how much a little kindness can carry.', featured: true,
    pages: [page('a-small-giant', 1, 1200, 1499, 4, 'A mouse and owl help a cold hedgehog find shelter beneath a scarf.', [
      'A tiny mouse finds a hedgehog shivering in the rain.', 'The mouse struggles to drag a fallen scarf toward its friend.',
      'An owl lends a wing to lift the scarf.', 'The three friends shelter together underneath it, each holding a little acorn teacup.'
    ])] },
  { id: 'last-tram', title: 'The Last Tram', style: 'Illustrated city story', synopsis: 'One last ride through a city after dark.',
    pages: [
      page('last-tram', 1, 1200, 960, 3, 'A traveler watches the moonlit harbor, then boards the last tram along the coast.', []),
      page('last-tram', 2, 1200, 1000, 3, 'The traveler steps off the tram, sets a paper boat afloat, and watches it drift across the moonlit harbor.', [])
    ] },
  { id: 'paper-boat', title: 'The Paper Boat', style: 'Six illustrated looks', synopsis: 'A small boat. A big adventure for Mira and Biscuit.', cover: SAMPLE_COVER_URL,
    pages: [
      { src: samplePageUrl('ligne-claire', 1), width: 1200, height: 1000, panels: 3, description: 'Mira and Biscuit spot a paper boat drifting down the canal at dusk.', transcript: [] },
      { src: samplePageUrl('ligne-claire', 2), width: 1200, height: 1000, panels: 3, description: 'They race along the canal to catch the paper boat before the rain.', transcript: [] }
    ] }
];
export const FEATURED_SAMPLES = SAMPLE_COMICS.filter(comic => comic.featured);
export const findSample = (id: unknown): SampleComic | undefined => typeof id === 'string' ? SAMPLE_COMICS.find(comic => comic.id === id) : undefined;
export const sampleLibraryHref = (id: SampleStory) => `/?view=gallery&sample=${encodeURIComponent(id)}`;
export function sampleArtwork(comic: SampleComic, index: number, look: SampleLook = 'ligne-claire'): SamplePage {
  const original = comic.pages[index];
  return comic.id === 'paper-boat' ? { ...original, src: samplePageUrl(look, index + 1) } : original;
}
