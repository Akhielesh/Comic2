// Test fixtures for server/src/ai/tools/wikipedia.ts: Wikidata and Wikipedia API replies in the
// shapes those APIs answer with, trimmed to the fields the helpers read. Public reference facts
// (countries, a folk tale); no person's data. Used only by tests: nothing here goes on the network.

type Rank = 'preferred' | 'normal' | 'deprecated';
type Snak = { snaktype: 'value'; property?: string; datavalue: { type: string; value: unknown } };
export interface FixtureStatement {
  mainsnak: Snak;
  rank: Rank;
  qualifiers?: Record<string, Snak[]>;
}

const timeSnak = (year: number): Snak => ({
  snaktype: 'value',
  datavalue: { type: 'time', value: { time: `+${year}-01-01T00:00:00Z`, precision: 9 } }
});

/** Qualifier: point in time (P585). */
export const pointInTime = (year: number): Record<string, Snak[]> => ({ P585: [timeSnak(year)] });
/** Qualifier: end time (P582): the statement is no longer current. */
export const endedIn = (year: number): Record<string, Snak[]> => ({ P582: [timeSnak(year)] });

export const itemStatement = (id: string, rank: Rank = 'normal', qualifiers?: Record<string, Snak[]>): FixtureStatement => ({
  mainsnak: { snaktype: 'value', datavalue: { type: 'wikibase-entityid', value: { 'entity-type': 'item', id } } },
  rank,
  ...(qualifiers ? { qualifiers } : {})
});

export const quantityStatement = (
  amount: string,
  unit: string,
  rank: Rank = 'normal',
  qualifiers?: Record<string, Snak[]>
): FixtureStatement => ({
  mainsnak: { snaktype: 'value', datavalue: { type: 'quantity', value: { amount, unit } } },
  rank,
  ...(qualifiers ? { qualifiers } : {})
});

export const stringStatement = (value: string, rank: Rank = 'normal'): FixtureStatement => ({
  mainsnak: { snaktype: 'value', datavalue: { type: 'string', value } },
  rank
});

/** Wikidata units are entity URIs (data values, never requested). */
export const KM2 = 'http://www.wikidata.org/entity/Q712226';
export const SQ_MILE = 'http://www.wikidata.org/entity/Q232291';

export const entity = (id: string, label: string, claims: Record<string, FixtureStatement[]> = {}) => ({
  type: 'item',
  id,
  labels: { en: { language: 'en', value: label } },
  claims
});

/** France as Wikidata models it, trimmed: rank, end time and units are what the parser must respect. */
export const FRANCE = entity('Q142', 'France', {
  P31: [itemStatement('Q3624078'), itemStatement('Q6256')],
  // A deprecated capital and a former one: neither is current.
  P36: [itemStatement('Q90'), itemStatement('Q1000001', 'deprecated'), itemStatement('Q1000002', 'normal', endedIn(1871))],
  P1082: [
    quantityStatement('+66000000', '1', 'normal', pointInTime(2015)),
    quantityStatement('+68000000', '1', 'preferred', pointInTime(2024)),
    quantityStatement('+69000000', '1', 'normal', pointInTime(2025))
  ],
  // The euro now; the franc ended in 2002.
  P38: [itemStatement('Q4916'), itemStatement('Q181429', 'normal', endedIn(2002))],
  P37: [itemStatement('Q150')],
  P2046: [quantityStatement('+248573', SQ_MILE), quantityStatement('+643801', KM2)],
  P30: [itemStatement('Q46')],
  P297: [stringStatement('FR')]
});

export const FRANCE_LABELS = {
  entities: {
    Q90: entity('Q90', 'Paris'),
    Q4916: entity('Q4916', 'euro'),
    Q150: entity('Q150', 'French'),
    Q46: entity('Q46', 'Europe')
  }
};

export const GERMANY = entity('Q183', 'Germany', {
  P31: [itemStatement('Q6256'), itemStatement('Q43702')],
  P36: [itemStatement('Q64')],
  P1082: [quantityStatement('+83000000', '1', 'normal', pointInTime(2023)), quantityStatement('+84000000', '1', 'normal', pointInTime(2024))],
  P38: [itemStatement('Q4916')],
  P37: [itemStatement('Q188')],
  P2046: [quantityStatement('+357588', KM2)],
  P30: [itemStatement('Q46')],
  P297: [stringStatement('DE')]
});

export const GERMANY_LABELS = {
  entities: { Q64: entity('Q64', 'Berlin'), Q4916: entity('Q4916', 'euro'), Q188: entity('Q188', 'German'), Q46: entity('Q46', 'Europe') }
};

/** A city: found by title, but not a country. */
export const PARIS = entity('Q90', 'Paris', { P31: [itemStatement('Q515')], P17: [itemStatement('Q142')] });

/** A disambiguation page that shares its title with a country. */
export const GEORGIA_DISAMBIGUATION = entity('Q2000001', 'Georgia', { P31: [itemStatement('Q4167410')] });
export const GEORGIA = entity('Q230', 'Georgia', {
  P31: [itemStatement('Q3624078')],
  P36: [itemStatement('Q994')],
  P297: [stringStatement('GE')]
});
export const GEORGIA_LABELS = { entities: { Q994: entity('Q994', 'Tbilisi') } };

/** A former state: its only country class has ended. */
export const FORMER_STATE = entity('Q2000002', 'Old Realm', { P31: [itemStatement('Q3624078', 'normal', endedIn(1806))] });

export const entitiesReply = (...items: Array<{ id: string }>) => ({ entities: Object.fromEntries(items.map((e) => [e.id, e])) });
export const MISSING_REPLY = { entities: { '-1': { site: 'enwiki', title: 'Atlantis', missing: '' } } };
export const searchReply = (...ids: string[]) => ({ batchcomplete: '', query: { searchinfo: { totalhits: ids.length }, search: ids.map((title) => ({ ns: 0, title })) } });

/** What REST Countries v3.1 answers since its keyless API was retired: an object, not a list. */
export const RETIRED_API_REPLY = { success: false, message: 'This version of the API is deprecated.' };

// --- Wikipedia ------------------------------------------------------------------------------

export const SEARCH_REPLY = {
  pages: [
    {
      id: 1001,
      key: 'Harbor_Lights_(folk_tale)',
      title: 'Harbor Lights (folk tale)',
      excerpt: 'A <span class="searchmatch">harbor</span> tale about lantern keepers',
      description: 'Coastal folk tale'
    },
    { id: 1002, key: '', title: 'No key' },
    { id: 1003, key: 'Lantern_keeper', title: 'Lantern keeper', description: null }
  ]
};

export const SUMMARY_REPLY = {
  title: 'Harbor Lights (folk tale)',
  description: 'Coastal folk tale',
  extract: 'Harbor Lights is a coastal folk tale in which two lantern keepers guide boats home through a storm.',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Harbor_Lights_(folk_tale)' } },
  thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Harbor.jpg/320px-Harbor.jpg' }
};

export const LANGLINKS_REPLY = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 1001,
        ns: 0,
        title: 'Harbor Lights (folk tale)',
        langlinks: [{ lang: 'te', title: 'హార్బర్ లైట్స్ కథ' }]
      }
    ]
  }
};
