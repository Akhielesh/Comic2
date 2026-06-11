import { describe, it, expect } from 'vitest';
import { metnoSymbolToWmo, metnoIsDay, aggregateMetnoDaily } from './metno.js';
import { describeWeatherCode } from './weather.js';

describe('metnoSymbolToWmo', () => {
  it('maps core symbols to WMO codes', () => {
    expect(metnoSymbolToWmo('clearsky_day')).toBe(0);
    expect(metnoSymbolToWmo('fair_night')).toBe(1);
    expect(metnoSymbolToWmo('partlycloudy_day')).toBe(2);
    expect(metnoSymbolToWmo('cloudy')).toBe(3);
    expect(metnoSymbolToWmo('fog')).toBe(45);
    expect(metnoSymbolToWmo('lightrain')).toBe(61);
    expect(metnoSymbolToWmo('heavyrainshowers_day')).toBe(82);
    expect(metnoSymbolToWmo('snow')).toBe(73);
    expect(metnoSymbolToWmo('sleet')).toBe(66);
  });
  it('routes any thunder variant to thunderstorm', () => {
    expect(metnoSymbolToWmo('rainandthunder')).toBe(95);
    expect(metnoSymbolToWmo('heavysnowshowersandthunder_polartwilight')).toBe(95);
  });
  it('falls back by keyword for unknown compounds', () => {
    expect(metnoSymbolToWmo('weirdsnowthing')).toBe(73);
    expect(metnoSymbolToWmo('totallyunknown')).toBe(1);
  });
});

describe('metnoIsDay', () => {
  it('prefers the symbol suffix', () => {
    expect(metnoIsDay('clearsky_day', '2026-06-11T23:00:00Z', 0)).toBe(true);
    expect(metnoIsDay('clearsky_night', '2026-06-11T12:00:00Z', 0)).toBe(false);
  });
  it('estimates from longitude-local hour when no suffix', () => {
    expect(metnoIsDay('cloudy', '2026-06-11T12:00:00Z', 0)).toBe(true); // noon UTC at lon 0
    expect(metnoIsDay('cloudy', '2026-06-11T00:00:00Z', 0)).toBe(false); // midnight UTC at lon 0
  });
});

describe('aggregateMetnoDaily', () => {
  const entry = (time: string, temp: number, symbol?: string, precipProb?: number) => ({
    time,
    data: {
      instant: { details: { air_temperature: temp } },
      ...(symbol
        ? { next_6_hours: { summary: { symbol_code: symbol }, details: precipProb !== undefined ? { probability_of_precipitation: precipProb } : {} } }
        : {})
    }
  });

  it('groups by date with min/max temps and a midday symbol', () => {
    const days = aggregateMetnoDaily(
      [
        entry('2026-06-11T06:00:00Z', 10, 'clearsky_day'),
        entry('2026-06-11T12:00:00Z', 18, 'rain', 60),
        entry('2026-06-11T18:00:00Z', 14, 'cloudy', 20),
        entry('2026-06-12T12:00:00Z', 21, 'fair_day')
      ],
      describeWeatherCode
    );
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ date: '2026-06-11', minC: 10, maxC: 18, code: 63, description: 'Rain', precipProb: 60 });
    expect(days[1]).toMatchObject({ date: '2026-06-12', minC: 21, maxC: 21, code: 1 });
  });

  it('skips dates without temperatures and caps at 7 days', () => {
    const series = Array.from({ length: 10 }, (_, i) =>
      entry(`2026-06-${String(11 + i).padStart(2, '0')}T12:00:00Z`, 15 + i, 'cloudy')
    );
    expect(aggregateMetnoDaily(series, describeWeatherCode)).toHaveLength(7);
    expect(aggregateMetnoDaily([{ time: '2026-06-11T12:00:00Z', data: {} }], describeWeatherCode)).toHaveLength(0);
  });
});
