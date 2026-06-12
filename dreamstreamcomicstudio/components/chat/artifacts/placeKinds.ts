// Shared place-category mapping: one source of truth for the glyph (map pins) and
// the lucide icon (list rows) of a place category. The old UI showed a fork-and-knife
// for EVERYTHING — parks included — because the fallback was hardcoded.

import type { LucideIcon } from 'lucide-react';
import {
  BedDouble, Beer, Bus, Coffee, Landmark, MapPin, Plane, ShoppingBag, Ticket, Trees, UtensilsCrossed
} from 'lucide-react';

export type PlaceKind =
  | 'food' | 'cafe' | 'bar' | 'hotel' | 'park' | 'sight' | 'shop' | 'transit' | 'flight' | 'activity' | 'other';

/** Normalize a raw category string (OSM tag, stop kind, free text) to a PlaceKind. */
export const placeKind = (raw?: string): PlaceKind => {
  const c = (raw || '').toLowerCase();
  if (!c) return 'other';
  if (/restaurant|food|diner|eatery|pizz|burger|ramen|sushi|bbq|steak|taco|noodle|fast_food|food_court/.test(c)) return 'food';
  if (/cafe|coffee|bakery|dessert|ice_cream|tea/.test(c)) return 'cafe';
  if (/bar|pub|brewery|wine|cocktail|nightclub|biergarten/.test(c)) return 'bar';
  if (/hotel|hostel|lodging|guest_house|motel|apartment|resort|bnb/.test(c)) return 'hotel';
  if (/park|garden|green|playground|nature|forest|beach|lawn|trail|courts?$/.test(c)) return 'park';
  if (/museum|gallery|monument|memorial|landmark|temple|shrine|church|castle|cathedral|attraction|viewpoint|tower|bridge|historic/.test(c)) return 'sight';
  if (/shop|store|mall|market|boutique|supermarket|department/.test(c)) return 'shop';
  if (/station|subway|metro|train|bus|tram|ferry|transit|rail/.test(c)) return 'transit';
  if (/airport|flight|airline/.test(c)) return 'flight';
  if (/cinema|theatre|theater|stadium|arena|zoo|aquarium|amusement|activity|bowling|karaoke|spa/.test(c)) return 'activity';
  return 'other';
};

/** Lucide icon for list rows / chips. */
export const PLACE_KIND_ICONS: Record<PlaceKind, LucideIcon> = {
  food: UtensilsCrossed,
  cafe: Coffee,
  bar: Beer,
  hotel: BedDouble,
  park: Trees,
  sight: Landmark,
  shop: ShoppingBag,
  transit: Bus,
  flight: Plane,
  activity: Ticket,
  other: MapPin
};

/** Emoji glyph drawn inside the map pin (keeps the pin SVG dependency-free). */
export const PLACE_KIND_GLYPHS: Record<PlaceKind, string> = {
  food: '🍽️',
  cafe: '☕',
  bar: '🍸',
  hotel: '🛏️',
  park: '🌳',
  sight: '🏛️',
  shop: '🛍️',
  transit: '🚉',
  flight: '✈️',
  activity: '🎟️',
  other: ''
};

/** Human label for grouping shortlists ("Food", "Places to stay", …). */
export const PLACE_KIND_LABELS: Record<PlaceKind, string> = {
  food: 'Food',
  cafe: 'Cafés',
  bar: 'Bars',
  hotel: 'Places to stay',
  park: 'Parks & walks',
  sight: 'Sights',
  shop: 'Shopping',
  transit: 'Transit',
  flight: 'Flights',
  activity: 'Activities',
  other: 'Other'
};
