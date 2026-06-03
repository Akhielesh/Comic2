import { describe, it, expect } from 'vitest';
import { describeWeatherCode, aqiCategory, pollenLevel } from './weather.js';

describe('describeWeatherCode', () => {
  it('maps known WMO codes', () => {
    expect(describeWeatherCode(0)).toBe('Clear sky');
    expect(describeWeatherCode(95)).toBe('Thunderstorm');
  });
  it('falls back for unknown codes', () => {
    expect(describeWeatherCode(1234)).toBe('Unknown');
  });
});

describe('aqiCategory', () => {
  it('bands US AQI values per EPA breakpoints', () => {
    expect(aqiCategory(20)).toBe('Good');
    expect(aqiCategory(75)).toBe('Moderate');
    expect(aqiCategory(120)).toBe('Unhealthy (sensitive)');
    expect(aqiCategory(180)).toBe('Unhealthy');
    expect(aqiCategory(250)).toBe('Very unhealthy');
    expect(aqiCategory(400)).toBe('Hazardous');
  });
  it('returns undefined for missing input', () => {
    expect(aqiCategory(undefined)).toBeUndefined();
  });
});

describe('pollenLevel', () => {
  it('bands pollen concentrations', () => {
    expect(pollenLevel(0)).toBe('None');
    expect(pollenLevel(10)).toBe('Low');
    expect(pollenLevel(50)).toBe('Moderate');
    expect(pollenLevel(150)).toBe('High');
    expect(pollenLevel(500)).toBe('Very high');
  });
  it('returns undefined for missing input', () => {
    expect(pollenLevel(undefined)).toBeUndefined();
  });
});
