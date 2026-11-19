import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PrivacyPolicy } from './PrivacyPolicy';

// The privacy page names every place research words, Chat questions and the approximate location go, in the same
// list as the other third parties (section 3), on the day the features ship.
const item = (label: string) => {
  render(<PrivacyPolicy />);
  const li = screen.getByText(label).closest('li');
  expect(li).not.toBeNull();
  return li as HTMLElement;
};

describe('privacy policy: research and live data services', () => {
  it('research in Comic Studio: the public search words go to Wikipedia and Wikimedia Commons, never the script', () => {
    const li = item('Research in Comic Studio:');
    expect(li).toHaveTextContent(/when you search, or when the Director looks up a known story, place or period for your comic/i);
    expect(li).toHaveTextContent(/the search words \(the public name, never your script\) go to Wikipedia and Wikimedia Commons/i);
    expect(li).toHaveTextContent(/picture previews .* load from Wikimedia/i);
  });

  it('live data in Chat: the question, and for local answers the approximate city, go to the service that answers', () => {
    const li = item('Live data in Chat:');
    expect(li).toHaveTextContent(/your question, and for local answers your approximate city, go to the data service that answers it/i);
    for (const service of [
      'MET Norway',
      'Open-Meteo',
      'OpenStreetMap',
      'Foursquare',
      'Yahoo Finance',
      'Stooq',
      'Alpaca',
      'CoinGecko',
      'Google News',
      'Amadeus',
      'aviationstack',
      'Wikipedia',
      'Wikidata'
    ]) {
      expect(li).toHaveTextContent(service);
    }
    // The list is not presented as complete when it is not.
    expect(li).toHaveTextContent(/other public data services/i);
  });

  it('approximate location in Chat: Cloudflare’s approximate city, never the IP address', () => {
    const li = item('Approximate location in Chat:');
    expect(li).toHaveTextContent(/when your browser does not share your location, we use the approximate city that our network provider, Cloudflare, attaches to each request/i);
    expect(li).toHaveTextContent(/goes to the assistant and to the weather, maps and places services that answer you/i);
    expect(li).toHaveTextContent(/your IP address is not sent to them/i);
  });

  it('the three lines sit in the third-party list of section 3', () => {
    render(<PrivacyPolicy />);
    const list = screen.getByText('Supabase:').closest('ul') as HTMLElement;
    for (const label of ['Research in Comic Studio:', 'Live data in Chat:', 'Approximate location in Chat:']) {
      expect(within(list).getByText(label)).toBeInTheDocument();
    }
  });
});
