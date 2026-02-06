import { GoogleGenAI } from '@google/genai';

export const createClient = (apiKey: string) => {
  if (!apiKey) {
    throw new Error('Gemini API key not found.');
  }
  return new GoogleGenAI({ apiKey });
};
