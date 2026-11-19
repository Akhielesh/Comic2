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
  it('research in Comic Studio: only the short search words go to Wikipedia and Wikimedia Commons, not the pages', () => {
    const li = item('Research in Comic Studio:');
    expect(li).toHaveTextContent(/when you search, or when the Director looks up a known story, place or period for your comic/i);
    // What the code enforces: the query is 2-120 characters (routes/comic.ts research route, tools/research.ts) and
    // nothing else of the comic is sent. What it does not enforce (what those words are) is not promised.
    expect(li).toHaveTextContent(/only the short search words \(up to 120 characters\) go to Wikipedia and Wikimedia Commons, not your pages or script/i);
    expect(li).not.toHaveTextContent(/never your script|the public name/i);
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
      'Wikipedia'
    ]) {
      expect(li).toHaveTextContent(service);
    }
    // The list is not presented as complete when it is not.
    expect(li).toHaveTextContent(/other public data services/i);
  });

  it('approximate location in Chat: Cloudflare’s approximate city, never the IP address', () => {
    const li = item('Approximate location in Chat:');
    expect(li).toHaveTextContent(/when your browser does not share your location, we use the approximate city that our network provider, Cloudflare, attaches to each request/i);
    // The city sits in the assistant's context, which resolves "my area" and "local news" from it, so a news or web
    // search the assistant writes can carry it: the line says so instead of promising the country alone.
    expect(li).toHaveTextContent(/goes to the assistant and to the services that answer you, such as weather, maps and places, and news or web search when you ask about your area/i);
    expect(li).not.toHaveTextContent(/only the country/i);
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
