/* Lookup tables + helpers shared by the LandSandBoat ingest. */

// synth_recipes skill columns (in INSERT order) -> the app's craft display names.
// The order here matters: it mirrors the column order Wood..Cook.
export const CRAFT_COLUMNS = [
  'Woodworking', // Wood
  'Smithing', // Smith
  'Goldsmithing', // Gold
  'Clothcraft', // Cloth
  'Leathercraft', // Leather
  'Bonecraft', // Bone
  'Alchemy', // Alchemy
  'Cooking', // Cook
];

// Elemental crystal item ids -> element name. (Clusters 4238-4245 are HQ-tier,
// not needed for display.) Verified against samples (4098 = Wind = Woodworking).
export const CRYSTAL_ELEMENTS = {
  4096: 'Fire',
  4097: 'Ice',
  4098: 'Wind',
  4099: 'Earth',
  4100: 'Lightning',
  4101: 'Water',
  4102: 'Light',
  4103: 'Dark',
};

// Small words kept lowercase when humanizing names (unless first word).
const SMALL_WORDS = new Set([
  'of', 'the', 'a', 'an', 'and', 'or', 'in', 'on', 'with', 'to', 'for',
]);

/**
 * Turn a LandSandBoat snake_case item name into a display name.
 * e.g. "san_dorian_carpet" -> "San Dorian Carpet", "hi-potion" -> "Hi-Potion".
 */
export function humanizeName(snake) {
  if (!snake) return '';
  const words = String(snake).split('_');
  return words
    .map((word, idx) =>
      word
        .split('-')
        .map((part) => {
          if (idx > 0 && SMALL_WORDS.has(part)) return part;
          return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join('-')
    )
    .join(' ');
}
