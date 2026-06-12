import { describe, it, expect } from 'vitest';
import { recipeToDocument, cocktailToDocument, pokemonToMetrics, tvShowToDocument, animeToDocument } from './culture.js';

describe('recipeToDocument', () => {
  const meal = {
    strMeal: 'Spaghetti Carbonara',
    strArea: 'Italian',
    strCategory: 'Pasta',
    strMealThumb: 'https://www.themealdb.com/images/media/meals/carbonara.jpg',
    strInstructions: 'Boil the pasta.\r\nFry the guanciale.\r\nCombine with eggs and cheese.',
    strIngredient1: 'Spaghetti',
    strMeasure1: '400g',
    strIngredient2: 'Guanciale',
    strMeasure2: '150g',
    strIngredient3: '',
    strMeasure3: ''
  };

  it('renders photo, ingredients and steps as a markdown document', () => {
    const doc = recipeToDocument(meal);
    expect(doc.title).toBe('Spaghetti Carbonara');
    expect(doc.subtitle).toBe('Italian · Pasta');
    expect(doc.content).toContain('![Spaghetti Carbonara](https://www.themealdb.com/images/media/meals/carbonara.jpg)');
    expect(doc.content).toContain('## Ingredients');
    expect(doc.content).toContain('- 400g Spaghetti');
    expect(doc.content).toContain('- 150g Guanciale');
    expect(doc.content).toContain('## Instructions');
    expect(doc.content).toContain('Fry the guanciale.');
    expect(doc.content).not.toContain('\r\n'); // CRLF normalized
    expect(doc.filename).toBe('recipe-spaghetti-carbonara');
  });
});

describe('cocktailToDocument', () => {
  it('renders the drink with glass/alcoholic subtitle and ingredient measures', () => {
    const doc = cocktailToDocument({
      strDrink: 'Negroni',
      strAlcoholic: 'Alcoholic',
      strGlass: 'Old-fashioned glass',
      strDrinkThumb: 'https://www.thecocktaildb.com/images/media/drink/negroni.jpg',
      strInstructions: 'Stir into glass over ice, garnish and serve.',
      strIngredient1: 'Gin',
      strMeasure1: '1 oz',
      strIngredient2: 'Campari',
      strMeasure2: '1 oz'
    });
    expect(doc.title).toBe('Negroni');
    expect(doc.subtitle).toBe('Alcoholic — served in a Old-fashioned glass');
    expect(doc.content).toContain('- 1 oz Gin');
    expect(doc.content).toContain('Stir into glass over ice');
    expect(doc.filename).toBe('cocktail-negroni');
  });
});

describe('pokemonToMetrics', () => {
  const pikachu = {
    name: 'pikachu',
    id: 25,
    height: 4,
    weight: 60,
    types: [{ type: { name: 'electric' } }],
    stats: [
      { base_stat: 35, stat: { name: 'hp' } },
      { base_stat: 55, stat: { name: 'attack' } },
      { base_stat: 90, stat: { name: 'speed' } },
      { base_stat: 50, stat: { name: 'special-attack' } }
    ]
  };

  it('renders base stats as progress tiles plus type/height/weight', () => {
    const board = pokemonToMetrics(pikachu);
    expect(board.title).toBe('#25 Pikachu');
    const byLabel = Object.fromEntries(board.tiles.map((t) => [t.label, t]));
    expect(byLabel['HP']).toMatchObject({ value: 35, progress: { value: 35, max: 255 } });
    expect(byLabel['Sp. Atk'].value).toBe(50);
    expect(byLabel['Speed'].progress).toEqual({ value: 90, max: 255 });
    expect(byLabel['Type'].value).toBe('electric');
    expect(byLabel['Height']).toMatchObject({ value: 0.4, unit: 'm' });
    expect(byLabel['Weight']).toMatchObject({ value: 6, unit: 'kg' });
  });
});

describe('tvShowToDocument', () => {
  it('renders poster, fact list and a stripped-HTML summary', () => {
    const doc = tvShowToDocument({
      name: 'Severance',
      genres: ['Drama', 'Science-Fiction', 'Thriller'],
      premiered: '2022-02-18',
      status: 'Running',
      rating: { average: 8.5 },
      network: undefined,
      webChannel: { name: 'Apple TV+' },
      summary: '<p>Mark leads a team whose memories have been <b>surgically divided</b> between work and personal lives.</p>',
      officialSite: 'https://tv.apple.com/show/severance',
      image: { original: 'https://static.tvmaze.com/severance.jpg' }
    });
    expect(doc.title).toBe('Severance (2022)');
    expect(doc.subtitle).toBe('Drama · Science-Fiction · Thriller');
    expect(doc.content).toContain('![Severance](https://static.tvmaze.com/severance.jpg)');
    expect(doc.content).toContain('- **Network:** Apple TV+');
    expect(doc.content).toContain('- **Rating:** 8.5/10');
    expect(doc.content).toContain('surgically divided');
    expect(doc.content).not.toContain('<p>');
    expect(doc.content).toContain('[More on the official site](https://tv.apple.com/show/severance)');
  });
});

describe('animeToDocument', () => {
  it('prefers the English title and renders facts + synopsis', () => {
    const doc = animeToDocument({
      title: 'Shingeki no Kyojin',
      title_english: 'Attack on Titan',
      score: 8.56,
      episodes: 25,
      year: 2013,
      status: 'Finished Airing',
      synopsis: 'Centuries ago, mankind was slaughtered to near extinction by monstrous humanoid creatures called Titans.',
      url: 'https://myanimelist.net/anime/16498',
      images: { jpg: { image_url: 'https://cdn.myanimelist.net/images/anime/aot.jpg' } },
      genres: [{ name: 'Action' }, { name: 'Drama' }]
    });
    expect(doc.title).toBe('Attack on Titan (2013)');
    expect(doc.subtitle).toBe('Action · Drama');
    expect(doc.content).toContain('![Attack on Titan](https://cdn.myanimelist.net/images/anime/aot.jpg)');
    expect(doc.content).toContain('- **Score:** 8.56/10');
    expect(doc.content).toContain('- **Episodes:** 25');
    expect(doc.content).toContain('monstrous humanoid creatures');
    expect(doc.content).toContain('[More on MyAnimeList](https://myanimelist.net/anime/16498)');
  });
});
