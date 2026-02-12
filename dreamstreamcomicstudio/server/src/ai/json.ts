export const extractJson = (text: string): any => {
  try {
    const cleanMarkdown = text.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(cleanMarkdown);
  } catch {
    try {
      const arrayMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (arrayMatch) return JSON.parse(arrayMatch[0]);
      const objectMatch = text.match(/\{[\s\S]*\}/);
      if (objectMatch) return JSON.parse(objectMatch[0]);
      throw new Error('No JSON found in response');
    } catch (error) {
      console.error('Failed to extract JSON from:', text);
      throw error;
    }
  }
};

export const isString = (value: unknown): value is string => typeof value === 'string';
export const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

export const ensureArray = <T>(value: unknown, fallback: T[] = []): T[] => {
  return Array.isArray(value) ? (value as T[]) : fallback;
};
